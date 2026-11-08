import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { applyPatch, defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { registerAdaptive } from "./host/extension.js"
import { loadToolCapabilities } from "./capabilities.js"

export default function adaptive(pi: Parameters<typeof registerAdaptive>[0]): void {
  const path = join(getAgentDir(), "adaptive", "settings.json")
  registerAdaptive(pi, {
    newId: randomUUID,
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
  })
}
