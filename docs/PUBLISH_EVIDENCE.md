# Publish evidence

Real final verification output. Every number below comes from an actual run of
`npm run verify:release` on 2026-11-02 (full gate chain, single local command,
abort-on-first-failure), on the current head (post-T-33 UX iterations: active-mode
rename with settings migration, footer status chip, reworked adaptive menu,
status table, receipts footer pagination, per-session operating modes
(ADP-054), tier-editor Back-row removal). Machine-readable artifacts live under
`test-artifacts/` (`traceability.json`, `pack-check.json`, `e2e-tui-results/`,
`e2e-web-results/`) and are gitignored.

## Revisions and runtimes

- Commit/revision: `7e7054d` — "T-32: adversarial review — probe-ticket lifecycle, ownership-mark, adoption defects fixed". Full history T-01…T-32 committed before this evidence run.
- OpenCode versions tested: **2.2.1** (minimum supported, packed-plugin suite), **2.2.5** (current and latest, packed-plugin suite + all runtime/web/TUI E2E).
- Node: v26.4.0 (format/lint/typecheck/test/coverage/build/pack/traceability/plugin-test/web E2E); v24.15.0 (Termwright PTY E2E — the verify-release script auto-prefixes a certified Node 22/24 when the runtime is newer). CI runs the same gates on Node 20/22/24.

## Gate results (from the final verify:release run)

| Gate                                                                                     | Result                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format:check (prettier)                                                                  | clean                                                                                                                                                                                                 |
| lint (eslint)                                                                            | clean, 0 errors/warnings                                                                                                                                                                              |
| typecheck (tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) | 0 errors                                                                                                                                                                                              |
| test (vitest, all projects)                                                              | **62 files, 1054 tests, all passed** (~168s)                                                                                                                                                          |
| coverage (unit project)                                                                  | **100% statements (2613/2613), 100% branches (1771/1771), 100% functions (549/549), 100% lines (2313/2313)** on `src/**` — 57 files, 1027 tests. No exclusions, no `istanbul ignore`, no empty tests. |
| build                                                                                    | tsc build + vite GUI bundle OK                                                                                                                                                                        |
| pack:check                                                                               | tarball OK (420 entries), publish dry-run OK                                                                                                                                                          |
| plugin-test                                                                              | **PASS on all 3 targets** — current (opencode 2.2.5), 2.2.1, latest (opencode 2.2.5)                                                                                                                  |
| e2e:web (Playwright)                                                                     | **45 passed, 0 failed, 0 skipped** (34.3s) — desktop + narrow + webkit, zero conditional skips                                                                                                        |
| e2e:tui (Termwright)                                                                     | **20/20 passed** (run `40f56012-cba4-4024-bd9e-4734e412b4b7`)                                                                                                                                         |
| traceability                                                                             | **54 requirements, 72 declaring files, 33/33 E2E-applicable covered E2E — OK**                                                                                                                        |

## Test layers within the 1054 passing tests

- Unit: every `src/**` module, 100% coverage.
- Property / state-machine (fast-check): classification totality, health-state legality, scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe ≡ Control decisions; pin wins; finite escalation budgets; one half-open probe; preferred resource returns only at a safe boundary), receipt no-secrets/boundedness.
- Integration: real seams with fake adapters (scheduler→health→state, retry veto policy, rpc validation, settings migration, restart round-trips, fail-open).
- Fault injection: deterministic fake provider (429 + Retry-After, quota/reset, 503, timeout, disconnect, malformed error, context rejection, recovery-after-N) + injected clock; concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
- Headless (ADP-045): 26 runtime E2E tests (supervision 8, lifecycle 7+, routing 5, rpc 5, session-modes) run against real `opencode serve` hosts with **no TUI/GUI surface loaded** — active-mode recovery flows, failover, parks, receipts, per-session modes.
- Goal tests (ADP-041): the native `/goal` journey on a real host — "supervises a native /goal episode: fails over mid-goal and recovers at the next boundary" (lifecycle.test.ts) — plus unit/mode property tests for goal compatibility.

## Packed-plugin tests (ADP-040)

`npm run plugin-test` packs the plugin with `npm pack`, inspects the tarball, boots a real isolated OpenCode host per target, and asserts per target (9 checks each, all ✓ on 2.2.1 / 2.2.5-current / 2.2.5-latest): packed-artifact integrity, plugin-registration, plugin activates with the expected id (`coool.adaptive`), typed rpc returns install defaults, typed rpc applies a settings patch, typed rpc status mirrors settings, receipts.list starts empty, unknown rpc method rejected, host session apis remain available.

## Playwright Web E2E (ADP-042/044)

45 tests across chromium (desktop 1280×800), chromium-narrow (390×844), webkit — **45 passed, 0 skipped** (the narrow skips were converted into real journeys via `/settings?tab=` URL routes; committed 1fb552d). Covered journeys: connection (first install, wrong password, keyboard operability), settings surfaces, models catalog search + empty state, plugin listing, plugin RPC integration (settings read/patch/reload persistence, invalid patch rejection, status mirroring), cross-surface sync both directions (web→TUI live, TUI→web after reload), server disconnect, and the GUI-mount limitation canary (no Adaptive settings surface mounts in the browser-served app on 2.2.5).

## Termwright TUI E2E (ADP-043)

20 journeys (see docs/TEST_STRATEGY.md §TUI E2E journeys for the full list): boot/first-run, keyboard palette navigation, session turn, the `/adaptive` flow from palette AND slash menu (first-run invitation → "Open the menu now / Later" select), the Status page as a column-aligned table (custom dialog, styled to match host dialogs, screenshot-verified), the Mode menu's Global/This-session target select on every screen (with the home alert explaining that session modes need a session), per-session overrides, tier editor (search/add/variant, reorder incl. "Move to top", remove+confirm/cancel), pin set/clear, receipts empty + populated + footer-action pagination (ctrl+b/ctrl+f), health display after a failed turn, off mode, service-kill reconnect, and 80x24/200x50 dimension runs. Sandbox requirements established empirically on 2.2.5: the plugin must be configured in the HOME-based global config (`~/.config/opencode/opencode.json`) for the TUI to mount its bundle and resolve its RPC (a project-local entry registers the command but every rpc call fails with `rpc.unavailable`; the `$XDG_CONFIG_HOME` config file is not consulted for plugin discovery), and the keymap layer needs `mode: "global"` (fixed in `src/tui.tsx`).

## Packaging validation (ADP-048/050)

`npm run pack:check`: real `npm pack` tarball (420 entries) — all required files present (four exports + `.d.ts` files, LICENSE, README, manifest); forbidden-content scan clean (no `src/`, `test/`, `docs/`, `scripts/`, `node_modules`, `GOAL.md`, `coverage/` in the tarball — only LICENSE/README/package.json outside `dist/`); manifest name/semver/MIT verified; `npm publish --dry-run` OK. Artifact: `test-artifacts/pack-check.json`. Static publish contract additionally asserted by `test/package.test.ts` (exact exports key set, MIT, minimal runtime dependencies).

## Visual inspection

Real screenshots of both surfaces captured and inspected (kept under gitignored `test-artifacts/visual/` per the GOAL rule — not committed): web connect form, password focus ring, wrong-password error state, home empty state, settings tabs, models search, plugins listing, narrow home + bottom-sheet dialog, disconnect state; TUI boot home, command palette, session reply. No Adaptive-owned visual defects found (hierarchy, spacing, alignment, mobile, wrapping, focus, keyboard, empty/error states, copy). Details in `docs/TASKS.md` T-31.

## Hygiene checks (GOAL publish-ready checklist)

- No TODO/FIXME/XXX/HACK placeholders remain (`grep` over `src/`, `scripts/`, `test/` — zero matches).
- No `.only` / `.skip` / `.fixme` in vitest suites (zero matches); the Playwright suite runs with zero conditional skips (narrow coverage via settings URL routes).
- No known flaky tests: zero retries in all E2E; flaky tests are treated as bugs and were fixed (e.g. scheduler draining oracle in T-21, receipt polling under instrumentation in T-28).
- No known release-blocking bug remains: the T-32 adversarial review found 5 defects, all fixed with failing-first regression tests kept permanently; a subsequent full area re-review fixed 20+ more defects (health windows, probe tickets, settings patches, store write ordering) the same way.

## Known limitations

- **OpenCode 2.2.5 plugin GUI surface:** plugin GUI bundles (the `./gui-experimental` export) do not mount on ANY shipped host — the browser-served web app has the client SDK chunk but no plugin bridge, and the desktop app (1.15.4 and 1.19.5) ships neither the SDK nor the bridge (three-way proof: bundle archaeology + live desktop probes; covered by an inverted canary test; the page's copy/DOM is asserted at unit level). All settings features are fully usable via the TUI (`/adaptive`) and typed RPC; sibling plugins ship no GUI export either.
- **Termwright PTY backend is darwin-only** (`@termwright/pty-darwin-arm64`); the CI `tui-e2e` job therefore runs on macOS.
- **Capacity sensing is best-effort:** WebSocket-native providers (OpenAI OAuth/Codex) bypass the `http.request/response` hooks OpenCode exposes; header-based capacity views are never load-bearing.
- **By design:** no cross-tier borrowing (a tier exhausted means work waits or parks); no de-escalation of a running episode; no failback mode; no telemetry.
