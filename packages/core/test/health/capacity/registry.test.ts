// covers: ["ADP-020"]
import { describe, expect, it } from "vitest"

import { CapacityRegistry } from "../../../src/health/index.js"
import {
  DEFAULT_CAPACITY_CONFIG,
  type CapacityReading,
  type CapacitySensor,
} from "../../../src/health/capacity/types.js"
import type { ResourceKey } from "../../../src/health/resource-health/types.js"

const NOW = 200_000

function fakeClock() {
  const state = { now: NOW }
  return {
    now: () => state.now,
    advance: (delta: number) => {
      state.now += delta
    },
  }
}

const PROVIDER_KEY: ResourceKey = { providerID: "p" }
const MODEL_KEY: ResourceKey = { providerID: "p", modelID: "m" }
const OTHER_PROVIDER_KEY: ResourceKey = { providerID: "q", modelID: "m" }

it("snapshots registered sensors before and after their first observation", async () => {
  const registry = new CapacityRegistry(() => NOW)
  const { sensor } = controlledSensor("snapshot", MODEL_KEY)
  registry.register(sensor)
  expect(registry.snapshot()).toEqual([{ resource: MODEL_KEY, latest: null }])
  await registry.refresh()
  expect(registry.snapshot()).toEqual([{ resource: MODEL_KEY, latest: null }])
})

function controlledSensor(id: string, resource: ResourceKey) {
  const state: { reading: CapacityReading | null; calls: number; throwNext: boolean } = {
    reading: null,
    calls: 0,
    throwNext: false,
  }
  const sensor: CapacitySensor = {
    id,
    resource,
    read: () => {
      state.calls += 1
      if (state.throwNext) {
        return Promise.reject(new Error("sensor exploded"))
      }
      return Promise.resolve(state.reading)
    },
  }
  return { sensor, state }
}

function deferredSensor(id: string, resource: ResourceKey) {
  const state = { calls: 0, defer: true }
  let release: ((reading: CapacityReading | null) => void) | undefined
  const sensor: CapacitySensor = {
    id,
    resource,
    read: () => {
      state.calls += 1
      if (!state.defer) {
        return Promise.resolve(READING)
      }
      return new Promise((resolve) => {
        release = resolve
      })
    },
  }
  return {
    sensor,
    state,
    releaseReading: (reading: CapacityReading | null) => release?.(reading),
    stopDeferring: () => {
      state.defer = false
    },
  }
}

const READING: CapacityReading = {
  usedRatio: 0.5,
  remainingRatio: 0.5,
  confidence: "high",
  observedAt: NOW,
  evidence: "x-codex-primary-used-percent",
}

describe("CapacityRegistry", () => {
  it("answers none before anything is registered or refreshed", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    expect(registry.reading(MODEL_KEY)).toBeNull()
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
    await registry.refresh()
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
  })

  it("surfaces a sensor reading hierarchically: an ancestor sensor covers descendants", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const { sensor, state } = controlledSensor("codex", PROVIDER_KEY)
    state.reading = READING
    registry.register(sensor)
    await registry.refresh()
    expect(registry.reading(MODEL_KEY)).toEqual(READING)
    expect(registry.assessment(MODEL_KEY)).toEqual({
      kind: "estimate",
      reading: READING,
      signals: { exhausted: false, draining: false },
    })
  })

  it("does not leak readings across providers", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const { sensor, state } = controlledSensor("codex", PROVIDER_KEY)
    state.reading = READING
    registry.register(sensor)
    await registry.refresh()
    expect(registry.assessment(OTHER_PROVIDER_KEY)).toEqual({ kind: "none" })
  })

  it("maps exhausted and draining signals into the assessment", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const { sensor, state } = controlledSensor("codex", MODEL_KEY)
    state.reading = { ...READING, remainingRatio: 0 }
    registry.register(sensor)
    await registry.refresh()
    expect(registry.assessment(MODEL_KEY)).toEqual({
      kind: "estimate",
      reading: state.reading,
      signals: { exhausted: true, draining: false },
    })
    state.reading = { ...READING, remainingRatio: 0.05 }
    await registry.refresh()
    const assessment = registry.assessment(MODEL_KEY)
    expect(assessment.kind === "estimate" && assessment.signals.draining).toBe(true)
  })

  it("treats null, throwing, and malformed sensor output as no estimate (fail-open)", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const { sensor, state } = controlledSensor("codex", MODEL_KEY)
    registry.register(sensor)
    await registry.refresh()
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })

    state.throwNext = true
    await registry.refresh()
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
    state.throwNext = false

    state.reading = { nonsense: true } as unknown as CapacityReading
    await registry.refresh()
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })

    state.reading = { confidence: "high", observedAt: NOW }
    await registry.refresh()
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
  })

  it("sweeps stale readings lazily via the injected clock", async () => {
    const { now, advance } = fakeClock()
    const registry = new CapacityRegistry(now)
    const { sensor, state } = controlledSensor("codex", MODEL_KEY)
    state.reading = READING
    registry.register(sensor)
    await registry.refresh()
    expect(registry.reading(MODEL_KEY)).not.toBeNull()
    advance(DEFAULT_CAPACITY_CONFIG.maxAgeMs)
    expect(registry.reading(MODEL_KEY)).not.toBeNull()
    advance(1)
    expect(registry.reading(MODEL_KEY)).toBeNull()
  })

  it("merges sensors that cover the same resource", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const headers = controlledSensor("headers", MODEL_KEY)
    headers.state.reading = { remainingRatio: 0.5, confidence: "high", observedAt: NOW }
    const endpoint = controlledSensor("endpoint", MODEL_KEY)
    endpoint.state.reading = { retryAfterMs: 1_000, confidence: "low", observedAt: NOW }
    registry.register(headers.sensor)
    registry.register(endpoint.sensor)
    await registry.refresh()
    expect(registry.reading(MODEL_KEY)).toEqual({
      remainingRatio: 0.5,
      retryAfterMs: 1_000,
      confidence: "low",
      observedAt: NOW,
    })
  })

  it("replaces a sensor when its id is registered again", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const first = controlledSensor("codex", MODEL_KEY)
    first.state.reading = { usedRatio: 0.1, confidence: "high", observedAt: NOW }
    registry.register(first.sensor)
    await registry.refresh()
    const second = controlledSensor("codex", MODEL_KEY)
    second.state.reading = { usedRatio: 0.9, confidence: "high", observedAt: NOW }
    registry.register(second.sensor)
    await registry.refresh()
    expect(registry.reading(MODEL_KEY)?.usedRatio).toBe(0.9)
    expect(first.state.calls).toBe(1)
  })

  it("unregisters sensors and reports whether an entry existed", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const { sensor, state } = controlledSensor("codex", MODEL_KEY)
    state.reading = READING
    registry.register(sensor)
    expect(registry.unregister("missing")).toBe(false)
    await registry.refresh()
    expect(registry.reading(MODEL_KEY)).not.toBeNull()
    expect(registry.unregister("codex")).toBe(true)
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
  })

  it("admits a single in-flight read per sensor under concurrent refreshes", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const deferred = deferredSensor("codex", MODEL_KEY)
    registry.register(deferred.sensor)
    const first = registry.refresh()
    const second = registry.refresh()
    expect(deferred.state.calls).toBe(1)
    deferred.releaseReading(READING)
    await Promise.all([first, second])
    expect(registry.reading(MODEL_KEY)).toEqual(READING)
    deferred.stopDeferring()
    await registry.refresh()
    expect(deferred.state.calls).toBe(2)
  })

  it("discards a read whose sensor was unregistered while in flight", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const deferred = deferredSensor("codex", MODEL_KEY)
    registry.register(deferred.sensor)
    const refresh = registry.refresh()
    registry.unregister("codex")
    deferred.releaseReading(READING)
    await refresh
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
  })

  it("discards a read superseded by a re-registered sensor while in flight", async () => {
    const { now } = fakeClock()
    const registry = new CapacityRegistry(now)
    const deferred = deferredSensor("codex", MODEL_KEY)
    registry.register(deferred.sensor)
    const refresh = registry.refresh()
    const replacement = controlledSensor("codex", MODEL_KEY)
    replacement.state.reading = { usedRatio: 0.9, confidence: "high", observedAt: NOW }
    registry.register(replacement.sensor)
    deferred.releaseReading(READING)
    await refresh
    expect(registry.assessment(MODEL_KEY)).toEqual({ kind: "none" })
    deferred.stopDeferring()
    await registry.refresh()
    expect(registry.reading(MODEL_KEY)?.usedRatio).toBe(0.9)
  })
})
