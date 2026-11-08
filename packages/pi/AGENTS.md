# Pi Adaptive

Keep Pi SDK imports in `src/host/` and `src/index.ts`. Reuse the shared scheduler;
never infer capability from prompt text or recover across tiers. Tests use the
real Pi SDK with a faux provider, never paid models. This package stays private
until every Pi release gate in `docs/plans/pi-plugin.md` passes.

From the repository root: `npm run check -- --pkg pi` and
`npm run verify -- --pkg pi`. Maintain 100% own unit coverage.
