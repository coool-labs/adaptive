import { defineConfig } from "vitest/config"
import { shared } from "./vitest.shared.js"

export default defineConfig({
  ...shared,
  test: { ...shared.test, name: "runtime-e2e", include: ["test/runtime-e2e/**/*.test.ts"] },
})
