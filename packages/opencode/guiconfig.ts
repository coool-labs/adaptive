import { defineConfig } from "vite"

import { gui } from "@opencode/plugin/gui/vite"

// Builds the ./gui-experimental bundle: one CommonJS file with Solid JSX compiled in and Effect/Solid/OpenCode
// modules kept external (the app provides them). Defaults: entry src/gui.tsx, output dist/gui-experimental.cjs.
export default defineConfig({
  plugins: [gui()],
})
