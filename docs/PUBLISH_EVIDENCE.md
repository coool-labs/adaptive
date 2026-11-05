# Publish evidence

Real final verification output. Every number below comes from an actual run of
`npm run verify:release` on 2026-11-05 (full gate chain, single local command,
abort-on-first-failure), for release 1.4.0: the `/web-adaptive` server command for the web UI (status and mode switching, with a Playwright web E2E), on top of the 1.3.0 GUI `/adaptive` dialog flow shared with the TUI and the GUI end-to-end suite and the full post-1.0.0 correctness review,
expanded real-host E2E coverage, subscription-limit classification,
health-blocked manual-selection fallback, the tier-editor save flow,
automatic terminal-quota recovery with provider-scope quarantine and steering
protection, and 429 quota-text classification (see CHANGELOG 1.0.1, 1.2.0,
1.2.1, 1.2.2, 1.2.3, 1.3.0, and 1.4.0). Machine-readable artifacts live under
`test-artifacts/` (`traceability.json`, `pack-check.json`, `e2e-tui-results/`,
`e2e-web-results/`) and are gitignored.

## Revisions and runtimes

- Commit/revision: the 1.2.0 release chain through `220dbb5` (tagged `v1.2.0`, published to npm) plus the post-publication fixes: `897d5f9` (automatic terminal-quota recovery, provider-scope quota quarantine, steering protection — see CHANGELOG 1.2.1), `899d9ef` (real-host exactly-once continuation tests), `1a956a0` (repository URL → coool-labs/opencode-adaptive — see CHANGELOG 1.2.2), `86698a8` (a 429 whose text says the quota is spent quarantines for the quota window, not 30s), `8cc4ec4` (the TUI status journey expects a quota window for its billing-quota 429), and `b25cd5c` (ADP-049 retired — no CI; `verify:release` is the only release gate). Release 1.3.0 adds `0f1c37a` (the GUI `/adaptive` flow shared with the TUI, plus the GUI E2E suite) and the commit after it (the GUI settings page calls the RPC with the session location). Release 1.4.0 adds `dbed9e8` (the `/web-adaptive` server command and its web E2E). These release files and this evidence are recorded in commit `1.4.0`, tagged `v1.4.0`.
- OpenCode versions tested: **2.2.1** (minimum supported, packed-plugin suite), **2.2.5** (current and latest, packed-plugin suite + all runtime/web/TUI E2E).
- Node: v26.4.0 (format/lint/typecheck/test/coverage/build/pack/traceability/plugin-test/web E2E); v24.15.0 (Termwright PTY E2E — the verify-release script auto-prefixes a certified Node 22/24 when the runtime is newer).

## Gate results (from the final verify:release run)

| Gate                                                                                     | Result                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format:check (prettier)                                                                  | clean                                                                                                                                                                                                 |
| lint (eslint)                                                                            | clean, 0 errors/warnings                                                                                                                                                                              |
| lint:biome (style anti-patterns)                                                         | clean, 0 diagnostics (`--error-on-warnings`)                                                                                                                                                          |
| typecheck (tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) | 0 errors                                                                                                                                                                                              |
| test (vitest, all projects)                                                              | **82 files, 1324 tests, all passed**                                                                                                                                                                  |
| coverage (unit project)                                                                  | **100% statements (3300/3300), 100% branches (2178/2178), 100% functions (746/746), 100% lines (2885/2885)** on `src/**` — 70 files, 1272 tests. No exclusions, no `istanbul ignore`, no empty tests. |
| build                                                                                    | tsc build + vite GUI bundle OK                                                                                                                                                                        |
| pack:check                                                                               | tarball OK (343 entries), publish dry-run OK                                                                                                                                                          |
| plugin-test                                                                              | **PASS on all 3 targets** — current (opencode 2.2.5), 2.2.1, latest (opencode 2.2.5)                                                                                                                  |
| e2e:gui (vitest + jsdom, real server RPC)                                                | **66 passed**; **100% statements (578/578), branches (309/309), functions (173/173), lines (458/458)** on `src/gui.tsx`, `src/ui/gui/**`, `src/ui/flow/**                                             |
| e2e:web (Playwright)                                                                     | **57 passed, 0 failed, 0 skipped** (1.1m) — desktop + narrow + webkit, zero conditional skips                                                                                                         |
| e2e:tui (Termwright)                                                                     | **23/23 passed** (run `c55b4bc1-bd2c-414e-9dba-8da1d6c6baac`)                                                                                                                                         |
| traceability                                                                             | **55 requirements, 93 declaring files, 35/35 E2E-applicable covered E2E — OK**                                                                                                                        |

## Test layers within the 1324 passing tests

- Unit: every `src/**` module, 100% coverage.
- Property / state-machine (fast-check): classification totality, health-state legality, scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe ≡ Control decisions; pin wins; finite escalation budgets; one half-open probe; preferred resource returns only at a safe boundary), receipt no-secrets/boundedness.
- Integration: real seams with fake adapters (scheduler→health→state, retry veto policy, rpc validation, settings migration, restart round-trips, fail-open).
- Fault injection: deterministic fake provider (429 + Retry-After, quota/reset, 503, timeout, disconnect, malformed error, context rejection, recovery-after-N) + injected clock; concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
- Headless (ADP-045): 49 runtime E2E tests run against real `opencode serve` hosts with **no TUI/GUI surface loaded** — supervision, lifecycle, routing, rpc incl. wire-level schema-gate rejection, session modes, tier requests, active-mode recovery, failover, parks, receipts, provider failure modes, restart durability, manual-selection semantics, once-only breaker counting, per-task escalation budgets, steering that preserves the in-flight episode's model, and terminal quota failures that continue automatically through exhausted models to a working one.
- Goal tests (ADP-041): the native `/goal` journey on a real host — "supervises a native /goal episode: fails over mid-goal and recovers at the next boundary" (lifecycle.test.ts) — plus unit/mode property tests for goal compatibility.

## Packed-plugin tests (ADP-040)

`npm run plugin-test` packs the plugin with `npm pack`, inspects the tarball, boots a real isolated OpenCode host per target, and asserts per target (9 checks each, all ✓ on 2.2.1 / 2.2.5-current / 2.2.5-latest): packed-artifact integrity, plugin-registration, plugin activates with the expected id (`coool.adaptive`), typed rpc returns install defaults, typed rpc applies a settings patch, typed rpc status mirrors settings, receipts.list starts empty, unknown rpc method rejected, host session apis remain available.

## GUI E2E (ADP-034)

`npm run e2e:gui`: 33 journeys, each run twice — against the source and against the built `dist/gui-experimental.cjs` bundle — for 66 tests, with a 100% coverage gate on the GUI and shared-flow sources. The stand-in GUI host implements dialogs, toasts, sessions and the model catalog; everything behind it is real: a real `opencode serve` host, the real typed Adaptive RPC, real sessions and receipts. Fault paths (rejected or invalid RPC replies, crafted status snapshots) go through a wrapper around the real client. Coverage is measured on the source run because the bundle carries no sourcemap; the bundle run proves parity. Journeys: first-run invite, status (empty alert and table), the models editor (add with and without variants, reorder, remove), global and per-session mode, per-session tier request, pin, receipts (empty, detail, paging over seeded receipts), and the settings page.

## Playwright Web E2E (ADP-042/044)

57 tests across chromium (desktop 1280×800), chromium-narrow (390×844), webkit — **57 passed, 0 skipped** (the narrow skips were converted into real journeys via `/settings?tab=` URL routes; committed 1fb552d). Covered journeys: connection (first install, wrong password, keyboard operability), settings surfaces, models catalog search + empty state, plugin listing, plugin RPC integration (settings read/patch/reload persistence, invalid patch rejection, status mirroring), cross-surface sync both directions (web→TUI live, TUI→web after reload), server disconnect, and the GUI-mount limitation canary (no Adaptive settings surface mounts in the browser-served app on 2.2.5).

Web command journeys (`test/e2e-web/command.spec.ts`, ADP-034, 12 of the 57 tests): the real composer's slash menu offers `/web-adaptive`; the status reply ends with the switching help; `on` and `off` switch the mode with the server state verified over RPC; an unknown argument replies with the usage and changes nothing. Run on desktop Chromium, narrow Chromium and WebKit. The replies are one synthetic message per line with a description, which is what the web timeline displays.

## Termwright TUI E2E (ADP-043)

23 journeys (see docs/TEST_STRATEGY.md §TUI E2E journeys for the full list), including a project-local-install journey proving the TUI's rpc calls reach a plugin listed only in the project's config: boot/first-run, keyboard palette navigation, session turn, the `/adaptive` flow from palette AND slash menu (first-run invitation → "Open the menu now / Later" select), the Status page as a column-aligned table (custom dialog, styled to match host dialogs, screenshot-verified), the Mode menu's Global/This-session target select on every screen (with the home alert explaining that session modes need a session), per-session mode overrides, the per-session Tier menu (ADP-055), a subscription capacity window with its reset time in the Status table (ADP-056), tier editor (search/add/variant, reorder incl. "Move to top", remove+confirm/cancel), pin set/clear, receipts empty + populated + footer-action pagination (ctrl+b/ctrl+f), health display after a failed turn, off mode, service-kill reconnect, and 80x24/200x50 dimension runs. Sandbox requirements established empirically on 2.2.5: the TUI must be configured in the HOME-based global config (`~/.config/opencode/opencode.json`) for its bundle to mount; the `$XDG_CONFIG_HOME` config file is not consulted for plugin discovery; the keymap layer needs `mode: "global"` (fixed in `src/tui.tsx`). Project-local plugin installs reach the plugin's rpc handlers because every TUI rpc call carries the TUI location (commit 39dc4cd).

## Packaging validation (ADP-048/050)

`npm run pack:check`: real `npm pack` tarball (343 entries) — all required files present (four exports + `.d.ts` files, LICENSE, README, manifest); forbidden-content scan clean (no `src/`, `test/`, `docs/`, `scripts/`, `node_modules`, `GOAL.md`, `coverage/` in the tarball — only LICENSE/README/package.json outside `dist/`); manifest name/semver/MIT verified; `npm publish --dry-run` OK. Artifact: `test-artifacts/pack-check.json`. Static publish contract additionally asserted by `test/package.test.ts` (exact exports key set, MIT, minimal runtime dependencies).

## Visual inspection

Real screenshots of both surfaces captured and inspected (kept under gitignored `test-artifacts/visual/` per the GOAL rule — not committed): web connect form, password focus ring, wrong-password error state, home empty state, settings tabs, models search, plugins listing, narrow home + bottom-sheet dialog, disconnect state; TUI boot home, command palette, session reply. No Adaptive-owned visual defects found (hierarchy, spacing, alignment, mobile, wrapping, focus, keyboard, empty/error states, copy). Details in `docs/TASKS.md` T-31.

## Hygiene checks (GOAL publish-ready checklist)

- No TODO/FIXME/XXX/HACK placeholders remain (`grep` over `src/`, `scripts/`, `test/` — zero matches).
- No `.only` / `.skip` / `.fixme` in vitest suites (zero matches); the Playwright suite runs with zero conditional skips (narrow coverage via settings URL routes).
- No known flaky tests: zero retries in all E2E; flaky tests are treated as bugs and were fixed (e.g. scheduler draining oracle in T-21, receipt polling under instrumentation in T-28).
- No known release-blocking bug remains: the T-32 adversarial review found 5 defects, all fixed with failing-first regression tests kept permanently; subsequent full-area re-reviews fixed 40+ more defects the same way (health windows, probe tickets and probe release, escalation budget attribution, store write ordering, setup rollback, rpc error surfacing, manual-selection handling, persisted parsers, packaging portability — see CHANGELOG 1.0.1). Release 1.2.0 adds quota-message regression cases, health-blocked manual-selection fallback coverage, and unit/TUI regressions proving saves keep the tier page open. Release 1.2.1 adds terminal-quota recovery, quota-scope, and steering regressions at unit and real-host level. Release 1.2.3 adds 429 quota-text regressions at classifier, supervisor, and real-host level.

## Known limitations

- **GUI flow verified against a stand-in host only:** because no shipped host mounts plugin GUIs (next item), `ctx.dialogs.*`, `ui.Dialog`/`ui.Button`, and the host's model-catalog `Data` object are exercised only through the stand-in, not a real GUI host.
- **OpenCode 2.2.5 plugin GUI surface:** plugin GUI bundles (the `./gui-experimental` export) do not mount on ANY shipped host — the browser-served web app has the client SDK chunk but no plugin bridge, and the desktop app (1.15.4 and 1.19.5) ships neither the SDK nor the bridge (three-way proof: bundle archaeology + live desktop probes; covered by an inverted canary test; the page's copy/DOM is asserted at unit level). All settings features are fully usable via the TUI (`/adaptive`) and typed RPC; sibling plugins ship no GUI export either.
- **Termwright PTY backend is darwin-only** (`@termwright/pty-darwin-arm64`); `e2e:tui` therefore runs on macOS only.
- **Capacity sensing is best-effort:** WebSocket-native providers (OpenAI OAuth/Codex) bypass the `http.request/response` hooks OpenCode exposes; header-based capacity views are never load-bearing.
- **By design:** no cross-tier borrowing (a tier exhausted means work waits or parks); no de-escalation of a running episode; no failback mode; no telemetry.
