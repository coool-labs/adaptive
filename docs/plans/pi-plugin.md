# Plan: Adaptive for Pi (`@coool/pi-adaptive`)

Written 2026-11-08. This plan assumes the monorepo from `docs/plans/monorepo.md`: the
shared code lives in `packages/core` and this plugin lives in `packages/pi`.

It is based on:

- `research_notes/Pi port feasibility/pi_extension_api.md`: the Pi 1.5.0 API, marked
  **[V]** (verified) or **[I]** (inferred, needs a live check)
- `research_notes/Pi port feasibility/pi_auto_model_audit.md`: what the competitors get
  wrong

## Product in one paragraph

Pi Adaptive adds a few models to Pi's model picker: **Adaptive** (`adaptive/auto`) and one
per tier (`adaptive/quick`, `adaptive/standard`, `adaptive/advanced`). Choosing one hands
the session to Adaptive. Adaptive then:

- picks a physical model from the matching tier at the start of each piece of work;
- keeps that model for the whole run;
- recovers from rate limits, outages and quota within the same tier, and never jumps to
  a cheaper or more expensive tier on its own;
- waits, visibly, when the whole tier is out, and resumes on its own;
- escalates to the next stronger tier only when a run fails on capability, judged from
  structured evidence (the failure's classification and the agent's `adaptive_escalate`
  reports with reason and evidence), and then continues the same task there.

Choosing any normal model hands control back at once. Every decision is explained in one
line in the transcript, and that line never enters the model's context.

### Why this beats what Pi already has

The audit found these gaps in the existing Pi routers:

| Gap in existing routers                                                        | Pi Adaptive                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Keyword regexes or an LLM judge pick the tier (pi-auto-model, pi-shift-router) | The tier comes from your choice, the agent's tier tool, or the default. There is no classifier.                   |
| Failover silently crosses tiers (pi-auto-model)                                | Failover stays in the tier. When the tier runs out, the work parks.                                               |
| A single 429 opens the circuit (pi-auto-model)                                 | 429s don't trip the breaker. Half-open admits exactly one probe, **across processes**.                            |
| Health is in-memory and per process                                            | Health is shared by every Pi process, subagents included, and survives restarts.                                  |
| "Shadow mode" still fails over                                                 | Observe mode never changes anything and uses the same scheduler as control mode.                                  |
| Escalation after N tool errors, mid-run, no evidence                           | Escalation needs a reason and evidence, never switches mid-run, moves up one tier only, and is budgeted per task. |
| Nobody parks and resumes                                                       | Parking is durable, has a countdown, and survives a restart.                                                      |

## UX design

Copy rules, inherited from the repo: short and human. Use local times ("until 18:42"),
never "provider health optimization". Every state the user can see answers three
questions: _what is happening, why, and what can I do._

### 1. Install and first run

```text
pi install npm:@coool/pi-adaptive
```

The first `session_start` with a UI (`ctx.hasUI`) after installing shows one dialog. It is
never repeated, and dismissing it counts as seen:

```text
┌ Adaptive is installed ─────────────────────────────────────────────┐
│ Adaptive keeps your work running when a model is rate limited or   │
│ out of quota, without silently switching to a weaker model.        │
│                                                                    │
│ I found 7 models you can use. Suggested tiers:                     │
│   quick     gpt-5-mini · haiku-4.5                                 │
│   standard  sonnet-4.5 · gpt-5 (medium)                            │
│   advanced  opus-4.5 (high) · gpt-5 (high)                         │
│                                                                    │
│  › Use these and switch this session to Adaptive                   │
│    Use these, keep my current model for now                        │
│    Edit tiers…                                                     │
│    Not now                                                         │
└────────────────────────────────────────────────────────────────────┘
```

- **The tier proposal is a deterministic settings bootstrap, not routing.** It uses
  `ctx.modelRegistry.getAvailable()` metadata (cost, `reasoning`, `contextWindow`,
  thinking levels): the cheapest third goes to quick, the middle to standard, and
  reasoning-capable flagships at high thinking go to advanced. It only proposes, and
  nothing is saved until the user confirms. It is a pure function with property tests:
  it only proposes authenticated models, no model appears twice in one tier, and every
  tier is non-empty when at least 3 models are available.
- **Observe is on by default.** As in OpenCode (ADP-029/032), Adaptive only watches
  until the user picks an Adaptive model. The first option does that for the user.
- **Headless runs** (`print`, `json`, `rpc` without UI) never prompt. They use defaults
  and log one line.

### 2. The model picker is the main switch

Registered virtual models:

| Picker entry                                               | Meaning                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adaptive/auto` — "Adaptive"                               | Default tier (`standard`) unless the agent's tier tool or an escalation says otherwise                                                                                                                                            |
| `adaptive/quick`, `adaptive/standard`, `adaptive/advanced` | The tier is pinned by the user, which ranks as a user pin (ADP-002): the agent's tier tool is ignored (its result says so) and escalation is off unless the user enables `escalateFromPinned`. It still recovers within the tier. |

What this gives the user:

- **Manual intent wins with no special code.** Picking any normal model, or cycling with
  Ctrl+P, means Pi stops calling `route()`. Adaptive notices `model_select` and writes the
  note "Adaptive paused — you picked sonnet-4.5".
- **Per-session mode (ADP-054) comes from Pi.** Pi already stores the selected model per
  session.
- **Subagents get a role hint the honest way.** A subagent extension that launches
  `pi --model adaptive/quick` routes that child as quick work. There is no keyword
  guessing.
- **Ctrl+P cycling** through `quick → standard → advanced` is a two-key tier override.
- **Adaptive as the default:** `/adaptive` → "Use Adaptive for new sessions" explains
  setting `defaultModel: "adaptive/auto"`, and writes it only if Pi exposes a supported
  way (M0 check). Otherwise it shows the exact settings line to copy.

### 3. Always-visible status

Pi's footer already shows `auto • high → <physical> • medium` for virtual models.
Adaptive adds one status item (`ctx.ui.setStatus("adaptive", …)`). It is short enough
for 80 columns and is the only persistent element:

| State                                | Status text                                  |
| ------------------------------------ | -------------------------------------------- |
| Routing normally                     | `◆ standard · sonnet-4.5`                    |
| Recovering within the tier           | `↻ standard · openai limited → sonnet-4.5`   |
| Waiting in place, short              | `⏸ standard · resumes in 0:42 · esc cancels` |
| Parked                               | `⏸ standard parked · resumes 18:42`          |
| Escalated for this task              | `▲ advanced · tests failing (escalated)`     |
| Observing a manual model             | `◇ observing · would use standard`           |
| Internal problem, failing open       | `◆ adaptive degraded · /adaptive doctor`     |
| Adaptive model selected but no tiers | `◆ adaptive: set up tiers · /adaptive`       |

While waiting in place, `ctx.ui.setWorkingMessage()` shows the same countdown in Pi's
spinner line.

### 4. Transcript notes, out of the model's context

Every routing change writes a one-line custom entry (`pi.appendEntry("adaptive.note", …)`)
and draws it with `registerEntryRenderer` as a dim line. Custom entries are never sent to
the model **[V]**. Examples:

```text
  ◆ Adaptive · standard → sonnet-4.5
  ↻ openai/gpt-5 rate limited (429) · retrying on sonnet-4.5 · 1 of 3
  ⏸ All standard models are out of quota until 18:42 · parked · /adaptive to change
  ▶ Resumed on gpt-5 after the quota reset (waited 41 min)
  ▲ Escalated to advanced for this task: "type errors persist after 2 attempts"
  ◇ Paused — you picked opus-4.5
```

- **Verbosity** is one setting with three values. `changes` is the default and notes only
  when the model differs from the previous unit or something went wrong. `all` notes
  every unit. `quiet` writes no notes and leaves the status line only.
- Pressing **Enter or `?` on a note** (if the renderer supports interaction; M0 check)
  opens the full receipt. The fallback is `/adaptive why`, which explains the latest
  decision.

### 5. Parking: the moment that matters most

Competitors fail in one of two ways when everything in a tier is out: they cross tiers
silently or they show a red error. Pi Adaptive does three things depending on the wait:

1. **Short wait (reset ≤ 2 min, known from the error or a capacity reading).** `route()`
   waits in place. The spinner says `Waiting for openai quota · 0:42 · esc to cancel`,
   and Esc aborts through the `signal` route receives. Nothing is added to the context.
2. **Long wait before any work happened** (admission found nothing available). The
   user's message is intercepted at `input` **[V]** and stored as parked work, so it is
   never dispatched. A parked card appears (below). On wake, the original message is
   submitted with `sendUserMessage`. That is not a replay, because the message was never
   sent. The shared index contains metadata only; intercepted text and images live in
   Pi's own session entry, never in the machine-wide index.
3. **Long wait mid-run** (recovery in the tier exhausted after tool side effects). The
   run ends. On wake, Adaptive sends one hidden continuation message
   (`sendMessage({customType: "adaptive.resume", display: false}, {triggerTurn: true})`)
   using the shared continuation prompt. That prompt says to continue from the current
   workspace state and not to redo completed steps. The cost is one small message in the
   context. This is the documented trade-off: Pi has no "continue without a message" API
   for extensions.

The parked card is a widget (`ctx.ui.setWidget("adaptive", …)`) above the editor:

```text
┌ ⏸ Parked: all standard models are out of quota ──────────────────────┐
│ openai/gpt-5      quota resets 18:42                                  │
│ anthropic/sonnet  rate limited, retry ~18:05                          │
│ Resumes automatically at 18:05.                                       │
│ /adaptive resume · run now on another model    /adaptive cancel       │
└───────────────────────────────────────────────────────────────────────┘
```

- **"Run now on another model"** opens a picker. The current tier is listed first, then
  other tiers marked `(different tier)`. Picking one is an explicit user choice, so
  crossing tiers is fine here. It is never automatic (ADP-022).
- **The user can type while parked.** A new message cancels the parked work. The card is
  replaced by a note "Parked work dropped — you sent a new message", so nothing is
  resumed behind the user's back.
- **Restarts.** The parked record is a session entry plus a row in the global parked
  index. On `session_start` (`resume` or `startup`) for that session:
  - if the record is already due, a confirm dialog asks "Resume the parked task now?";
  - otherwise, the wake timer is re-armed and the card is shown again.
- **Bounded.** Each task gets at most 3 automatic wakes (per task, because every wake
  starts a new unit). After that, the card asks the
  user instead of trying again.

M4 implements the card and cancellation through a new prompt or physical model pick.
The `/adaptive resume` and `/adaptive cancel` command bindings are M6 work. Native
retry redirects are bounded separately: the third infrastructure failure in one unit
parks instead of redirecting, even if Pi's native retry counter has reset after a
successful tool response. Short waits re-admit using fresh shared health and capacity.

### 6. `/adaptive` command

`/adaptive` opens the **shared** menu from `packages/core/src/flow`. It is the same state
machine as OpenCode's `/adaptive`, implemented over `ctx.ui.select/confirm/input/notify`
and an in-process API (no RPC). Pi users therefore get the tested tier editor (search,
reorder, thinking level per entry) for free. Subcommands come with argument completions
(`getArgumentCompletions`):

| Command                       | Shows                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `/adaptive`                   | Main menu: status, tiers, mode, receipts, health, parked work, doctor                    |
| `/adaptive status`            | Tier table: each resource with its state ("ok", "limited until 18:05", "quota 82% used") |
| `/adaptive why`               | Explanation of the latest decision, from the receipt explanations in `flow/receipts.ts`  |
| `/adaptive tiers`             | Tier editor                                                                              |
| `/adaptive health`            | Resource health, with "Mark healthy" for each resource (manual breaker reset)            |
| `/adaptive resume` / `cancel` | Parked-work actions                                                                      |
| `/adaptive observe on\|off`   | Global observe setting for manual-model sessions                                         |
| `/adaptive doctor`            | Checks below                                                                             |

A shortcut (`registerShortcut`, default `ctrl+alt+a`; M0 checks for conflicts) opens the
menu.

### 7. `/adaptive doctor`

This is the first thing a confused user runs, so every line says what to do:

```text
✓ Pi 1.5.0 (supported: ≥1.5.0 <2, tested up to 1.5.0)
✓ Virtual models registered: adaptive/auto, quick, standard, advanced
✓ 6 of 6 tier models have credentials
✗ anthropic/opus-4.5 (advanced): no credentials — run `pi auth anthropic` or remove it from the tier
✓ Shared state: ~/.pi/agent/adaptive (writable, lock ok)
! pi-auto-model is also installed and routes requests too. Use one router.
✓ Health: 1 resource limited (openai, until 18:05)
✓ No parked work
```

Conflict detection is a plain check for other virtual models or `streamSimple` proxy
providers from known routers in the model registry. It never routes on it.

Pi minors have broken extension APIs before (1.2.0, 1.5.0), so the range alone is not
enough. The build records the newest Pi version the packed matrix passed on
(`testedUpTo`), and doctor prints `! Pi 1.7.0 is newer than the last tested version
(1.5.0). If routing misbehaves, report it and pick a normal model.` The status line stays
normal; this is a doctor-only warning.

### 8. Headless behaviour

In `print`/`json` modes:

- no dialogs; status and notes are skipped where `ctx.hasUI` is false;
- short waits still happen in place;
- long parks are awaited inside the owned input, route, or settle handler, keeping
  print/JSON alive until the reset. No detached timer calls a stale Pi context;
- exhausted automatic-wake budgets leave a durable record and end routing with the
  clear `Adaptive unavailable` error. A subsequent user prompt starts a fresh task;
- terminal quota recovery waits before adding its one hidden continuation. Native
  retries continue through their owned route without replaying a user instruction.

The RPC mode forwards status and dialogs to the client as `extension_ui_request` **[V]**.

## Architecture

```text
packages/pi/
  package.json        name @coool/pi-adaptive; "pi": { "extensions": ["./dist/index.js"] }
                      devDependencies: @earendil-works/pi-coding-agent, @earendil-works/pi-ai (pinned, for types and tests)
                      peerDependencies: the same two, range >=1.5.0 <2, marked optional in peerDependenciesMeta
                        (npm auto-installs non-optional peers, which would pull a second Pi; Pi maps
                        host imports to its own copy at load time)
                      no runtime dependencies: an exclusive `wx` lock file replaces proper-lockfile; core bundled by tsdown
                      No typebox: tool schemas are plain JSON Schema, which pi-schema validates since 1.5.0
  src/
    index.ts          extension factory: register virtual models, tools, commands, shortcut, renderers, events.
                      No timers or I/O in the factory; start them on session_start, stop them on session_shutdown.
                      Every handler goes through failOpen() (log + throttled notify + safe fallback).
    host/             with index.ts, the ONLY code importing @earendil-works/* (lint-enforced; index.ts needs the ExtensionAPI type)
      types.ts        narrow structural interfaces for the Pi surfaces we use (so everything else tests with fakes)
      inventory.ts    modelRegistry → core Candidate[] (resource = provider/model:thinkingLevel; context window, inputs, cost, auth)
      evidence.ts     failed AssistantMessage {stopReason, errorMessage, diagnostics} → core ErrorEvidence
      entries.ts      appendEntry + registerEntryRenderer for notes/receipts/parked records
      view.ts         core flow's AdaptiveView over ctx.ui
      timer.ts        unref'd timers
    store/
      files.ts        atomic write (tmp + rename) under an exclusive lock file; no read cache (see Shared state)
      bindings.ts     core stores (settings, health, capacity, receipts, parked index) bound to files under getAgentDir()/adaptive/
    unit/
      tracker.ts      work-unit lifecycle from route() reasons + agent_start/agent_settled + stopReason
    router/
      route.ts        the virtual-model route(): dispatch on reason; always returns a model or a deliberate park
      admit.ts        reason "user": tier resolution → core scheduler → apply | park | defer-fallback
      retry.ts        reason "retry": classify → health → same-tier redirect | in-place wait | park
      state.ts        per-session routing state (stored by Pi as pi.virtual-model-state; follows forks and /tree)
    recovery/
      restart.ts      non-retryable infra failure after agent_settled → bounded hidden continuation
      escalate.ts     capability evidence at agent_settled → next tier, same task, via the same continuation
    parking/
      park.ts         park records (session entry + global index), wake planning via core execution/parking
      wake.ts         timers, re-arm on session_start, resume actions
      intercept.ts    pre-dispatch park through the `input` event [I]
    observe/
      observe.ts      manual-model sessions: identical scheduler, receipt only, health learning from failures
    ui/
      status.ts       status text for each state (pure)
      notes.ts        note text for each decision (pure)
      parked-card.ts  widget lines (pure, width-aware)
      onboarding.ts   tier proposal (pure) + first-run dialog
      doctor.ts       checks (pure over injected probes)
      commands.ts     /adaptive and subcommands
    tools.ts          adaptive_escalate, adaptive_tier (plain JSON Schema; execute re-narrows with core parsers, isError names the field)
```

The tree is the target layout. Through M3 the code is flatter: `src/router.ts`
(admission), `src/task.ts` (branch-aware task state, retry/restart/escalation plans),
`src/health.ts` (shared health transactions), `src/store.ts` (locked JSON file),
`src/evidence.ts`, `src/capabilities.ts`, and `src/host/{extension,tools}.ts`. Split
along the tree only where a milestone adds the second concern to a file.

Size targets: no file over about 300 lines. The OpenCode `supervisor.ts` (2,322 lines) is
**not** ported or mirrored. The Pi wiring is smaller, because `route()` replaces the whole
`wait → switchModel → resume` path and the own-switch tagging.

### OpenCode → Pi mapping

| Concern                          | OpenCode plugin                                                              | Pi plugin                                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work-unit start                  | `prompt` hook                                                                | `route(reason: "user")`                                                                                                                                                                            |
| In-unit requests                 | execution events                                                             | `route(reason: "continuation")` → return `previous`                                                                                                                                                |
| Auxiliary requests (ADP-027)     | `context`/`model.request` request kind                                       | `route(reason: "direct")` → the quick tier's first healthy entry that passes the compatibility gates (context window ≥ the session's current context, required inputs), falling back to `previous` |
| Model change                     | `session.wait → switchModel → resume`, self-tagged                           | return value of `route()`; nothing to tag                                                                                                                                                          |
| Native retry redirect            | `retry` hook, veto `{retry:false}`                                           | `route(reason: "retry")` returns a same-tier healthy model                                                                                                                                         |
| Retry veto                       | `{retry:false}`                                                              | no veto: redirect, wait in place, or deliberate park (throw from `route()` with a non-retryable message)                                                                                           |
| Non-retried quota/billing errors | Adaptive recovery after failure                                              | `agent_settled` + last `stopReason:"error"` → bounded hidden continuation                                                                                                                          |
| Escalation                       | `#escalateOnFailure` on a terminally failed unit, continued on the next tier | the same at `agent_settled`, continued through the hidden continuation                                                                                                                             |
| Manual intent                    | `model.selected` minus own switches                                          | `model_select` to a non-virtual model                                                                                                                                                              |
| Global storage                   | `ctx.storage`                                                                | files under `getAgentDir()/adaptive/` with locks                                                                                                                                                   |
| Shared health between subagents  | in-process `ProcessLedger`                                                   | file store (subagents are child processes)                                                                                                                                                         |
| Hidden notice                    | `session.synthetic({resume:false})`                                          | `appendEntry` + entry renderer                                                                                                                                                                     |
| UI                               | TUI dialogs + GUI + typed RPC                                                | `ctx.ui` in-process; no RPC, no GUI                                                                                                                                                                |
| Capacity sensor                  | Codex headers                                                                | the same core sensor via `after_provider_response` (Codex fires on every attempt **[V]**)                                                                                                          |

### Routing algorithms

**Admission (`reason: "user"`):**

1. Resolve the tier (ADP-002 order):
   1. **base tier** = the pinned tier from the virtual model id (a user pin) ?? the
      session's sticky `adaptive_tier` request (ADP-055; only with `adaptive/auto`) ??
      `standard`;
      A new user prompt clears pending recovery and never inherits an escalation: the
      budgets and the raised tier belong to the task that earned them.

2. Run the core scheduler on (settings, inventory from the registry, health and capacity
   from the store, context, clock). It returns one of:
   - **apply(resource):** return it and write a note if it changed.
   - **park(until):** short → wait in place; long → park (UX §5).
   - **defer:** Pi has no "own choice" while a virtual model is selected. Fall back to the
     tier's first configured resource that has credentials **and passes the
     compatibility gates** (ADP-017), then the last manually selected model (remembered
     from `model_select`) only if it belongs to this same tier and passes the gates.
     If neither exists, show "set up tiers". Defer is not permission to cross tiers.
     The receipt uses the Pi `HostCopy` explanation for defer.
3. Persist the routing state `{taskId, unitId, tier, resource, hops, restarts,
escalationsUsed, pendingRecovery?}`.

**Continuation (`reason: "continuation"`):** Pi's hidden custom messages use this reason,
not `user` (verified in the SDK spike). First check for a claimed Adaptive recovery
token associated with this task and branch. If present, consume it once, start a new
unit within the same task, and admit on the recorded recovery tier (same tier for a
restart, exactly one tier up for escalation). Otherwise return the unit's existing
resource unchanged. An arbitrary extension message must never consume Adaptive's
pending recovery. A new user prompt, manual model selection, session switch, or abort
invalidates the token. Persist token consumption with the wake claim before dispatch.

**Retry (`reason: "retry"`, Pi's own retry, 2/4/8 s backoff):**

1. Turn `failed.message` into evidence (`host/evidence.ts`) and classify it with the
   core classifier.
2. **Capability evidence never comes from here** (ADP-013).
   - Infra failure: record health and pick the next healthy resource in the _same tier_,
     excluding the ones tried in this chain.
   - Nothing left and a known reset ≤ 2 min: wait in place, then return.
   - Otherwise: park.
3. Adaptive's per-unit hop budget is the real bound. Pi's `maxRetries` (3) resets after
   every successful response, so a long run can see many retry chains, and users can raise
   it. Once the hop budget is spent, `route()` parks instead of redirecting.

**As implemented through M4:**

- `message_end` handlers are awaited before Pi decides to retry, so every routed
  response is first recorded in the shared health file (`recordOutcome`). The retry's
  admission already sees the 429 or 503 it is retrying.
- An infra-classified `retry` adds the failed model to the unit's `tried` list (kept in
  the router state, deduplicated) and re-admits within the same tier, excluding `tried`.
  A non-infra retry (for example a context overflow Pi still retries) stays sticky.
- When the exclusion leaves nothing admissible, admission runs again without it, so the
  failed model takes Pi's own backoff retry unless health or capacity blocks it. A
  known reset within two minutes waits in the owned route; longer waits persist a
  park. The third infrastructure failure in a unit parks regardless of Pi's retry
  budget. Tool-response successes do not reset this unit-level bound.
- A TUI route that parks ends with `Adaptive unavailable` and a visible parked card;
  its claimed wake starts one clean continuation. Headless routes await their wake
  before re-admitting. All re-admissions use the shared scheduler, same-tier only.

**Restart after a non-retried failure.** Pi never retries quota or billing errors.

On `agent_settled{aborted:false}`, Adaptive reads the current unit's last assistant
message. It restarts (`restartAfterRun`) only when all of these hold:

- the message is `stopReason:"error"` from a physical provider (not Adaptive's own route
  failure);
- the error is classified failover-eligible (infra);
- the mode is active and there is no user model pin;
- the task's restart budget (`MAX_RESTARTS_PER_TASK = 2`, per task, because each restart
  starts a new unit) is not spent.

Escalation is evaluated first and wins; the two never both fire, because capability and
infra classes are disjoint. Pinned virtual tiers (`adaptive/standard`, …) do restart: the
pin fixes the tier, and recovery stays inside it.

1. Send the hidden continuation message. Its details carry `{task, token, tier (same),
escalations, restarts + 1, tried: [the failed model]}`.
2. The next owned `route(reason:"continuation")` consumes the token once, starts a new
   unit of the **same task**, and admits on the same tier, avoiding `tried` while the tier
   has another admissible model.
3. Before sending a terminal recovery, admission previews shared health and capacity
   without retaining probe tickets. A long wait parks first, then sends exactly one
   hidden continuation on its claimed wake. A short wait stays inside the subsequent
   route. If the two immediate restarts are spent, a blocked tier may still park within
   its separate three-wake budget; an available tier never gets an extra immediate retry.

The UI notice reads "Adaptive: <model ids> failed; continuing on another <tier> model."

User aborts (`stopReason:"aborted"`, `agent_settled.aborted`) never recover (ADP-010).

**Escalation** mirrors OpenCode's `#escalateOnFailure`. In Pi the next `route(user)` is
normally a new task, so escalation cannot wait for it; it is evaluated when the run ends:

- `adaptive_escalate {reason, evidence}` only records the request on the current unit
  (shared `execution/escalation` parser and budget). The run keeps its model: every
  ordinary in-unit `route(continuation)` returns the current resource, so nothing
  switches mid-run. Only an owned post-settle recovery starts a new unit.
- On `agent_settled{aborted:false}` with a terminal failure (last assistant message
  `stopReason:"error"`), the unit is evaluated with the shared escalation logic: the
  failure's classification (a capability class only, never infra, ADP-013) plus the
  recorded tool evidence. If it escalates and the task's budget allows, Adaptive sets
  `pendingRecovery = {kind: "escalation", tier: next}` and sends the hidden continuation,
  so the same task continues one tier up.
- A run that ends successfully drops the recorded requests, exactly like OpenCode
  (`#afterUnitClose` deletes the unit's escalation evidence).
- The budget is per task (one user prompt plus its continuations), as in ADP-015.
- The tool result says plainly what happens: "Recorded. If this run fails, the task
  continues on advanced (0 of 1 escalations used)." When pinned, it says: "You pinned
  standard, so Adaptive will not escalate. Tell the user if you need a stronger model."
- A pinned tier never escalates unless the user turned `escalateFromPinned` on (default
  off, because a user pin wins, ADP-002/038). `adaptive_tier` is ignored while pinned.
- Headless: see UX §8.

### Shared state and cross-process safety

Files under `~/.pi/agent/adaptive/`:

- `settings.json`
- `health.json`
- `capacity.json`
- `receipts.jsonl` (ring, oldest evicted, ADP-030)
- `parked.json` (index)

Every write is lock + read + merge + atomic rename.

- **Half-open single probe across processes (ADP-019):** the probe is the core
  breaker's own half-open record (`probeId`, `probeAt`) in `health.json`, claimed under
  the lock in the same transaction that assessed it. Probe ids are random UUIDs, so they
  are unique across processes. Other processes see the probe in flight and treat the
  resource as blocked until its outcome is recorded or the core probe timeout (10 min)
  expires. Tickets an admission does not dispatch are handed back in the same
  transaction.
- **Wake at most once across processes (ADP-024):** two Pi processes can have the same
  session open, and both arm a wake timer. A wake first claims the parked record in
  `parked.json` under the lock (`{claimed: true, wakes: previous + 1}`). Only the claimer resumes;
  the other sees the claim and just clears its card.
- **No read cache.** A cache keyed on file metadata was planned and dropped: the health
  file is small (≤ 512 records), and every read that matters happens under the lock as
  part of a read–modify–write anyway (a half-open probe must be claimed in the same
  transaction that read the breaker). The cost is one locked transaction per non-sticky
  admission and one per routed response. In-unit continuations touch no state.
- **Corrupt or unknown-version file:** the store's existing parsers hard-error. The
  plugin fails open, routes like defer, and doctor reports the file. It never silently
  rewrites a file it cannot parse.
- **Privacy (ADP-051):** no message content, no keys, no headers beyond rate-limit
  numbers.

The Pi session entry is the sole exception for an intercepted, never-dispatched
prompt: it stores that prompt and its images in the host's ordinary user-content
store so the input can survive restart. `parked.json` retains only session/token/tier,
due time, wake count, and claim state (bounded at 512 sessions). A claim is durable
before dispatch and is never automatically released after a crash: at-most-once
dispatch takes precedence over replaying an ambiguous wake.

### Error evidence for Pi

Pi gives free text only (`errorMessage`, optional `diagnostics`). `host/evidence.ts`
fills these core `ErrorEvidence` layers:

- `interruption` from `stopReason: "aborted"`;
- `status` from an HTTP code embedded in the SDK message;
- `provider-metadata` from Bedrock `diagnostics.details`;
- `textual` for the rest, through the classifier's existing bounded textual layer.

**A golden corpus keeps this honest.** `test/fixtures/pi-errors/<pi-version>.json` holds
real error strings for each provider and class (429, quota, billing, 5xx, overloaded,
timeout, context overflow, auth, content filter). The strings were collected by hand
from pi-ai's provider code; each entry names its source file. There is **no
regeneration script**: pi-ai builds its messages in too many shapes for a scanner to be
trusted, so a new Pi version is reviewed by hand against pi-ai's `api/` and `utils/`
error constructions, and the new strings are added as a new corpus file. The corpus test
requires every entry to classify as labelled, and no infra entry may ever produce
capability evidence.

## Requirement mapping

The ADP catalogue gets applicability tags (monorepo plan, step 6). Proposed tags for Pi:

- **`[both]`, same rule:** ADP-002, 004–007, 009–013, 015–023, 026–030, 032, 037–039,
  045–047, 051–053.
  - ADP-002: a pinned `adaptive/<tier>` model ranks as the user pin, above the
    `adaptive_tier` request. A subagent started with `--model adaptive/quick` is pinned
    the same way.
  - ADP-029: modes map as off = no Adaptive model and observe off; observe = a manual
    model with observe on; active = an Adaptive model selected.
- **`[both]`, reworded to be host-neutral:**
  - ADP-001: work unit = one host execution episode.
  - ADP-003: defer keeps the host's choice; in Pi that is the tier's first compatible
    configured model (there is no host choice while a virtual model is selected).
  - ADP-008: structured host metadata where the host has it; Pi has free-text errors only.
  - ADP-014: prefer the host's native retry/redirect.
  - ADP-024: name both resume mechanisms (owned continuation, hidden continuation
    message) and keep "at most once across plugin instances".
  - ADP-031: fail-open defers to the host's ordinary behaviour.
  - ADP-048: each package declares its own exports list.
  - ADP-050: the release gate is `npm run verify` (per package).
  - ADP-054: per-session mode through the host's own mechanism (typed RPC in OpenCode,
    the selected model in Pi).
  - ADP-055: `adaptive_tier` stays sticky per session and ranks between the user pin
    and the default; in Pi it only has an effect under `adaptive/auto`.
  - ADP-056: capacity visible on each host's status surface (`status.get`/TUI in
    OpenCode, `/adaptive status` and the status line in Pi).
- **`[opencode]` only:** ADP-025 (`/goal`), 033–036, 040–044 (OpenCode TUI/GUI/Web/RPC
  surfaces and host matrices).
- **Retired:** ADP-049 (no CI) stays retired and untagged.
- **New `[pi]` requirements:**

| Id      | Requirement                                                                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADP-057 | Virtual models `adaptive/auto`, `adaptive/quick`, `adaptive/standard`, and `adaptive/advanced` are registered; picking a non-virtual model hands control back immediately and notes it.                                                                     |
| ADP-058 | Routing changes and parking produce transcript notes that never enter model context; verbosity is `quiet`, `changes`, or `all`.                                                                                                                             |
| ADP-059 | Health, capacity, receipts and parked work are shared across Pi processes with cross-process locking; half-open admits one probe across processes.                                                                                                          |
| ADP-060 | Parking: in-place waits ≤ 2 min with countdown and Esc; pre-dispatch park never dispatches the parked message twice; mid-run resume uses one hidden continuation message; ≤ 3 automatic wakes per task; a wake is claimed at most once across Pi processes. |
| ADP-061 | Non-retried infra failures restart the same task at most 2 times; user aborts never restart.                                                                                                                                                                |
| ADP-062 | `/adaptive` uses the shared flow; `/adaptive doctor` reports version support, credentials, storage, conflicting routers, health and parked work with an action per problem.                                                                                 |
| ADP-063 | First run offers a deterministic tier proposal from the user's available models; nothing is saved without confirmation; observe is the default.                                                                                                             |
| ADP-064 | Packed tests run the `npm pack` artifact against real Pi hosts at the minimum supported version and `latest`, over the SDK, `pi --mode json`, and a PTY TUI.                                                                                                |
| ADP-065 | The Pi error corpus classifies every entry as labelled for every supported Pi version.                                                                                                                                                                      |

## Milestones

Each milestone ends with `npm run check -- --pkg pi` green, 100% coverage, and the
milestone's tests written test-first where they cover a behavioural rule.

### M0 — spike: settle every [I] (1–2 days, throwaway code in `.scratch/`)

Run against real Pi 1.5.0 with the faux provider and a loopback fake HTTP provider. Use
the user's own key only for the opt-in error-capture item. Each check's result goes into
`research_notes/Pi port feasibility/pi_spike_results.md` with a design decision:

1. A throwing `route()` ends the run without a Pi retry. What does the user see?
   → decides the fallback park rendering.
2. An async `route()` waiting 3+ minutes: is there any request-prep timeout? Is `signal`
   aborted by Esc? → the in-place wait limit (2 min proposed).
3. `route(reason:"retry")` to a different provider works with Pi's backoff, and
   `previous`/`failed` are populated as documented.
4. A quota error is not retried by Pi, `agent_settled` fires, and
   `sendMessage({display:false},{triggerTurn:true})` starts a run with `route` reason
   `continuation` (not `user`). **Verified in the SDK and actual `--print` text and
   JSON CLI modes:** immediate post-settle recovery completes before the process
   exits. Delayed parked wakes still need a separate process-lifetime check.
5. Can the `input` event consume a message without running the agent? → whether the
   pre-dispatch park is possible.
6. Virtual models in the picker: four entries, Ctrl+P cycling, `defaultModel:
"adaptive/auto"` in `settings.json`, the footer text.
7. Entry renderer: dim one-line rendering at 80 columns; any interaction (Enter/`?`) on a
   rendered entry.
8. `setWidget` multi-line card next to the editor; `setStatus` truncation at 80 columns.
9. Subagent example: does a child `pi` inherit the global extension and `--model
adaptive/quick`?
10. Compaction calls `route(reason:"direct")`, returning a quick-tier model works, and the
    request carries enough to know the current context size for the compatibility gate.
11. Pi loads a tsdown-bundled ESM `dist/index.js` from an installed npm package with jiti,
    and `pi install` with optional peers on `@earendil-works/*` does not download a
    second Pi into the package's `node_modules`.
12. `after_provider_response` on failure for openai-codex vs anthropic vs openai.
13. Error capture: real `errorMessage` strings for 429, quota and 5xx from 2–3 providers
    (opt-in, user's key).
14. Shortcut `ctrl+alt+a` is free.

**Exit:** every [I] is resolved, and the plan's affected sections are updated (for
example, if item 5 fails, pre-dispatch parks use the throw fallback).

**Results so far** (Pi 1.5.0, faux provider, no network; details in
`research_notes/Pi port feasibility/pi_spike_results.md`):

- Item 1: a throwing `route()` makes no provider request and no Pi retry. The run
  settles once with `stopReason:"error"` and the thrown text verbatim.
- Item 2: an `await` of 181 s inside `route()` completes and dispatches once, so Pi has
  no preparation timeout and the 2-minute in-place wait stands. `session.abort()` (Esc in
  the TUI) aborts `request.signal`; the wait rejects and nothing is dispatched.
- Item 3: routes arrive as `user` then `retry`, and `failed.message` carries the
  provider error. Returning another same-tier model completes the run.
- Item 4: verified in the SDK and in `--print` text/JSON modes (above). A **detached**
  timer that sends the continuation after the handler returned fails in print/JSON with
  "This extension ctx is stale" and exits 1. Headless recovery must therefore be awaited
  inside an owned handler or `route()`. Only the TUI may re-arm a wake on `session_start`.
- Item 5: returning `{action:"handled"}` from `input` consumes the message with no route,
  dispatch or settle. Pre-dispatch parking is possible.
- Item 6 (partly): Ctrl+L opens the model picker. It has no "Select model" title, and
  rows read `auto (Adaptive Auto) [adaptive]`; typing filters them. `ctx.ui.setStatus`
  shows in the footer, and picking a physical model fires `model_select` and stops
  routing. Termwright reads the screen with `terminal.screen().text()`. Ctrl+P cycling,
  `defaultModel` and the footer arrow text are not checked yet.
- Item 11: `pi install npm:<pkg>` from a loopback registry, with the `@earendil-works/*`
  peers marked optional, fetches only the package tarball. Nothing from
  `@earendil-works` is requested or installed into the package's `node_modules`, so
  there is no duplicate host.
- Not yet checked: items 7–10 and 12–14.

### M1 — package skeleton, fail-open from day one (S)

- `packages/pi` at version `0.0.0` with `"private": true`, so `npm run release` skips it
  until M8. tsdown build, `pack-manifest.json`, `pi` manifest field, host packages as
  pinned devDependencies plus optional peers `>=1.5.0 <2` (see Architecture), and the
  build-time `testedUpTo` constant for doctor.
- The extension registers the four virtual models with a `route()` that returns the
  tier's first configured resource, or `previous`. It also registers `/adaptive doctor`
  (version, registration and storage checks only).
- Test harness, three layers from the start:
  1. unit tests with structural fakes of `host/types.ts`;
  2. **SDK integration**: `createAgentSession` with an in-memory session and settings,
     inline `extensionFactories`, and pi-ai's faux provider. One test boots Pi with the
     extension and runs a turn through `adaptive/auto`.
  3. **packed**: `scripts/pi-host.ts` installs a Pi version into a cache dir, packs the
     plugin, installs it into an isolated agent dir, and runs `pi --mode json -p` against
     the testkit fake provider (registered as a custom provider with `api:
"openai-completions"` and the loopback `baseUrl`).
- **Exit:** `pi install ./packages/pi` works locally, and selecting `adaptive/auto`
  answers through the first standard model.

### M2 — routing, state, tools (M)

- `store/` file bindings with locking (tests: two writer processes, a lock held past a
  crash, corrupt file → fail-open).
- `host/inventory.ts`, `unit/tracker.ts`, `router/admit.ts`, `router/state.ts`, receipts,
  `adaptive_tier`, and tier resolution incl. pinned virtual models.
- Property tests: unavailable or incompatible resources are never returned (including
  defer fallbacks and `direct` routes); a pinned tier is never changed by `adaptive_tier`.
- **Exit:** receipts are written; SDK tests cover tier resolution order and continuation
  stickiness (no switch mid-unit).

### M3 — health and horizontal recovery (L)

- `host/evidence.ts` + the error corpus. `router/retry.ts`, cross-process breaker probe
  lease, `recovery/restart.ts`, and capacity via the shared codex sensor.
- Property tests:
  - infra failures never escalate;
  - retries never leave the tier;
  - total hops per unit ≤ min(tier size, budget);
  - a restart never follows a user abort;
  - at most one probe across N simulated processes.
- Packed scenarios against the fake provider: 429 → redirect; 503 → redirect;
  quota → restart on a same-tier resource; all resources down → park; permanent auth
  error → no retry loop.
  - Done as real-SDK scenarios with the faux provider (`test/runtime/extension.test.ts`):
    503 and 429 native-retry redirects, with the 429 visible in `health.json` and avoided
    by the next task; quota restart through the hidden continuation; at most 2
    restarts per task; all models down → `Adaptive unavailable` with no loop; auth → no
    redirect or restart; user abort → no restart. "All down → park" waits for M4, and the
    packed-install variants for M7.
- **Exit:** ADP-008–013, 019, 022, 059 and 061 are covered.

### M4 — parking and wake (M)

- In-place wait, park records (session entry + global index), wake timers, re-arm on
  `session_start`, pre-dispatch intercept (or its fallback), hidden continuation, the
  3-wake budget, "new message drops parked work", and headless behaviour.
- Tests use an injected clock and timer, so there are no sleeps. A restart scenario
  covers both cases: the session is closed while parked, then reopened after the reset
  (resume prompt) and before it (card re-armed).
- **Exit:** ADP-024 and 060 are covered; nothing is ever dispatched twice
  (state-machine property test over park → wake → cancel → new-message interleavings).

Implemented in `src/parking.ts` (bounded locked metadata/claims and abortable waits),
`src/host/parking.ts` (session lifecycle), `src/host/parked-view.ts` (host payload and
card), and `src/host/routing.ts` (one admission path for previews and dispatch).
Deterministic tests cover re-arm before reset, overdue confirmation, cancellation,
stale timer/claim races, three-wake exhaustion, and optional-store failures. Real SDK
faux-provider tests cover short wait/abort, owned headless interception, and a quota
park after durable tool work with exactly one hidden continuation. Independent worker
processes compete for the same `parked.json` wake; exactly one claims it.

### M5 — escalation and observe (S)

- `adaptive_escalate` (shared parser, bounded fields, `isError` naming the field) and
  `recovery/escalate.ts`: evaluation at `agent_settled` on a failed run, continuation one
  tier up through the hidden continuation, per-task budget, pinned tiers excluded unless
  `escalateFromPinned`.
- Property tests: escalation moves exactly one tier; never mid-run (every continuation
  route returns `previous`); never from infra evidence; never past the per-task budget; a
  successful run never escalates.
- `observe/observe.ts`: decisions on `before_agent_start` for manual-model sessions use
  the same scheduler call. Receipts are written, health is learned from errors, and
  nothing changes.
- **Exit:** ADP-015 and 029 are covered, plus the Observe/Control identity property test.

Implemented: observation runs on the `input` event, not `before_agent_start`, because
the latter carries no messages to size the context demand. It uses the same
`prepareAdmission` path as dispatch with `preview = true` (no probe lease is taken) and
wraps the result with the core `forMode`. A virtual model is always `active`; a manual
model is `observe` unless the session or global mode is `off`. Health is learned from
manual-model errors in observe mode.

### M6 — UX surfaces (L; this is where the polish goes)

- `host/view.ts` (the shared flow over `ctx.ui`), with the `HostCopy` set to "Pi".
  Page-flip footer actions use `ctx.ui.custom` when `select` can't carry them.
- Status line states, transcript notes with verbosity, parked card, onboarding wizard
  and tier proposal, `/adaptive` subcommands with completions, full doctor, shortcut.
- Every text producer is a pure function with snapshot-free assertions on content and
  width (≤ 80 columns, truncation with `…`).
- **UI review pass.** Termwright screenshots at 80x24, 120x40 and narrow 60x24 for every
  state in UX §3–7. Review them against the copy rules and fix anything noisy.
- **Exit:** ADP-057, 058, 062 and 063 are covered.

Implemented in `src/host/{adaptive,commands,control,doctor,onboarding,view,entries}.ts`
and `src/ui/*`, with PTY frames at 60x24, 80x24 and 120x40 and screenshots under
`packages/pi/docs/screenshots/`. Findings from the real terminal: `registerEntries` must
be called in production or notes are written but never drawn; a dialog as tall as the
terminal loses its last (footer) row, so dialogs keep one spare row; Pi's argument menu
consumes the first Enter of a typed `/adaptive <sub>`. No "resumed" note is emitted after
a wake; the resume is visible through dispatches.

### M7 — real-host E2E and version matrix (M)

- **Termwright PTY E2E** over the real `pi` TUI with an isolated agent dir and the fake
  provider. Journeys:
  1. first run → accept the proposal → routed turn → note visible;
  2. 429 → recovery note;
  3. all down → parked card → reset → resumed note;
  4. Esc during an in-place wait cancels and does not restart;
  5. pick a manual model → paused note;
  6. `/adaptive tiers` reorder persists;
  7. doctor with a missing credential;
  8. two Pi processes share health (one sees the other's 429).
- **Matrix:** Pi `1.5.0` (minimum) and `latest`, run through the packed install by
  `scripts/pi-host.ts`. Requirement ADP-064.
- `verify` for Pi: format, lint, typecheck, coverage, build, pack-check, SDK integration,
  packed matrix, `e2e:tui`, traceability.

### M8 — docs and first release (S)

- Package README:
  - install line;
  - a 30-second GIF or screenshots (status line, recovery note, parked card);
  - "How it decides" in 5 bullets;
  - comparison with the other Pi routers (facts from the audit, no snark);
  - privacy statement.
- `packages/pi/docs/TEST_STRATEGY.md`, the AGENTS.md Pi facts and version pins, and
  CHANGELOG.
- Remove `"private": true` from `packages/pi/package.json` in its own commit, then
  `npm run release -- --pi minor`, which publishes `pi-adaptive@0.1.0` (0.0.0 → 0.1.0;
  the planner treats the never-tagged package as all commits since `packages/pi`
  existed). Install it from npm into a clean Pi and run one routed turn plus doctor.
- Optional, after the release: list it on pi.dev/packages.

Status: README, CHANGELOG and TEST_STRATEGY are written; the AGENTS.md Pi facts are
recorded. The remaining steps are `private` removal and the release, both of which need
maintainer approval and npm authentication. Known limit: a park before the session's
first message does not survive closing Pi, because Pi persists a session file only once
it holds a conversation (ADP-024 is met for mid-run parks).

## Effort

Effort per milestone:

| M0    | M1    | M2  | M3    | M4    | M5    | M6    | M7    | M8    |
| ----- | ----- | --- | ----- | ----- | ----- | ----- | ----- | ----- |
| 1–2 d | 0.5 d | 1 d | 2–3 d | 1–2 d | 0.5 d | 2–3 d | 1–2 d | 0.5 d |

In total that is roughly 10–15 working days after the monorepo lands. M0 can run in
parallel with monorepo steps 1–3, because it only writes to `.scratch/` and
`research_notes/`.

## Decisions to confirm before M1

1. **Package name `@coool/pi-adaptive`** and virtual model ids `adaptive/*`.
2. **The in-place wait limit** (2 min proposed; M0 item 2 may change it).
3. **Escalating from a pinned tier** is off by default (`escalateFromPinned: false`),
   because a pinned `adaptive/<tier>` is a user pin and the user pin wins (ADP-002/038).
   Users who want "start here, escalate if needed" pick `adaptive/auto` or turn it on.
4. **The minimum Pi version is 1.5.0** (the first with pi-schema tool validation; going
   lower means maintaining two schema paths).
5. **The hidden continuation message for mid-run resumes** is an accepted deviation from
   OpenCode's no-message continuation, because Pi has no API for it.
