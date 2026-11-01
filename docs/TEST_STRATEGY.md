# Test Strategy

Deterministic by construction: injected clocks everywhere; no sleeps; no paid models.

## Layers

1. **Unit** — every module in PLAN Step 1–4; 100% statement/branch/function/line coverage gate on first-party code (ADP-037). No blanket excludes; entrypoints (`index.ts`, `tui.tsx`, `gui.tsx`) are covered through wiring tests, not excluded.
2. **Property / state-machine** — `fast-check` (ADP-038): classification totality; health-state legality; scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe≡Control decisions; Observe never changes execution; pin wins; no silent downgrade; finite budgets terminate; one half-open probe; preferred resource returns only at a safe boundary); receipt no-secrets/boundedness.
3. **Integration** — real seams with fake adapters: scheduler→health→state; retry hook policy→adapter; rpc validation; settings migration; restart round-trips; fail-open (throwing dependencies → defer).
4. **Fault injection** — deterministic provider fixture + clock: 429, quota reset, 503, timeout, disconnect, malformed error, context overflow, auth failure, recovery-after-N, concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
5. **Packed-plugin** — `@coool/opencode-plugin-test` packed mode against real isolated OpenCode hosts: targets 2.2.1, current, latest; surfaces server/tui/rpc; behavioral scenarios (routing defer in Observe, settings round-trip via rpc, receipt generation) — not just "plugin becomes active" (ADP-040).
6. **Server E2E (real host + fake provider)** — runtime scenario list below (ADP-041).
7. **Web E2E (Playwright)** — real OpenCode Web UI + packed plugin; Chromium + WebKit; desktop + narrow viewports; semantic locators; zero retries; screenshot checks as secondary assertions (ADP-042).
8. **TUI E2E (Termwright)** — real PTY; 80x24 / narrow / wide; `wait_for_idle` conditions only; failure artifacts captured (ADP-043).
9. **Cross-surface E2E** — Web→TUI and TUI→Web settings sync (ADP-044).
10. **Headless** — full CONTROL recovery flow with no UI surface loaded (ADP-045).

## Runtime E2E scenarios (ADP-041)

Real-host coverage (`test/runtime-e2e/` against `opencode serve` + the fake provider; supervision, routing, lifecycle, rpc files):

Quick routing, Standard routing, Advanced routing, agent-tier hint (warm-up + warm session) and explicit pin override (routing); Observe mode, Control mode, Observe≡Control decision parity (supervision); same-tier fallback, short throttling + Retry-After (supervision quota/rate-limit flows); provider outage, circuit breaker, single half-open probe, parking before dispatch (lifecycle breaker; supervision parks); tier escalation on context overflow (lifecycle 413 → escalate → owned continuation); quota exhaustion and its native-retry exemption (lifecycle); restart while parked, resume after recovery (lifecycle persisted-parked restart); durable tool side effects through owned recovery without replay (lifecycle marker file); multiple concurrent sessions (supervision); subagent children supervised as their own units (lifecycle subagent); user cancellation never fails over (supervision); fail-open on corrupted persisted settings (routing); headless execution (every scenario runs on bare `opencode serve` with no UI surface — ADP-045 by construction); RPC surface defaults/persistence/validation/receipts (rpc).

Documented limitations (minimal proofs per GOAL):

- **Draining** is unit-covered only: the drain health event has no runtime emitter in the host wiring (verified by source search); no runtime trigger exists.
- **Variant/effort escalation** is unit-covered: escalating at runtime requires a model inventory entry with a variant ladder; the fake provider's host config exposes none, and strength is never guessed from variant names (ADP-004).
- **Native `/goal` through a mid-goal model transition** is impossible on host 2.2.5: goal auto-continuation turns run inside one execution unit with no prompt hook and no execution boundary between them; the lifecycle /goal test instead proves the GOAL.md flow (goal starts → preferred fails → veto → owned recovery continues the goal on the fallback → completes → preferred again at the next boundary) and records the limitation.

## Web E2E journeys (ADP-042)

First install/Observe default; open settings; add model; search; variants; reorder; remove; validation; save; reload persistence; Observe→Control; Control→Observe; shared server settings; health/status display; quota/draining display; unavailable display; recovery display; server disconnect/reconnect; settings synchronization; keyboard accessibility; empty states; error states.

## TUI E2E journeys (ADP-043)

`/adaptive`; first-run state; Observe/Control switch; model search; selection; reorder; remove; save; persistence; navigation; Escape/cancel; keyboard-only; status inspection; health/recovery state; validation errors; server restart/reconnect.

## Deterministic fake provider (ADP-039)

Local OpenAI/OpenCode-compatible HTTP+SSE server scripting: success, streaming, tool calls, partial execution, 429 (+Retry-After), quota/reset headers, 503, timeout, disconnect, malformed response, context rejection, recovery after N calls. Real OpenCode talks to it in E2E; unit/integration layers use in-process fakes typed against the same shapes.

## Traceability (ADP-047)

- Tests and E2E scenarios declare `covers: ["ADP-xxx"]` metadata.
- `scripts/traceability` scans test metadata vs REQUIREMENTS.md; CI fails if any E2E-applicable requirement lacks E2E coverage or any requirement lacks any coverage; emits a report artifact.

## Coverage (ADP-037)

Vitest + V8 coverage, thresholds 100/100/100/100 on first-party `src/**`. Only genuinely generated/vendor code may be excluded, clearly identified. No `istanbul ignore`, no empty tests, no implementation-trivia assertions.

## Regression policy (ADP-046)

Every behavioral bug: failing-first test → fix → wider suite → keep test forever. Enforced in CONTRIBUTING.md and applied throughout the project including the final adversarial review.

## Flakiness rules

Zero retries in E2E; a flaky test is a bug (regression-test it or fix the nondeterminism); all waits are condition-based (`session.wait`, Termwright `wait_for_idle`, Playwright auto-waiting).
