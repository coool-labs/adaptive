covers: ["ADP-046"]

# Contributing to @coool/opencode-adaptive

An OpenCode v2 plugin that supervises execution episodes: capability-tier routing (quick / standard / advanced), structured-evidence escalation, horizontal failure recovery, and resource-health tracking. The requirements live in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and the test layers in [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md).

## Setup

```sh
npm install
```

## Gates

Every change must pass all of these before it is done — not merely compile:

```sh
npm run format:check   # prettier
npm run lint           # eslint
npm run lint:biome     # biome (style anti-patterns; biome.json)
npm run typecheck      # tsc --noEmit (strictest sensible config)
npm test               # vitest
npm run coverage       # vitest + 100% statement/branch/function/line gate on src/**
npm run build          # tsc build + GUI bundle
npm run pack:check     # tarball inspection + publish dry-run (ADP-048)
npm run plugin-test    # packed plugin against real OpenCode hosts (2.2.1 / current / latest)
npm run e2e:web        # Playwright web E2E (Chromium + WebKit, desktop + narrow)
npm run e2e:tui        # Termwright PTY TUI E2E (80x24 / narrow / wide)
npm run traceability   # requirement-coverage gate (ADP-047)
```

`npm run verify:release` chains all of the above in one command. CI runs the
same gates split across jobs (see `.github/workflows/ci.yml`); the Termwright
PTY leg runs on macOS only.

Environment constraint: `npm run e2e:tui` (Termwright) needs Node 22/24 — e.g.
`PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm run e2e:tui` — and macOS
for the PTY backend.

## Regression policy (ADP-046)

Every confirmed behavioral bug gets an automated regression test that **fails
before the fix and passes after it**. Never fix a behavioral defect only by
changing tests; never fix one without keeping a test that would catch its
return. The regression test is kept forever.

## Testing rules

- Assert behavior through public interfaces with in-memory fakes — not
  implementation trivia.
- Deterministic: no sleeps, no real network, no real clocks; inject time and
  dependencies. E2E suites never run paid models (deterministic fake provider).
- 100% coverage gate on first-party production code; no blanket exclusions, no
  `istanbul ignore`, no empty tests.
- Tests declare the requirements they cover with a
  `// covers: ["ADP-xxx", ...]` line above the first import;
  `npm run traceability` fails if a requirement loses all coverage or an
  E2E-applicable requirement loses its E2E coverage. The report lands in
  `test-artifacts/traceability.json`.
- E2E suites target real OpenCode hosts (server + web + PTY TUI) with the
  deterministic fake provider; journeys that a host version cannot support
  carry an inverted canary plus a documented proof of the limitation.

## Docs

- [docs/PRODUCT.md](docs/PRODUCT.md) — what the plugin is and is not.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map and dependency rules.
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — the requirement list the traceability gate reads.
- [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) — test layers and scenario maps.

## Releases

A version bump is a commit named exactly after the version (for example
`0.1.1`), tagged `v0.1.1`, with a CHANGELOG entry. `npm run verify:release`
must be green before publishing.
