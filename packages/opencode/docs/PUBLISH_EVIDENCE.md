# Publish evidence

## Release 1.5.0 — 2026-11-07

`npm run verify:release` completed successfully on the 1.5.0 working tree,
including the quota-parked work wake timer, cross-instance resume ledger,
waiting indicators, and regression fixes documented in CHANGELOG.md.
Two independent subagent reviews were completed and their findings addressed.
Regression tests for the key behavioral fixes were also verified to fail when
the corresponding fix was temporarily reverted, then pass after restoration.

The formatting step temporarily excluded the user-owned, untracked `reports/`
and `research_notes/` directories. Their contents were not changed. The
original `.prettierignore` was restored after the gate; no release source or
test file was excluded from verification.

## Gate results

| Gate         | Result                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| format:check | Clean for release files (research-directory exception above)                                                             |
| lint         | Clean                                                                                                                    |
| lint:biome   | Clean, `--error-on-warnings`                                                                                             |
| typecheck    | Clean, strict TypeScript                                                                                                 |
| test         | **88 files, 1420 tests passed** (1365 unit + 55 runtime E2E)                                                             |
| coverage     | **100% statements (3655/3655), branches (2389/2389), functions (831/831), lines (3191/3191)**; 75 files, 1365 unit tests |
| build        | TypeScript build and Vite GUI bundle passed                                                                              |
| pack:check   | **355 tarball entries**, required exports present, forbidden-content scan and publish dry-run passed                     |
| plugin-test  | Passed on **2.2.1**, current **2.2.5**, latest **2.2.6**                                                                 |
| e2e:gui      | **68 passed**; **100% statements (619/619), branches (321/321), functions (181/181), lines (493/493)**                   |
| e2e:web      | **57 passed**, desktop Chromium, narrow Chromium, WebKit                                                                 |
| e2e:tui      | **23 passed**, Termwright run `ce7ac925-5bcd-4567-a9c1-afada24423b3`                                                     |
| traceability | **55 requirements, 99 declaring files, 35/35 E2E-applicable requirements covered**                                       |

Node v26.4.0 ran the normal gates; the release script selected the certified
Node v24.15.0 installation for Termwright. Machine-readable packaging,
traceability and UI artifacts are under the gitignored `test-artifacts/`.

## Feature and regression evidence

- Real-host wake tests prove a session whose whole tier exhausts quota resumes
  without another user prompt, survives a host restart, and continues once
  with a double-loaded plugin.
- Deterministic supervisor tests cover bounded resume cycles, failed-delivery
  backoff, give-up receipts, concurrent resumes, takeover during pop/settle,
  user cancellation, prompt-less runs, disposed instances, and cross-instance
  continuation ownership.
- Pure planner and property tests cover quota/rate-limit windows, breaker
  cooldowns, exhausted capacity, unknown resets, capped timers and backoff.
- GUI journeys run against both source and the built experimental bundle,
  using a stand-in GUI host and real OpenCode server RPC. They include waiting
  pill states, reset-time labels and clearing the wait.
- Existing native `/goal`, durable continuation, provider failure, manual
  selection, RPC, web command, and TUI regression suites remain passing.

## Known limitations

- **Cross-instance settings:** double-loaded plugin instances retain separate
  settings caches; changing one does not automatically refresh the other.
  GUI E2E setup configures both instances explicitly. This predates 1.5.0.
- **Pinned-model quota exhaustion:** a pinned model has no tier-based parked
  continuation; this release's wake feature applies to tier-routed work.
- **Experimental GUI:** plugin GUI mounting is unavailable on the shipped hosts
  previously inspected. Composer pills and GUI flows are verified through a
  stand-in GUI host, not a shipped GUI renderer. TUI and typed RPC remain usable.
- **Termwright:** the installed PTY backend is macOS-specific.
- **Capacity sensing:** best-effort; WebSocket-native providers can bypass HTTP
  response hooks.
- No hidden cross-tier borrowing, mid-episode de-escalation, or telemetry.

This gate performed a publish dry-run only. It did not publish to npm.
