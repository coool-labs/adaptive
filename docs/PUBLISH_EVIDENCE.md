# Publish evidence

Real final verification output. Every number below comes from an actual run of
`npm run verify:release` on 2026-11-03 (full gate chain, single local command,
abort-on-first-failure), for release 1.2.0: the full post-1.0.0 correctness review,
expanded real-host E2E coverage, subscription-limit classification,
health-blocked manual-selection fallback, and the tier-editor save flow
(see CHANGELOG 1.0.1 and 1.2.0). Machine-readable artifacts live under
`test-artifacts/` (`traceability.json`, `pack-check.json`, `e2e-tui-results/`,
`e2e-web-results/`) and are gitignored.

## Revisions and runtimes

- Commit/revision: fixes and tests through `220dbb5` (including `07a3ae2`, `2926cfb`, `a56ccd3`, and `a595336`), verified with the 1.2.0 package/lockfile version and CHANGELOG. These release files and this evidence are recorded in commit `1.2.0`, tagged `v1.2.0`.
- OpenCode versions tested: **2.2.1** (minimum supported, packed-plugin suite), **2.2.5** (current and latest, packed-plugin suite + all runtime/web/TUI E2E).
- Node: v26.4.0 (format/lint/typecheck/test/coverage/build/pack/traceability/plugin-test/web E2E); v24.15.0 (Termwright PTY E2E — the verify-release script auto-prefixes a certified Node 22/24 when the runtime is newer). CI runs the same gates on Node 20/22/24.

## Gate results (from the final verify:release run)

| Gate                                                                                     | Result                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format:check (prettier)                                                                  | clean                                                                                                                                                                                                 |
| lint (eslint)                                                                            | clean, 0 errors/warnings                                                                                                                                                                              |
| lint:biome (style anti-patterns)                                                         | clean, 0 diagnostics (`--error-on-warnings`)                                                                                                                                                          |
| typecheck (tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) | 0 errors                                                                                                                                                                                              |
| test (vitest, all projects)                                                              | **77 files, 1255 tests, all passed**                                                                                                                                                                  |
| coverage (unit project)                                                                  | **100% statements (3156/3156), 100% branches (2095/2095), 100% functions (686/686), 100% lines (2761/2761)** on `src/**` — 66 files, 1210 tests. No exclusions, no `istanbul ignore`, no empty tests. |
| build                                                                                    | tsc build + vite GUI bundle OK                                                                                                                                                                        |
| pack:check                                                                               | tarball OK (334 entries), publish dry-run OK                                                                                                                                                          |
| plugin-test                                                                              | **PASS on all 3 targets** — current (opencode 2.2.5), 2.2.1, latest (opencode 2.2.5)                                                                                                                  |
| e2e:web (Playwright)                                                                     | **45 passed, 0 failed, 0 skipped** (37.8s) — desktop + narrow + webkit, zero conditional skips                                                                                                        |
| e2e:tui (Termwright)                                                                     | **23/23 passed** (run `df5d68a0-e1d8-42db-ba3d-c71ac2b37573`)                                                                                                                                         |
| traceability                                                                             | **56 requirements, 87 declaring files, 35/35 E2E-applicable covered E2E — OK**                                                                                                                        |

## Test layers within the 1255 passing tests

- Unit: every `src/**` module, 100% coverage.
- Property / state-machine (fast-check): classification totality, health-state legality, scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe ≡ Control decisions; pin wins; finite escalation budgets; one half-open probe; preferred resource returns only at a safe boundary), receipt no-secrets/boundedness.
- Integration: real seams with fake adapters (scheduler→health→state, retry veto policy, rpc validation, settings migration, restart round-trips, fail-open).
- Fault injection: deterministic fake provider (429 + Retry-After, quota/reset, 503, timeout, disconnect, malformed error, context rejection, recovery-after-N) + injected clock; concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
- Headless (ADP-045): 45 runtime E2E tests run against real `opencode serve` hosts with **no TUI/GUI surface loaded** — supervision, lifecycle, routing, rpc incl. wire-level schema-gate rejection, session modes, tier requests, active-mode recovery, failover, parks, receipts, provider failure modes, restart durability, manual-selection semantics, once-only breaker counting, and per-task escalation budgets.
- Goal tests (ADP-041): the native `/goal` journey on a real host — "supervises a native /goal episode: fails over mid-goal and recovers at the next boundary" (lifecycle.test.ts) — plus unit/mode property tests for goal compatibility.

## Packed-plugin tests (ADP-040)

`npm run plugin-test` packs the plugin with `npm pack`, inspects the tarball, boots a real isolated OpenCode host per target, and asserts per target (9 checks each, all ✓ on 2.2.1 / 2.2.5-current / 2.2.5-latest): packed-artifact integrity, plugin-registration, plugin activates with the expected id (`coool.adaptive`), typed rpc returns install defaults, typed rpc applies a settings patch, typed rpc status mirrors settings, receipts.list starts empty, unknown rpc method rejected, host session apis remain available.

## Playwright Web E2E (ADP-042/044)

45 tests across chromium (desktop 1280×800), chromium-narrow (390×844), webkit — **45 passed, 0 skipped** (the narrow skips were converted into real journeys via `/settings?tab=` URL routes; committed 1fb552d). Covered journeys: connection (first install, wrong password, keyboard operability), settings surfaces, models catalog search + empty state, plugin listing, plugin RPC integration (settings read/patch/reload persistence, invalid patch rejection, status mirroring), cross-surface sync both directions (web→TUI live, TUI→web after reload), server disconnect, and the GUI-mount limitation canary (no Adaptive settings surface mounts in the browser-served app on 2.2.5).

## Termwright TUI E2E (ADP-043)

23 journeys (see docs/TEST_STRATEGY.md §TUI E2E journeys for the full list), including a project-local-install journey proving the TUI's rpc calls reach a plugin listed only in the project's config: boot/first-run, keyboard palette navigation, session turn, the `/adaptive` flow from palette AND slash menu (first-run invitation → "Open the menu now / Later" select), the Status page as a column-aligned table (custom dialog, styled to match host dialogs, screenshot-verified), the Mode menu's Global/This-session target select on every screen (with the home alert explaining that session modes need a session), per-session mode overrides, the per-session Tier menu (ADP-055), a subscription capacity window with its reset time in the Status table (ADP-056), tier editor (search/add/variant, reorder incl. "Move to top", remove+confirm/cancel), pin set/clear, receipts empty + populated + footer-action pagination (ctrl+b/ctrl+f), health display after a failed turn, off mode, service-kill reconnect, and 80x24/200x50 dimension runs. Sandbox requirements established empirically on 2.2.5: the TUI must be configured in the HOME-based global config (`~/.config/opencode/opencode.json`) for its bundle to mount; the `$XDG_CONFIG_HOME` config file is not consulted for plugin discovery; the keymap layer needs `mode: "global"` (fixed in `src/tui.tsx`). Project-local plugin installs reach the plugin's rpc handlers because every TUI rpc call carries the TUI location (commit 39dc4cd).

## Packaging validation (ADP-048/050)

`npm run pack:check`: real `npm pack` tarball (334 entries) — all required files present (four exports + `.d.ts` files, LICENSE, README, manifest); forbidden-content scan clean (no `src/`, `test/`, `docs/`, `scripts/`, `node_modules`, `GOAL.md`, `coverage/` in the tarball — only LICENSE/README/package.json outside `dist/`); manifest name/semver/MIT verified; `npm publish --dry-run` OK. Artifact: `test-artifacts/pack-check.json`. Static publish contract additionally asserted by `test/package.test.ts` (exact exports key set, MIT, minimal runtime dependencies).

## Visual inspection

Real screenshots of both surfaces captured and inspected (kept under gitignored `test-artifacts/visual/` per the GOAL rule — not committed): web connect form, password focus ring, wrong-password error state, home empty state, settings tabs, models search, plugins listing, narrow home + bottom-sheet dialog, disconnect state; TUI boot home, command palette, session reply. No Adaptive-owned visual defects found (hierarchy, spacing, alignment, mobile, wrapping, focus, keyboard, empty/error states, copy). Details in `docs/TASKS.md` T-31.

## Hygiene checks (GOAL publish-ready checklist)

- No TODO/FIXME/XXX/HACK placeholders remain (`grep` over `src/`, `scripts/`, `test/` — zero matches).
- No `.only` / `.skip` / `.fixme` in vitest suites (zero matches); the Playwright suite runs with zero conditional skips (narrow coverage via settings URL routes).
- No known flaky tests: zero retries in all E2E; flaky tests are treated as bugs and were fixed (e.g. scheduler draining oracle in T-21, receipt polling under instrumentation in T-28).
- No known release-blocking bug remains: the T-32 adversarial review found 5 defects, all fixed with failing-first regression tests kept permanently; subsequent full-area re-reviews fixed 40+ more defects the same way (health windows, probe tickets and probe release, escalation budget attribution, store write ordering, setup rollback, rpc error surfacing, manual-selection handling, persisted parsers, packaging portability — see CHANGELOG 1.0.1). Release 1.2.0 adds quota-message regression cases, health-blocked manual-selection fallback coverage, and unit/TUI regressions proving saves keep the tier page open.

## Known limitations

- **OpenCode 2.2.5 plugin GUI surface:** plugin GUI bundles (the `./gui-experimental` export) do not mount on ANY shipped host — the browser-served web app has the client SDK chunk but no plugin bridge, and the desktop app (1.15.4 and 1.19.5) ships neither the SDK nor the bridge (three-way proof: bundle archaeology + live desktop probes; covered by an inverted canary test; the page's copy/DOM is asserted at unit level). All settings features are fully usable via the TUI (`/adaptive`) and typed RPC; sibling plugins ship no GUI export either.
- **Termwright PTY backend is darwin-only** (`@termwright/pty-darwin-arm64`); the CI `tui-e2e` job therefore runs on macOS.
- **Capacity sensing is best-effort:** WebSocket-native providers (OpenAI OAuth/Codex) bypass the `http.request/response` hooks OpenCode exposes; header-based capacity views are never load-bearing.
- **By design:** no cross-tier borrowing (a tier exhausted means work waits or parks); no de-escalation of a running episode; no failback mode; no telemetry.
