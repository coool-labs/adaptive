// covers: ["ADP-037"]
import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

// Shared vite-level options: vitest projects do not inherit the root config's
// plugins/resolve/server blocks, so every project spreads these explicitly.
const shared = {
  plugins: [solid()],
  resolve: {
    alias: [
      { find: /^solid-js\/web$/, replacement: "solid-js/web/dist/dev.js" },
      { find: /^solid-js$/, replacement: "solid-js/dist/dev.js" },
    ],
  },
  test: {
    server: {
      deps: {
        // solid-js resolves its own "solid-js" imports through the Node resolver (server build) unless its
        // graph is inlined; inlining makes the aliases above apply inside node_modules.
        inline: [/solid-js/],
      },
    },
  },
}

export default defineConfig({
  test: {
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
    projects: [
      // The coverage gate runs the deterministic suite only (`--project unit`,
      // see the coverage npm script): real-host runtime E2E under V8
      // instrumentation is pathologically slow and timing-flaky (receipt
      // polling against a loaded host), and src/** coverage is complete from
      // the deterministic suite alone.
      {
        ...shared,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/runtime-e2e/**"],
        },
      },
      {
        ...shared,
        test: {
          name: "runtime-e2e",
          include: ["test/runtime-e2e/**/*.test.ts"],
        },
      },
    ],
  },
})
