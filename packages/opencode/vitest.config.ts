// covers: ["ADP-037"]
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import { shared } from "./vitest.shared.js"

export default defineConfig({
  ...shared,
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    ...shared.test,
    name: "opencode",
    include: ["test/**/*.test.ts"],
    exclude: ["test/runtime-e2e/**"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
