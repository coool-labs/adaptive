import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/tui.tsx", "src/rpc.ts"],
  format: "esm",
  tsconfig: "tsconfig.build.json",
  fixedExtension: false,
  sourcemap: true,
  dts: { tsc: { eager: true } },
  deps: {
    alwaysBundle: [/^@coool\/adaptive-core\//],
    onlyBundle: [/^@coool\/adaptive-core\//],
    neverBundle: [/^@opentui\//, /^solid-js(?:\/|$)/],
  },
})
