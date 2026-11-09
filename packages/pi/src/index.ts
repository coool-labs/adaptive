import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent"
import { applyPatch, defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { registerAdaptive } from "./host/extension.js"
import { loadToolCapabilities } from "./capabilities.js"
import { jsonFile } from "./store.js"
import { timer } from "./host/timer.js"
import baseline from "../pi-host-baseline.json" with { type: "json" }
import matrix from "../pi-host-matrix.json" with { type: "json" }

export default function adaptive(pi: Parameters<typeof registerAdaptive>[0]): void {
  const path = join(getAgentDir(), "adaptive", "settings.json")
  registerAdaptive(
    pi,
    {
      newId: randomUUID,
      capacity: {
        file: jsonFile(join(getAgentDir(), "adaptive", "capacity.json")),
        clock: Date.now,
      },
      parking: {
        file: jsonFile(join(getAgentDir(), "adaptive", "parked.json")),
        clock: Date.now,
        timer,
      },
      health: {
        file: jsonFile(join(getAgentDir(), "adaptive", "health.json")),
        clock: Date.now,
        newId: randomUUID,
      },
      receipts: jsonFile(join(getAgentDir(), "adaptive", "receipts.json")),
      preferences: jsonFile(join(getAgentDir(), "adaptive", "preferences.json")),
      settings: async () => {
        let text: string
        try {
          text = await readFile(path, "utf8")
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return defaultSettings()
          throw error
        }
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          throw new Error("Adaptive settings: invalid JSON")
        }
        const parsed = applyPatch(defaultSettings(), raw)
        if (!parsed.ok) throw new Error(`Adaptive settings: ${parsed.errors.join(", ")}`)
        return parsed.settings
      },
      capabilities: () =>
        loadToolCapabilities(join(getAgentDir(), "adaptive", "capabilities.json"), (file) =>
          readFile(file, "utf8"),
        ),
    },
    {
      settings: jsonFile(path),
      capabilities: jsonFile(join(getAgentDir(), "adaptive", "capabilities.json")),
      version: VERSION,
      minimum: matrix.minimum,
      // The last recorded packed-host matrix; a release records its own after verification.
      testedUpTo: baseline.testedUpTo,
    },
  )
}
