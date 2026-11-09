import type { ParkingSources } from "../parking.js"

// Owned waits must keep print/json alive. TUI timers are cancelled on shutdown.
export const timer: ParkingSources["timer"] = (callback, delay) => {
  const handle = setTimeout(callback, delay)
  return () => {
    clearTimeout(handle)
  }
}
