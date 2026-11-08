import { expect, it, vi } from "vitest"
import { LOG_ERROR_LENGTH, logFailOpen } from "../src/log.js"

it("bounds failure diagnostics and identifies the failing scope", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
  try {
    logFailOpen("sensor", "x".repeat(LOG_ERROR_LENGTH + 1))
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[coool.adaptive] sensor: ${"x".repeat(LOG_ERROR_LENGTH)}`,
    )
  } finally {
    log.mockRestore()
  }
})
