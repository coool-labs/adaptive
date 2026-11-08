# Adaptive

Execution supervision for coding agents: capability-tier routing, evidence-backed
escalation, same-tier recovery, and durable parking. No model classifier, no hidden
cross-tier borrowing, and no telemetry.

## Packages

- [OpenCode Adaptive](packages/opencode/README.md) — `@coool/opencode-adaptive`.
- Shared routing, health, state, and dialog logic live in `packages/core`;
  loopback provider fixtures live in `packages/testkit`. Both are private workspaces.
- Pi Adaptive — planned; implementation follows the [Pi plan](docs/plans/pi-plugin.md).

## Development

Run commands from this directory:

```sh
npm install
npm test                         # deterministic unit suites, all workspaces
npm run check                    # affected workspaces; no paid models
npm run check -- --all            # all workspaces
npm run verify -- --pkg opencode  # complete release gate, including real-host E2E
npm run doctor                   # local environment diagnostics
```

Checks print a short verdict and retain full logs under `test-artifacts/run/`.
`--skip e2e:tui` permits a partial verification, but its verdict explicitly records
the skip; it is not a release-ready result.

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[monorepo migration plan](docs/plans/monorepo.md), and the
[requirements](docs/REQUIREMENTS.md).
