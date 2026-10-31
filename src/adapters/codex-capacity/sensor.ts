/**
 * The passive-header `CapacitySensor` (ADP-020). Holds the latest validated
 * header observation; `read()` converts it to a reading. No polling, no
 * endpoint calls, no credential handling — WebSocket-backed providers bypass
 * the HTTP hook entirely (verified limitation), so this sensor reports
 * `null` (no estimate) whenever no trustworthy headers have been observed.
 * An unparseable observation CLEARS the stored usage: present-but-invalid
 * telemetry is distrust, and a stale quota estimate must never linger.
 */
import type { ResourceKey } from "../../health/resource-health/types.js"
import type { CapacityReading, CapacitySensor } from "../../health/capacity/types.js"
import { parseCodexUsage } from "./parse.js"
import { readingFromUsage } from "./reading.js"
import type { CodexUsage } from "./types.js"
import { CODEX_SENSOR_ID } from "./types.js"

export class CodexCapacitySensor implements CapacitySensor {
  readonly id = CODEX_SENSOR_ID
  readonly resource: ResourceKey
  #usage: CodexUsage | null = null
  #observedAt = 0

  constructor(resource: ResourceKey) {
    this.resource = resource
  }

  /**
   * Record one captured-header observation. Unparseable telemetry clears the
   * previous estimate instead of keeping it (present-but-invalid = distrust).
   */
  observe(captured: Readonly<Record<string, string>>, observedAt: number): void {
    this.#usage = parseCodexUsage(captured)
    if (this.#usage !== null) {
      this.#observedAt = observedAt
    }
  }

  read(): Promise<CapacityReading | null> {
    const usage = this.#usage
    if (usage === null) {
      return Promise.resolve(null)
    }
    return Promise.resolve(readingFromUsage(usage, this.#observedAt))
  }
}
