import { defineTermwrightConfig } from "@termwright/test"

export default defineTermwrightConfig({
  columns: 100,
  rows: 30,
  outputDir: "test-artifacts/e2e-tui-results",
})
