# opencode-adaptive 1.6.2

Fixes the `/adaptive` and `/web-adaptive` command outage. When an older
Adaptive release had already run in the same long-lived OpenCode process,
the newer release reused its incompatible process ledger and died during
setup, so neither command existed. The shared ledger key is now versioned.

The outage is locked in with real E2E coverage: runtime, browser and
real-PTY TUI journeys all run beside a stale ledger, runtime boot failures
now surface plugin-load errors, and TUI turn tests wait for the configured
model instead of submitting into the startup window.
