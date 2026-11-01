# Publish evidence

Real final verification output. Every number below comes from an actual run of
`npm run verify:release` on 2026-11-01 (full gate chain, single local command,
abort-on-first-failure), on revision `7e7054d` (final code commit; the T-33
commit adds documentation only). Machine-readable artifacts live under
`test-artifacts/` (`traceability.json`, `pack-check.json`, `e2e-tui-results/`,
`e2e-web-results/`) and are gitignored.

## Revisions and runtimes

- Commit/revision: `7e7054d` — "T-32: adversarial review — probe-ticket lifecycle, ownership-mark, adoption defects fixed". Full history T-01…T-32 committed before this evidence run.
- OpenCode versions tested: **2.2.1** (minimum supported, packed-plugin suite), **2.2.5** (current and latest, packed-plugin suite + all runtime/web/TUI E2E).
- Node: v26.4.0 (format/lint/typecheck/test/coverage/build/pack/traceability/plugin-test/web E2E); v24.15.0 (Termwright PTY E2E — the verify-release script auto-prefixes a certified Node 22/24 when the runtime is newer). CI runs the same gates on Node 20/22/24.

## Gate results (from the final verify:release run)

| Gate                                                                                     | Result                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| format:check (prettier)                                                                  | clean                                                                                                                                                                                                |
| lint (eslint)                                                                            | clean, 0 errors/warnings                                                                                                                                                                             |
| typecheck (tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes) | 0 errors                                                                                                                                                                                             |
| test (vitest, all projects)                                                              | **59 files, 897 tests, all passed** (151.3s)                                                                                                                                                         |
| coverage (unit project)                                                                  | **100% statements (1964/1964), 100% branches (1336/1336), 100% functions (421/421), 100% lines (1785/1785)** on `src/**` — 55 files, 872 tests. No exclusions, no `istanbul ignore`, no empty tests. |
| build                                                                                    | tsc build + vite GUI bundle OK (29 modules, 116ms)                                                                                                                                                   |
| pack:check                                                                               | tarball OK (384 entries), publish dry-run OK                                                                                                                                                         |
| plugin-test                                                                              | **PASS on all 3 targets** — current (opencode 2.2.5), 2.2.1, latest (opencode 2.2.5)                                                                                                                 |
| e2e:web (Playwright)                                                                     | **37 passed, 0 failed, 5 skipped** (23.2s)                                                                                                                                                           |
| e2e:tui (Termwright)                                                                     | **6/6 passed** (run `863b1ee4-feef-4d1f-903f-2491b00450dd`)                                                                                                                                          |
| traceability                                                                             | **53 requirements, 69 declaring files, 32/32 E2E-applicable covered E2E — OK**                                                                                                                       |

## Test layers within the 897 passing tests

- Unit: every `src/**` module, 100% coverage.
- Property / state-machine (fast-check): classification totality, health-state legality, scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe ≡ Control decisions; pin wins; finite escalation budgets; one half-open probe; preferred resource returns only at a safe boundary), receipt no-secrets/boundedness.
- Integration: real seams with fake adapters (scheduler→health→state, retry veto policy, rpc validation, settings migration, restart round-trips, fail-open).
- Fault injection: deterministic fake provider (429 + Retry-After, quota/reset, 503, timeout, disconnect, malformed error, context rejection, recovery-after-N) + injected clock; concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
- Headless (ADP-045): 25 runtime E2E tests (supervision 8, lifecycle 7, routing 5, rpc 5) run against real `opencode serve` hosts with **no TUI/GUI surface loaded** — CONTROL recovery flows, failover, parks, receipts.
- Goal tests (ADP-041): the native `/goal` journey on a real host — "supervises a native /goal episode: fails over mid-goal and recovers at the next boundary" (lifecycle.test.ts) — plus unit/mode property tests for goal compatibility.

## Packed-plugin tests (ADP-040)

`npm run plugin-test` packs the plugin with `npm pack`, inspects the tarball, boots a real isolated OpenCode host per target, and asserts per target (9 checks each, all ✓ on 2.2.1 / 2.2.5-current / 2.2.5-latest): packed-artifact integrity, plugin-registration, plugin activates with the expected id (`coool.adaptive`), typed rpc returns install defaults, typed rpc applies a settings patch, typed rpc status mirrors settings, receipts.list starts empty, unknown rpc method rejected, host session apis remain available.

## Playwright Web E2E (ADP-042/044)

42 tests across chromium (desktop 1280×800), chromium-narrow (390×844), webkit. 37 passed, 0 failed; the 5 skipped are conditional narrow-project skips: the host's settings tablist is structurally collapsed at 390px, so tab-driven journeys are not applicable there — narrow coverage is asserted through the collapsed-layout equivalents (settings page renders, tabpanel visible, "Back to app" affordance, bottom-sheet tab dialog). No coverage is skipped away. Covered journeys: connection (first install, wrong password, keyboard operability), settings surfaces, models catalog search + empty state, plugin listing, plugin RPC integration (settings read/patch/reload persistence, invalid patch rejection, status mirroring), cross-surface sync both directions (web→TUI live, TUI→web after reload), and the GUI-mount limitation canary (no Adaptive settings surface mounts in the browser-served app on 2.2.5).

## Termwright TUI E2E (ADP-043)

9/9 passed on a real PTY with the packed plugin mounted from the sandbox's global config: boot/first-run, keyboard-only palette navigation, the `/adaptive` dialog flow driven end-to-end (first-run invitation confirmed, status alert with the observe snapshot, observe→control mode switch verified by re-reading the status after closing and reopening the flow, receipts empty-state alert, Escape cancellation at every dialog level), session turn, narrow/normal/wide layouts. Sandbox requirements established empirically on 2.2.5: the plugin must be configured in the HOME-based global config (`~/.config/opencode/opencode.json`) for the TUI to mount its bundle and resolve its RPC (a project-local entry registers the command but every rpc call fails with `rpc.unavailable`; the `$XDG_CONFIG_HOME` config file is not consulted for plugin discovery), and the keymap layer needs `mode: "global"` (fixed in `src/tui.ts`).

## Packaging validation (ADP-048/050)

`npm run pack:check`: real `npm pack` tarball (384 entries) — all 10 required files present (four exports + `.d.ts` files, LICENSE, README, manifest); forbidden-content scan clean (no `src/`, `test/`, `docs/`, `scripts/`, `node_modules`, `GOAL.md`, `coverage/` in the tarball — only LICENSE/README/package.json outside `dist/`); manifest name/semver/MIT verified; `npm publish --dry-run` OK. Artifact: `test-artifacts/pack-check.json`. Static publish contract additionally asserted by `test/package.test.ts` (exact exports key set, MIT, minimal runtime dependencies).

## Visual inspection

Real screenshots of both surfaces captured and inspected (kept under gitignored `test-artifacts/visual/` per the GOAL rule — not committed): web connect form, password focus ring, wrong-password error state, home empty state, settings tabs, models search, plugins listing, narrow home + bottom-sheet dialog, disconnect state; TUI boot home, command palette, session reply. No Adaptive-owned visual defects found (hierarchy, spacing, alignment, mobile, wrapping, focus, keyboard, empty/error states, copy). Details in `docs/TASKS.md` T-31.

## Hygiene checks (GOAL publish-ready checklist)

- No TODO/FIXME/XXX/HACK placeholders remain (`grep` over `src/`, `scripts/`, `test/` — zero matches).
- No `.only` / `.skip` / `.fixme` in vitest suites (zero matches); the only E2E skips are the 5 documented conditional narrow-project skips described above.
- No known flaky tests: zero retries in all E2E; flaky tests are treated as bugs and were fixed (e.g. scheduler draining oracle in T-21, receipt polling under instrumentation in T-28).
- No known release-blocking bug remains: the T-32 adversarial review found 5 defects, all fixed with failing-first regression tests kept permanently.

## Known limitations

- **OpenCode 2.2.5 plugin GUI surface:** the browser-served web app does not load plugin GUI bundles, so the Adaptive settings page does not mount there (covered by an inverted canary test; the page's copy/DOM is asserted at unit level; mounts on the desktop shell's experimental GUI surface).
- **Termwright PTY backend is darwin-only** (`@termwright/pty-darwin-arm64`); the CI `tui-e2e` job therefore runs on macOS.
- **Capacity sensing is best-effort:** WebSocket-native providers (OpenAI OAuth/Codex) bypass the `http.request/response` hooks OpenCode exposes; header-based capacity views are never load-bearing.
- **By design:** no cross-tier borrowing (a tier exhausted means work waits or parks); no de-escalation of a running episode; no failback mode; no telemetry.
