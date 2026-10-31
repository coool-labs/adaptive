import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: [
      { find: /^solid-js\/web$/, replacement: "solid-js/web/dist/dev.js" },
      { find: /^solid-js$/, replacement: "solid-js/dist/dev.js" },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        // solid-js resolves its own "solid-js" imports through the Node resolver (server build) unless its
        // graph is inlined; inlining makes the aliases above apply inside node_modules.
        inline: [/solid-js/],
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
