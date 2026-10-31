# Tasks

Checkbox format: objective / boundary / tests required / acceptance. IDs are stable (T-xx). Order = dependency order per PLAN.md.

## Phase A — Toolchain

- [ ] **T-01 Package scaffolding** — Objective: publishable package skeleton. Boundary: package.json (name `@coool/opencode-adaptive`, exports `.`,`./tui`,`./rpc`,`./gui-experimental`, MIT), tsconfig strictest (GOAL list + noUncheckedIndexedAccess, exactOptionalPropertyTypes), vitest + c8/v8 coverage config, eslint (bans `any`, `@ts-ignore`), prettier, LICENSE, .gitignore incl. `.scratch/`, npm scripts incl. `verify` composition. Tests: config smoke (typecheck/lint run green on a trivial module). Acceptance: `npm run typecheck && npm run lint && npm test` green; `npm pack` produces a valid empty-but-valid artifact.
- [ ] **T-02 CI skeleton** — Objective: workflow running format/lint/typecheck/test on push. Boundary: `.github/workflows/ci.yml` (Linux + macOS job for core tests). Tests: workflow lint (actionlint or equivalent). Acceptance: workflow syntax valid; gates wired to expand later.

## Phase B — Pure core

- [ ] **T-03 Error classifier** — Objective: structured classification (ADP-008/009/010/011). Boundary: `src/health/classifier/`. Tests: unit per category incl. precedence cases; property test — classification total (never throws, always a category) over generated error shapes. Acceptance: 100% coverage of module; user cancellation maps to non-failover category.
- [x] **T-04 Resource health + circuit breaker** — Objective: hierarchical states, draining, half-open single probe (ADP-007/019/021). Boundary: `src/health/resource-health/`, `src/health/circuit-breaker/`, injected clock. Tests: unit transitions; property: no impossible transitions (ADP-038); concurrency test with real Promise scheduling proving exactly one probe. Acceptance: 100% coverage; thundering-herd test passes.
- [x] **T-05 Capacity boundary** — Objective: CapacitySensor merge semantics (ADP-020). Boundary: `src/health/capacity/`. Tests: unit merge/confidence rules; null-reading ⇒ no estimate. Acceptance: 100% coverage.
- [x] **T-06 Work unit tracking** — Objective: episode state machine (ADP-001). Boundary: `src/core/work-unit/`. Tests: unit — tool continuation same unit, subagent separate, goal continuation new, terminal events close. Acceptance: 100% coverage.
- [x] **T-07 Tier policy** — Objective: priority ladder + defer (ADP-002/003/004/005). Boundary: `src/core/tier-policy/`. Tests: unit per priority level; ambiguity → standard; defer. Acceptance: 100% coverage.
- [ ] **T-08 Compatibility gate** — Objective: filter unexecutable candidates (ADP-017). Boundary: `src/core/compatibility/`. Tests: unit — context capacity, tools, modalities, variant/provider availability; unknown metadata ⇒ conservative. Acceptance: 100% coverage.
- [ ] **T-09 Scheduler** — Objective: pure decision core (ADP-013/015/016/022). Boundary: `src/core/scheduler/`; inputs only. Tests: unit scenarios per decision kind; property suite (ADP-038 full invariant list); escalate-budget termination proof. Acceptance: 100% coverage; Observe/Control identical-decision property green.

## Phase C — State and execution

- [ ] **T-10 Settings store** — Objective: versioned settings + migration (ADP-036/005). Boundary: `src/state/settings/` over storage interface. Tests: unit migration from empty/v0/vN; bounded shape validation. Acceptance: 100% coverage.
- [ ] **T-11 Receipts + parked work** — Objective: bounded durable records (ADP-030/024). Boundary: `src/state/receipts/`, `src/state/parked-work/`. Tests: unit bounds/eviction, restart-read round-trip, no-secret invariant property. Acceptance: 100% coverage.
- [ ] **T-12 Retry policy** — Objective: hook decision logic (ADP-013/014). Boundary: `src/execution/retry/`. Tests: unit — veto cases, native-defer cases, user cancellation, boundedness. Acceptance: 100% coverage.
- [ ] **T-13 Continuation / recovery / parking** — Objective: safe-boundary behavior (ADP-014/016/018/023/024). Boundary: `src/execution/{continuation,recovery,parking}/`. Tests: unit with fake session ops — never replay after side effects; park before dispatch; resume at recovery; no mid-work pull. Acceptance: 100% coverage.

## Phase D — Adapters and wiring

- [ ] **T-14 OpenCode adapter** — Objective: all v2 API touchpoints (research facts). Boundary: `src/adapters/opencode/`. Tests: unit against typed fixtures of @opencode/plugin surfaces; response-body clone-once; switch self-tagging. Acceptance: 100% coverage; typechecks against @opencode/plugin@2.2.5 types.
- [ ] **T-15 Codex capacity sensor** — Objective: passive-header sensor (ADP-020). Boundary: `src/adapters/codex-capacity/`. Tests: unit with scripted headers/ws frames; untrusted-header validation. Acceptance: 100% coverage; no scheduler import.
- [ ] **T-16 RPC contracts** — Objective: typed surface contracts (ADP-036). Boundary: `src/rpc/`. Tests: unit request/response validation incl. hostile inputs (ADP-051). Acceptance: 100% coverage.
- [ ] **T-17 Plugin wiring** — Objective: `index.ts` gluing hooks/events/store/scheduler with fail-open wrapper (ADP-031/045). Boundary: `src/index.ts`. Tests: integration — throwing sensor/receipts ⇒ defer + log; OFF mode inert. Acceptance: wiring covered (entrypoint included in coverage, no exclusions).
- [ ] **T-18 Escalation mechanism** — Objective: smallest typed escalation surface if API permits (GOAL §Capability escalation). Boundary: verify tool-registration support in @opencode/plugin; implement or document proven limitation. Tests: unit for schema (reason+evidence required); if unsupported, a pinned repro test proving the API shape. Acceptance: decision documented in code + docs; no fake fallback.

## Phase E — Surfaces

- [ ] **T-19 TUI** — Objective: `/adaptive` command, tiered editor, status/receipt views (ADP-033). Boundary: `src/tui.tsx`, `src/ui/tui/`. Tests: view-model unit tests; keyboard-flow model tests. Acceptance: view models 100% covered; entrypoint wiring covered.
- [ ] **T-20 GUI** — Objective: native SettingsPage, thin adapter (ADP-034/035). Boundary: `src/gui.tsx`, `src/ui/gui/`. Tests: component/view-model units; disconnect-handling unit. Acceptance: covered; no routing logic in UI.

## Phase F — Test infrastructure and E2E

- [ ] **T-21 Fake provider fixture** — Objective: deterministic scripted provider (ADP-039). Boundary: `test/fixtures/fake-provider/` (OpenAI/OpenCode-compatible server). Tests: fixture self-tests for every scripted scenario. Acceptance: all 13 scenario scripts reproducible.
- [ ] **T-22 Integration tests** — Objective: seams scheduler↔health↔state↔adapter↔rpc. Boundary: `test/integration/`. Tests: fault-injection matrix from TEST_STRATEGY. Acceptance: green with deterministic clock.
- [ ] **T-23 Packed-plugin tests** — Objective: packed artifact vs real hosts (ADP-040). Boundary: plugin-test config, packed mode, targets 2.2.1/current/latest, surfaces server/tui/rpc. Acceptance: behavioral scenarios (not just activation) pass on all targets.
- [ ] **T-24 Runtime E2E** — Objective: full runtime scenario list incl. native `/goal` through transition + headless (ADP-041/025/045). Boundary: real `opencode` host + fake provider. Acceptance: every listed scenario automated and passing.
- [ ] **T-25 Playwright Web E2E** — Objective: real Web UI journeys (ADP-042). Boundary: Chromium + WebKit, desktop + narrow, semantic locators, zero retries. Acceptance: journey list from TEST_STRATEGY green.
- [ ] **T-26 Termwright TUI E2E** — Objective: real PTY journeys (ADP-043). Boundary: 80x24/narrow/wide, wait_for_idle, failure artifacts. Acceptance: journey list green.
- [ ] **T-27 Cross-surface sync E2E** — Objective: server as source of truth (ADP-044). Boundary: both directions Web↔TUI. Acceptance: both journeys green.

## Phase G — Release

- [ ] **T-28 Traceability + coverage gates** — Objective: automated ADP-coverage and 100% gates (ADP-037/047). Boundary: `scripts/traceability` + CI steps. Acceptance: gate fails on any uncovered E2E-applicable requirement; report artifact generated.
- [ ] **T-29 Docs** — Objective: README (section list per GOAL), CONTRIBUTING with regression policy (ADP-046), CHANGELOG. Acceptance: docs accurate, no marketing prose.
- [ ] **T-30 Packaging + CI completion + verify:release** — Objective: ADP-048/049/050. Boundary: npm pack/dry-run validation script, full CI workflow, `verify:release`. Acceptance: single command green end-to-end locally.
- [ ] **T-31 UI visual inspection** — Objective: human-quality check of Playwright/Termwright screenshots (hierarchy, spacing, mobile, focus, empty/error states, copy). Acceptance: issues fixed with regression coverage; notes recorded.
- [ ] **T-32 Final adversarial review** — Objective: skeptical-maintainer pass (race conditions, duplicate side effects, retry loops, state drift, coverage gaming, flaky tests…). Acceptance: every defect fixed with failing-first regression test; full publish-readiness suite re-run.
- [ ] **T-33 PUBLISH_EVIDENCE.md** — Objective: real final verification evidence only. Acceptance: contains all GOAL-listed evidence items from actual runs.
