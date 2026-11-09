covers: ["ADP-046"]

# Contributing to Adaptive

An OpenCode v2 plugin that supervises execution episodes: capability-tier routing (quick / standard / advanced), structured-evidence escalation, horizontal failure recovery, and resource-health tracking. The requirements live in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) and the test layers in [packages/opencode/docs/TEST_STRATEGY.md](packages/opencode/docs/TEST_STRATEGY.md).

## Setup

```sh
npm install
```

Termwright's optional native PTY package must be installed under Node 22/24;
npm on Node 26 silently omits it because of its engine constraint. If TUI tests
report a missing PTY addon, run
`PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm install`.
Use Node 26 for the normal OpenCode build and Node 24 for Termwright.

## Gates

Run these commands from the repository root:

```sh
npm test                         # all unit projects; no host startup
npm run check                    # fast gates for affected workspaces
npm run check -- --all           # fast gates for every workspace
npm run verify -- --all          # complete release verification
npm run verify -- --pkg opencode # complete OpenCode verification
npm run doctor                   # diagnose local prerequisites
```

`check` compares against `main` and includes staged, unstaged, and untracked
changes. Shared/root changes select every workspace. `verify` adds build,
packaging, packed-host checks, runtime E2E, UI E2E, and traceability in order.
It builds before runtime E2E so a clean checkout needs no stale artifacts.
Logs land in `test-artifacts/run/<workspace>/<step>.log`; failures show the
last 40 lines. Explicit `--skip <step>` options appear in the final verdict;
a skipped run is not release evidence.

Individual gates remain available:

```sh
npm run format:check   # prettier
npm run lint           # eslint
npm run lint:biome     # biome (style anti-patterns; biome.json)
npm run typecheck      # tsc --noEmit (strictest sensible config)
npm test               # vitest
npm run coverage       # vitest + 100% statement/branch/function/line gate on src/**
npm run build          # bundled plugins + GUI bundle
npm run pack:check     # tarball inspection + publish dry-run (ADP-048)
npm run plugin-test    # packed plugin against real OpenCode hosts (2.2.1 / current / latest)
npm run e2e:runtime    # real-host routing, recovery, persistence and RPC
npm run e2e:gui        # GUI /adaptive journeys: built bundle + stand-in host on a real server (100% coverage gate)
npm run e2e:web        # Playwright web E2E (Chromium + WebKit, desktop + narrow)
npm run e2e:tui        # Termwright PTY TUI E2E (80x24 / narrow / wide)
npm run traceability   # requirement-coverage gate (ADP-047)
```

`npm run verify -- --all` is the complete release gate (there is no CI).
The runner selects Node 24 for the Termwright PTY leg, which runs on macOS only.

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
- [packages/opencode/docs/ARCHITECTURE.md](packages/opencode/docs/ARCHITECTURE.md) — module map and dependency rules.
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — the requirement list the traceability gate reads.
- [packages/opencode/docs/TEST_STRATEGY.md](packages/opencode/docs/TEST_STRATEGY.md) — test layers and scenario maps.

## Releases

```sh
npm run release:status           # changed publishable packages since their last tags
npm run release -- --dry-run     # preview default patch bumps and shared-core notes
npm run release                 # choose bumps and edit release notes interactively
```

Shared core/testkit commits select both publishable plugins. Private packages are
never published. Explicit choices work without prompts:
`npm run release -- --opencode patch --pi minor --notes opencode=notes/opencode.md --notes pi=notes/pi.md --yes`.
Omit a nonexistent package or use `--pi skip` to leave an existing package unchanged.
Notes files must be committed or outside the working tree; the real release
requires a clean `main` branch. Without `--notes`, set
`EDITOR`; drafts survive failed verification in `test-artifacts/release/`.

The CLI bumps manifests and the lockfile, updates changelogs, and runs full scoped
verification **on the bumped artifacts**. A failed preparation or verification
restores its file edits. It then commits and pushes. Publication and certification
are separate steps: `npm run publish:opencode` / `npm run publish:pi` publish the
bumped package and, only after the registry accepts it, certify it with its
annotated tag (`opencode-vX.Y.Z` / `pi-vX.Y.Z`, read from the just-published
manifest) and push the tag. Historical `vX.Y.Z` tags are pre-monorepo OpenCode
releases.

`npm run release -- --resume` on the release commit recovers a partial
publication: it rebuilds and verifies, ensures each release has its tag at HEAD,
queries npm, and publishes only the versions still missing from the registry.
Registry errors other than a confirmed E404 stop recovery.

Dry-run only previews: it does not write files, verify artifacts, authenticate,
create tags, publish, or push. Use `npm run verify -- --all` for release evidence.

Agents can drive the whole flow without prompts: explicit bumps, `--notes`, and
`--yes` cover every interactive release step; `publish:<pkg>` scripts run
non-interactively too and refuse an unclean tree, a non-`main` branch, or missing
npm authentication — so a feature branch or dirty tree cannot reach the registry.
