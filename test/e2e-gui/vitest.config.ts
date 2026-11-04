import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

// Same solid wiring as the unit project (see the root vitest.config.ts): the
// aliases make the source run and the built bundle share one solid instance.
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: [
      { find: /^solid-js\/web$/, replacement: "solid-js/web/dist/dev.js" },
      { find: /^solid-js$/, replacement: "solid-js/dist/dev.js" },
    ],
  },
  test: {
    include: ["test/e2e-gui/**/*.spec.ts"],
    environment: "jsdom",
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    server: { deps: { inline: [/solid-js/] } },
    coverage: {
      provider: "v8",
      include: ["src/gui.tsx", "src/ui/gui/**", "src/ui/flow/**"],
      reporter: ["text"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
