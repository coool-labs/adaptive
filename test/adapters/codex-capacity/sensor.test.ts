// covers: ["ADP-020"]
import { describe, expect, it } from "vitest"
import { CodexCapacitySensor } from "../../../src/adapters/codex-capacity/sensor.js"

const RESOURCE = { providerID: "openai" }

describe("CodexCapacitySensor", () => {
  it("reports null before any observation", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    await expect(sensor.read()).resolves.toBeNull()
  })

  it("carries id and resource", () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    expect(sensor.id).toBe("codex-headers")
    expect(sensor.resource).toEqual(RESOURCE)
  })

  it("converts a valid observation into a reading", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    sensor.observe(
      { "x-codex-primary-used-percent": "40", "x-codex-primary-reset-after-seconds": "30" },
      7_000,
    )
    const reading = await sensor.read()
    expect(reading).not.toBeNull()
    expect(reading?.usedRatio).toBeCloseTo(0.4, 12)
    expect(reading?.resetAt).toBe(7_000 + 30 * 1000)
    expect(reading?.observedAt).toBe(7_000)
    expect(reading?.confidence).toBe("high")
  })

  it("anchors resetAt to observation time, not read time", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    sensor.observe(
      { "x-codex-primary-used-percent": "40", "x-codex-primary-reset-after-seconds": "60" },
      2_000,
    )
    const reading = await sensor.read()
    expect(reading?.resetAt).toBe(2_000 + 60 * 1000)
    expect(reading?.observedAt).toBe(2_000)
  })

  it("clears the stored usage on unparseable telemetry (distrust)", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    sensor.observe({ "x-codex-primary-used-percent": "40" }, 5_000)
    await expect(sensor.read()).resolves.not.toBeNull()
    sensor.observe({ "x-codex-primary-used-percent": "garbage" }, 6_000)
    await expect(sensor.read()).resolves.toBeNull()
  })

  it("clears when observation has no trustworthy window at all", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    sensor.observe({ "x-codex-primary-used-percent": "40" }, 5_000)
    sensor.observe({ authorization: "Bearer x" }, 6_000)
    await expect(sensor.read()).resolves.toBeNull()
  })

  it("replaces the previous observation with a newer valid one", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    sensor.observe({ "x-codex-primary-used-percent": "40" }, 1_000)
    sensor.observe({ "x-codex-primary-used-percent": "90" }, 2_000)
    const reading = await sensor.read()
    expect(reading?.usedRatio).toBeCloseTo(0.9, 12)
    expect(reading?.observedAt).toBe(2_000)
  })

  it("never throws on read (no-data contract)", async () => {
    const sensor = new CodexCapacitySensor(RESOURCE)
    sensor.observe({}, 0)
    await expect(sensor.read()).resolves.toBeNull()
  })
})
