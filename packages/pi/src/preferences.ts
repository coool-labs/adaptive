import type { JsonFile } from "./store.js"
import { object } from "./settings.js"

export const NOTE_VERBOSITIES = ["quiet", "changes", "all"] as const
export type NoteVerbosity = (typeof NOTE_VERBOSITIES)[number]
export interface PiPreferences {
  readonly version: 1
  readonly verbosity: NoteVerbosity
  readonly escalateFromPinned: boolean
}

function fields(raw: unknown): Partial<PiPreferences> {
  if (!object(raw)) throw new Error("Adaptive preferences: expected an object")
  if (Object.keys(raw).some((key) => !["version", "verbosity", "escalateFromPinned"].includes(key)))
    throw new Error("Adaptive preferences: unknown field")
  if (raw["version"] !== undefined && raw["version"] !== 1)
    throw new Error("Adaptive preferences.version: expected 1")
  const verbosity = NOTE_VERBOSITIES.find((value) => value === raw["verbosity"])
  if (raw["verbosity"] !== undefined && verbosity === undefined)
    throw new Error("Adaptive preferences.verbosity: expected quiet, changes, or all")
  const escalate = raw["escalateFromPinned"]
  if (escalate !== undefined && typeof escalate !== "boolean")
    throw new Error("Adaptive preferences.escalateFromPinned: expected a boolean")
  return {
    ...(verbosity === undefined ? {} : { verbosity }),
    ...(typeof escalate === "boolean" ? { escalateFromPinned: escalate } : {}),
  }
}

export function parsePreferences(raw: unknown): PiPreferences {
  return {
    version: 1,
    verbosity: "changes",
    escalateFromPinned: false,
    ...(raw === undefined ? {} : fields(raw)),
  }
}

export async function readPreferences(file: Pick<JsonFile, "read">): Promise<PiPreferences> {
  return parsePreferences(await file.read())
}

export function updatePreferences(file: JsonFile, patch: unknown): Promise<PiPreferences> {
  return file.update((raw) => {
    const next = { ...parsePreferences(raw), ...fields(patch) }
    return { next, result: next }
  })
}
