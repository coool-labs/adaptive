# Requirements

Every requirement is objectively testable. IDs are stable; tests declare `covers: ["ADP-xxx"]` and a CI gate fails if any E2E-applicable requirement has no E2E mapping (see TEST_STRATEGY.md §Traceability).

## Work units and routing

- **ADP-001** — A work unit is exactly one OpenCode execution episode: from `session.execution.started` to `succeeded`/`failed`/`interrupted`. Tool continuations stay in the same unit; a subagent execution is a separate unit; a later goal continuation is a new unit.
- **ADP-002** — Routing priority is: explicit user/model pin → explicit tier request → supported role hint → deterministic local evidence → default `standard`. Ambiguity resolves to `standard`.
- **ADP-003** — The router can return `defer`, meaning Adaptive gives no reason to override ordinary OpenCode behavior; a deferred unit keeps OpenCode's model choice.
- **ADP-004** — No LLM call and no keyword-list classifier participate in routing decisions.
- **ADP-005** — Tiers are `quick`, `standard`, `advanced`, each an ordered list of user-configured resources; list order is user policy and is never reordered by Adaptive heuristics.
- **ADP-006** — A resource is identified by provider / account (when observable) / model / variant (reasoning effort). Similar model names across providers are never treated as equivalent unless the user configures both.

## Health and error classification

- **ADP-007** — Resource health is hierarchical (provider → account → model → variant) with discriminated states `healthy | draining | degraded | rate_limited | quota_exhausted | unavailable | half_open`; quarantine applies at the narrowest scope the evidence justifies.
- **ADP-008** — Error classification precedence: structured OpenCode/provider metadata → HTTP status/code → `Retry-After`/reset headers → documented provider-specific metadata → bounded textual classification as last resort only.
- **ADP-009** — The classifier distinguishes at least: short rate limiting, fixed-window quota exhaustion, provider outage, temporary overload, timeout, authentication failure, invalid model, context overflow, content/policy rejection, user cancellation, unknown.
- **ADP-010** — User cancellation never triggers failover or retry.
- **ADP-011** — All retry/escalation loops are finite and provably bounded; permanent configuration/authentication errors never enter retry loops.
- **ADP-012** — Ambiguous failures do not blacklist an entire provider when narrower evidence exists.

## Recovery behavior

- **ADP-013** — Infrastructure failure (429, quota, timeout, 503, outage) never escalates capability tier; it triggers horizontal recovery within the required tier.
- **ADP-014** — Horizontal recovery prefers OpenCode-native retry/model-switch; Adaptive never aborts and replays the original user request once tool side effects exist; completed side effects are treated as durable.
- **ADP-015** — Capability escalation (variant → stronger variant → stronger tier) happens only on structured evidence, prefers same-model stronger variant first, and uses finite per-work-unit budgets with no escalation loops.
- **ADP-016** — Routing happens fresh at each safe work-unit boundary; there is no de-escalation engine and Adaptive never pulls a healthy resource away mid-work to save cost.
- **ADP-017** — A compatibility gate (context capacity, tool use, modalities, model/variant/provider availability) filters candidates before health/preference ranking; only user-configured resources are ever eligible.
- **ADP-018** — Preferred-resource recovery: configured order is unchanged; a recovered preferred resource becomes eligible at the next safe boundary; healthy running work is never interrupted for failback.
- **ADP-019** — Circuit breaker: `unavailable` → recovery time → `half_open` → exactly one probe → `healthy` or back to `unavailable`. Concurrent callers cannot create a thundering herd (verified under real concurrency).
- **ADP-020** — Capacity is observed through a `CapacitySensor` boundary (used/remaining ratio, retry-after, reset time, confidence). Codex/ChatGPT support prefers passive header data; if no trustworthy telemetry exists, no estimate is produced. Provider-specific logic stays out of the scheduler.
- **ADP-021** — Draining: `healthy → draining → exhausted` where `draining` admits no new work when an equivalent healthy configured resource exists; no user-facing threshold sliders.
- **ADP-022** — No hidden cross-tier borrowing: if a tier has no available resource, work parks/waits unless escalation was independently justified.
- **ADP-023** — Partial-work safety: after tool side effects, Adaptive prefers native continuation; if the retry lifecycle cannot continue, it starts a clean continuation work unit from existing session/workspace state and never replays the original instruction.
- **ADP-024** — Durable park/resume: work with no compatible healthy resource before dispatch is parked with persisted state that survives restart; resumption is a clean continuation, not resurrection of a failed network call.

## OpenCode compatibility and control

- **ADP-025** — Native `/goal` keeps working while Adaptive is enabled; Adaptive implements no goal engine and survives model transitions during a goal.
- **ADP-026** — Subagent executions are routed independently and share health state; Adaptive never restructures execution topology.
- **ADP-027** — Auxiliary requests (compaction/title/generate/summary-class) do not consume an unnecessarily expensive tier.
- **ADP-028** — Users can disable Adaptive, switch modes, explicitly request a tier, pin the current resource, and inspect why a decision was made; manual intent always wins and Adaptive never fights manual model changes.
- **ADP-029** — Modes `OFF | OBSERVE | CONTROL`; OBSERVE is the default after install and never changes execution; OBSERVE and CONTROL run the identical scheduler implementation.
- **ADP-030** — Decision receipts persist bounded local records (work/session identity, required tier, selected resource, decision type, reason, rejected candidates, health/capacity evidence, escalation evidence, outcome, timestamp); no secrets, never injected into prompts; bounded retention; nothing leaves the machine.
- **ADP-031** — Adaptive fails open: internal failures (sensor, receipts, GUI, unknown metadata, optional adapter) log/notify and defer to ordinary OpenCode behavior, except privacy/user restrictions which may fail closed.
- **ADP-032** — First install defaults to OBSERVE with one concise dismissible configuration invitation; no repeated startup toasts.

## UX

- **ADP-033** — The TUI exposes `/adaptive` with tiered model lists supporting search over real OpenCode models, variant selection, reorder, remove, immediate validation, clear unavailable-resource display, keyboard-only operation, and graceful narrow terminals.
- **ADP-034** — The GUI provides a native OpenCode SettingsPage via the experimental GUI plugin surface; no separate localhost website; the GUI adapter is thin, uses typed RPC, and handles server disconnect/restart.
- **ADP-035** — The Web UI is usable at desktop and narrow/mobile widths.
- **ADP-036** — The server is the single source of truth: settings changed in one surface are visible in the other; state is versioned with defined migration from empty/new state.

## Engineering and quality gates

- **ADP-037** — First-party production code reaches 100% statement/branch/function/line coverage with no exclusion gaming; generated/vendor code only if clearly identified.
- **ADP-038** — Property/state-machine tests prove the invariants: unavailable/incompatible resources never selected; availability failures never escalate capability; Observe and Control produce identical decisions; Observe never changes execution; user pin wins; no silent downward capability shift; finite budgets cannot loop; half-open admits exactly one probe; preferred resources return only at safe boundaries; no impossible health transitions.
- **ADP-039** — A deterministic fake OpenAI/OpenCode-compatible provider fixture scripts: success, streaming, tool calls, partial execution, 429, Retry-After, quota/reset headers, 503, timeout, disconnect, malformed response, context rejection, recovery after N calls. No paid models in automated suites.
- **ADP-040** — Packed-plugin tests run the `npm pack` artifact against real isolated OpenCode hosts on 2.2.1, current, and latest, across server/tui/rpc surfaces, with behavioral scenarios.
- **ADP-041** — Real-host E2E covers the runtime scenario list in TEST_STRATEGY.md §Runtime scenarios (including native `/goal` through a model transition), using the fake provider.
- **ADP-042** — Playwright Web E2E against the real OpenCode Web UI with the packed plugin: Chromium + WebKit, desktop + narrow viewports, semantic locators, zero retries.
- **ADP-043** — Termwright TUI E2E over a real PTY at 80x24, narrow, and wide sizes, asserting semantic state, keyboard-only flows, and capturing failure artifacts.
- **ADP-044** — Cross-surface sync E2E proves settings changed in Web are visible in TUI and vice versa.
- **ADP-045** — Core scheduling/resilience works headless without TUI/GUI present.
- **ADP-046** — Regression policy: every behavioral bug gets a failing-first regression test; documented in CONTRIBUTING.md and followed for the whole project.
- **ADP-047** — Machine-checkable requirements traceability: tests declare covered requirement IDs; an automated gate fails if any E2E-applicable requirement lacks E2E coverage.
- **ADP-048** — Package publishes correctly: exports `.`, `./tui`, `./rpc`, `./gui-experimental`; `npm pack` and `npm publish --dry-run` pass; tarball inspected; minimal runtime dependencies; MIT license.
- **ADP-049** — CI gates format, lint (ESLint and Biome), strict typecheck, unit/integration tests, 100% coverage, property tests, packed-plugin tests, Playwright, Termwright, traceability, build, pack, dry-run; no paid credentials required.
- **ADP-050** — `npm run verify:release` runs the complete publish-readiness gate in one command.
- **ADP-051** — Security/privacy: no telemetry, no user content to unconfigured providers, no credentials exposed to TUI/browser, capacity adapters run server-side, no secrets persisted, RPC inputs validated, persisted data bounded, threat model documented.
- **ADP-052** — Prompt overhead: no LLM classification call, no repeated large routing prompts, operational metadata kept out of the conversation where current APIs allow.
- **ADP-053** — The pure scheduling path is deterministic and inexpensive; representative-fixture measurements catch pathological overhead, not nanoseconds.
- **ADP-054** — Per-session operating-mode override with the global mode as default: a session's effective mode is its override when one is set, else the global mode; every session-scoped supervision decision (prompt admission, execution-started fallback, retry gating, escalation wrapping, idle resume, observe wrapping) consults the effective mode. Overrides persist, are pruned when the session dies, and are managed through typed RPC and the `/adaptive` menu inside a session.
- **ADP-055** — Tier requests: an agent (or user via typed RPC) can request a tier for the current task through the `adaptive_tier` tool; the request is sticky per-session (bounded, insertion-order evicted, pruned when the session dies), participates in admission between user pin and default hints, defers with a `tier-not-configured` reason when the requested tier has no configured resources, and is cleared by passing a null tier. The control surface mirrors the session-mode contract: `tier-request.get`/`tier-request.set` methods with the `tier-request-changed` event, per-field validation errors for an unknown tier or a bad sessionID, and fail-open degradation on internal write failures. Inside a session the `/adaptive` menu has a Tier entry that reads and sets the session's requested tier over those methods. Runtime E2E proves a live agent-driven tier request reroutes a session, that an unconfigured tier request defers without touching routing, and that an RPC-pinned tier steers only its own session while a second session keeps the ordinary ladder until the request is cleared.
- **ADP-056** — Sensed capacity is visible in the control surfaces: every configured resource's status row shows the sensed usage window — a rounded used percent and the wall-clock reset time — whenever the passive capacity sensor holds a fresh reading, and nothing extra when it does not. Readings observed from response headers are persisted through a bounded capacity mirror (newest observation per resource wins, write failures fail open), so the instance serving `status.get` reports what any instance observed — the TUI host loads the plugin twice and the event pump and the RPC server can be different instances. Runtime E2E proves a completed turn whose response carries x-codex usage headers surfaces as `used N%` with a reset time in that resource's status row.
