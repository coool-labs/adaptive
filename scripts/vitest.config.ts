import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "tooling",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "affected.ts",
        "check-plan.ts",
        "check-runner.ts",
        "package-context.ts",
        "pack-policy.ts",
        "release/plan.ts",
        "release/execute.ts",
        "requirements.ts",
        "pi-matrix-policy.ts",
      ],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
