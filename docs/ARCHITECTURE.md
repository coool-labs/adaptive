# Architecture

One server-side plugin process per OpenCode instance. Everything decision-bearing is pure or server-local; TUI/GUI are thin views over typed RPC.

## Module boundaries

```text
src/
  core/
    work-unit/       episode tracking from session events (pure state machine)
    tier-policy/     routing priority ladder, tier semantics adapter (ecosystem names isolated here)
    compatibility/   context-capacity/tool/modality/availability gate (pure)
    scheduler/       pure deterministic decision core: candidates → compatibility → health → policy
  health/
    classifier/      error → structured classification (metadata > status > headers > bounded text)
    resource-health/ hierarchical health store, draining, half-open circuit breaker
    circuit-breaker/ probe arbitration (exactly one concurrent probe)
    capacity/        CapacitySensor boundary + registry
  execution/
    retry/           retry-hook policy: veto for owned recovery, defer to OpenCode otherwise
    continuation/    safe-boundary continuation, partial-work safety
    parking/         park/resume lifecycle
    recovery/        preferred-resource eligibility at safe boundaries
  adapters/
    opencode/        all @opencode/plugin calls: events, session ops, inventory, storage, hooks
    codex-capacity/  optional Codex/ChatGPT capacity sensor (passive headers first)
  state/
    settings/        versioned settings + migration
    receipts/        bounded decision receipts
    parked-work/     durable parked units
  rpc/               typed RPC contracts shared by surfaces
  ui/
    flow/            /adaptive dialog flow + view models, shared by TUI and GUI (host-agnostic)
    gui/             GUI host adapters: RPC client, dialog view, models, settings page (view layer only)
  index.ts           server plugin wiring
  tui.tsx            TUI entrypoint (dialog-driven; one JSX exception: the footer status chip, rendered through host UI slots with @opentui/solid — the host's own slot pattern)
  gui.tsx            GUI entrypoint
  rpc.ts             RPC entrypoint
```

Dependency rules: `core` imports nothing from `adapters`/`ui`/`state`; `scheduler` is pure (clock and inventory injected); `ui/*` never implements routing; only `adapters/opencode` touches `@opencode/plugin` APIs.

## Execution lifecycle

1. **Admission / routing.** `session.execution.started` opens a work unit. The scheduler runs: required tier ← priority ladder (pin > tier request > role hint > deterministic evidence > `standard`, or `defer`); candidates ← tier list; compatibility gate; health/preference ranking. In `active` (control) the chosen model is applied (`session.switchModel`) at this safe boundary; in `observe` the identical decision is only recorded as a receipt. `defer`/`off`/internal failure ⇒ OpenCode's own choice stands.
2. **Supervision.** Tool continuations stay in-unit (`step.*` events do not close the unit). Subagents are separate units sharing health.
3. **Failure.** `classifier` turns the structured error into scope/category/retry-hint/confidence/source. The `retry` hook decides: infra failure with a healthy same-tier candidate → veto native retry (`{retry:false}`) and perform native continuation (`session.wait` → inventory re-check → `switchModel` → resume within the session, never a replayed original prompt); otherwise leave OpenCode's native retry decision untouched.
4. **Escalation.** Only structured capability evidence escalates, to the first configured resource of the next tier, within a finite per-task budget (one user prompt and its continuations). A same-model stronger-variant rung would need an ordered variant ladder the host does not expose; strength is never guessed from names.
5. **Termination.** `succeeded`/`failed`/`interrupted` close the unit; receipts are written; parking/recovery evaluate at this safe boundary. `interrupted{reason:'user'}` never triggers failover.

## Resource-health model

Hierarchy provider → account → model → variant; each node holds a discriminated state:

```text
healthy ──(429 short)──────────→ rate_limited ──(Retry-After)──→ healthy
healthy ──(quota definitive)───→ quota_exhausted ──(reset)─────→ half_open → probe → healthy | unavailable
healthy ──(capacity sensor)────→ draining ──(exhausted)───────→ exhausted
healthy ──(outage/timeout 503)─→ unavailable ──(cooldown)──────→ half_open → probe → healthy | unavailable
any ────────────────────────────(ambiguous, narrow evidence)──→ degraded (eligible, deprioritized)
```

Rules: quarantine at the narrowest justified scope (a model 429 never takes down the provider; a provider-wide 429 takes down all its models); classifier confidence gates how far up the hierarchy a quarantine propagates; ambiguous evidence degrades, never blacklists (ADP-012); 429s do not count toward breaker trip counts.

**Circuit breaker:** `unavailable` + cooldown expiry → `half_open`; exactly one in-flight probe is admitted (single-flight guard inside `circuit-breaker/`); concurrent callers either join the probe's outcome or stay rejected without new requests. Probe success → `healthy`; failure → `unavailable` with a new cooldown. Verified under real concurrency (ADP-019).

**Draining:** a CapacitySensor with high-confidence near-exhaustion evidence marks `draining`: in-flight work finishes, no new admission when an equivalent healthy configured resource exists; equivalent = same tier, compatible, healthy. No sliders.

## Scheduler

Pure function: `(settings, inventory, health, capacity, request context, clock) → Decision`. Decision is a discriminated union: `{kind:'apply', model, reason, evidence} | {kind:'defer', reason} | {kind:'park', reason} | {kind:'escalate', …} | {kind:'observe-only', would: Decision}`. `observe` and `active` call the same core; `observe` wraps the result without applying. Escalation budgets and breaker state are inputs, so the core stays deterministic; effects (switches, receipts, park) are applied by the execution layer.

## Persistence ownership

All durable state goes through `ctx.storage` (OpenCode-owned, survives restart), keyed `coool.adaptive/…`: `settings` (versioned, migration-on-read), `receipts` (bounded ring, oldest evicted), `parked-work` (durable continuation records). No filesystem, no separate store. Nothing secret is persisted (ADP-051).

## Server / TUI / GUI / RPC boundaries

Typed RPC (`rpc/`) is the only channel: settings get/set, status/health snapshot, receipts list, mode/tier/pin actions. TUI and GUI hold no local settings state; they render server snapshots and stream updates (`settings.changed`, `health.updated` events). Server restart ⇒ surfaces re-fetch on reconnect; GUI handles disconnect gracefully (ADP-034).

## Capacity sensor boundary

```ts
interface CapacitySensor {
  resource: ResourceRef
  read(): CapacityReading | null // { usedRatio?, remainingRatio?, retryAfterMs?, resetAt?, confidence, evidence }
}
```

`adapters/codex-capacity` implements it from passive response headers (x-codex-* / Retry-After) observed via `http.response` (body cloned once) and, where available, `experimental.ws.*`; a direct quota endpoint is optional, isolated, documented as unstable, and never load-bearing (ADP-020). `null` ⇒ no estimate; the scheduler never guesses.

## Fail-open strategy

Every external interaction in `adapters/` and optional sensors is wrapped: internal exception → log + notify (toast/receipt, throttled) → decision becomes `defer` and native OpenCode behavior proceeds. Privacy/user restrictions (configured-provider allow-list) fail closed. The wrapper is itself tested with injected throwing dependencies (ADP-031).

## Concurrency strategy

Single-threaded plugin host; shared mutable health/settings live in one server-owned store guarded by sequential event handling; async session operations are serialized per session via an operation queue so failed-execution settling is never raced (`session.wait` before any switch; timestamps compared, per competitor lessons). Breaker probe admission is a synchronous single-flight check.

## Restart behavior

Stateless in memory: health, parked work, settings, receipts are rebuilt from storage on setup. A unit interrupted by shutdown is marked interrupted; parked units resume when their resource probes healthy after restart. Parked records carry session/prompt references sufficient for clean continuation — never a promise of resurrecting a dead HTTP call (ADP-024).

## Experimental API isolation

All experimental surfaces (`experimental.idle`, `experimental.ws.*`, GUI surface) are reachable only from `adapters/opencode` and `ui/gui`, each behind a narrow interface documented as experimental in code; core modules compile and test without them.

## Privacy and threat model

Adaptive is a local supervisor: it makes no outbound network calls of its own and sends no telemetry. The threats it defends against are all local:

- **Secrets never enter durable state or prompts.** Receipt and parked-work free text is vocabulary-checked and truncated (`MAX_RECEIPT_TEXT`); provider header capture uses a fixed allowlist that can never match `authorization` or credential-bearing headers; the only prompt the plugin ever sends is the fixed continuation prompt, so receipts, decisions, and metadata cannot reach a model call.
- **Untrusted inputs are narrowed, not trusted.** Provider data (status lines, `Retry-After`, bodies) is parsed defensively and bounded (24 h Retry-After cap, 512-byte body excerpt); persisted plugin state is validated on load — corrupt settings degrade to defaults, invalid receipts/parked records are dropped, never coerced.
- **RPC is the only remote-control surface** (settings.get/set, status.get, receipts.list), schema-gated on the wire, and exposes no credentials or host capabilities; surfaces hold no state and cannot act beyond patching settings.
- **Failure policy is direction-aware:** internal Adaptive failures fail open (log, defer to ordinary OpenCode behavior) so the plugin can never wedge a session; privacy and configured-provider restrictions fail closed (only user-configured resources are ever eligible).
