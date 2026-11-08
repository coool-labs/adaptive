# OpenCode adapter

OpenCode SDK imports, supervisor wiring, RPC, and OpenCode UI belong here.
Host-free behavior belongs in `@coool/adaptive-core`, not a parallel implementation.
Test-only provider imports use `@coool/adaptive-testkit`.

From the repository root: `npm run check -- --pkg opencode` and
`npm run verify -- --pkg opencode`. `npm test` runs all unit projects.
Build output must embed core code and declarations; published packages must not
depend on either private workspace. Preserve the existing package exports.
