import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "pi-sdk",
    include: ["test/runtime/**/*.test.ts", "test/packed/**/*.test.ts"],
    testTimeout: 60000,
  },
})
