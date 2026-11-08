# Shared core

Host-free routing, health, state, execution, flow, and capacity sensors live here.
Never import a host SDK, host plugin, Solid, or OpenTUI, including in tests.
Use injected clocks and storage; maintain 100% coverage from this package's tests.

From the repository root: `npm run check -- --pkg core`.
Core is private source-only tooling input, bundled into each published plugin.
Do not build or publish it separately.
