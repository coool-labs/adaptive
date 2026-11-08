import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  fixedExtension: false,
  sourcemap: true,
  tsconfig: "tsconfig.build.json",
  dts: { tsc: { eager: true } },
  // Pi's extension loader aliases host package roots, not arbitrary subpaths.
  deps: {
    alwaysBundle: [/^@coool\/adaptive-core\//, /^@earendil-works\/pi-ai\/utils\/estimate$/],
    onlyBundle: [/^@coool\/adaptive-core\//, /^@earendil-works\/pi-ai$/],
    neverBundle: [/^@earendil-works\/(pi-ai|pi-coding-agent)$/],
  },
})
