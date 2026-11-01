/**
 * Settings store (ADP-036): the server-side single source of truth. Loads
 * once at setup (migration-on-read), serves synchronous snapshots to the
 * scheduler, and persists validated patches. Reads fail open to defaults
 * (ADP-031); write failures propagate to the caller so surfaces can report
 * them — the in-memory snapshot is only advanced after a successful write.
 */
import { applyPatch, migrateSettings } from "./parse.js"
import type { PatchResult, SettingsPatch, SettingsStorage, SettingsV1 } from "./types.js"
import { defaultSettings } from "./parse.js"

export class SettingsStore {
  #current: SettingsV1 = defaultSettings()
  /** Tail of the update chain; keeps awaiting updates serialized. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: SettingsStorage) {}

  /** Current snapshot (defaults until the first successful load). */
  get(): SettingsV1 {
    return this.#current
  }

  /**
   * Read + migrate the persisted record. A storage read failure degrades to
   * defaults instead of breaking setup; the record is not rewritten here, so
   * a later successful patch simply re-stamps the current version.
   */
  async load(): Promise<SettingsV1> {
    let raw: unknown
    try {
      raw = await this.storage.read()
    } catch {
      raw = undefined
    }
    this.#current = migrateSettings(raw)
    return this.#current
  }

  /**
   * Validate, persist, then adopt. Invalid patches change nothing. Updates
   * serialize through a promise chain so two concurrent callers cannot both
   * patch the same base snapshot and lose one write (the chain swallows
   * rejections — a failed update must not poison the next one).
   */
  update(patch: SettingsPatch): Promise<PatchResult> {
    const run = this.#queue.then(async () => {
      const result = applyPatch(this.#current, patch)
      if (!result.ok) return result
      await this.storage.write(result.settings)
      this.#current = result.settings
      return result
    })
    this.#queue = run.catch(() => undefined)
    return run
  }
}
