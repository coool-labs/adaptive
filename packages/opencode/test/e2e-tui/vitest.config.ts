import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/e2e-tui/**/*.spec.ts"],
    environment: "node",
    setupFiles: ["test/e2e-tui/setup.ts"],
  },
})
