# Pi Adaptive

Capability-tier routing and bounded recovery for [Pi](https://github.com/earendil-works/pi), published as
[`@coool/pi-adaptive`](https://www.npmjs.com/package/@coool/pi-adaptive). You choose the available
models and their tier order; Adaptive keeps provider failures separate from
capability gaps. Pi still owns the agent, tools, sessions, and model calls.

See the [Pi plan](../../docs/plans/pi-plugin.md) for the design and the
[test strategy](docs/TEST_STRATEGY.md) for the evidence each release requires.

## Install

```sh
pi install npm:@coool/pi-adaptive
```

The package declares Pi `>=1.5.0 <2`. The declared range is not itself a
compatibility test: the packed minimum (1.5.0) and latest Pi hosts run the
SDK, JSON, and real-terminal matrix before release, and `/adaptive doctor`
reports the last host version that matrix recorded. For local development, run
`pi install ./packages/pi` from the repository root after building.

## How it decides

- **Use an explicit tier, not a classifier.** A user pin wins, then the agent's
  `adaptive_tier` request under Auto; otherwise the tier is `standard`. No prompt
  keywords or extra LLM call decide the tier.
- **Check fit before preference.** Only your configured, authenticated models
  are candidates. Context size, input modalities, declared tool support, health,
  and available capacity evidence constrain selection before tier order.
- **Keep productive work on its model.** Ordinary tool continuations stay on the
  selected resource. A recovered preferred model becomes eligible at a later
  safe boundary, not just to make an ongoing run cheaper.
- **Recover horizontally.** Rate limits, quota exhaustion, timeouts, and outages
  use another eligible resource in the same tier, or wait/park. Availability
  never silently borrows a weaker or stronger tier; 429s do not trip the breaker.
- **Escalate only on capability evidence.** `adaptive_escalate` requires a reason
  and concrete evidence. Recording it switches nothing; a terminal capability
  failure can continue the same task exactly one tier higher, within its budget.

## Models and modes

| Picker entry        | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `adaptive/auto`     | Use the requested tier, or `standard`; allow evidence-backed escalation. |
| `adaptive/quick`    | Pin the quick tier; recover within it.                                   |
| `adaptive/standard` | Pin the standard tier; recover within it.                                |
| `adaptive/advanced` | Pin the advanced tier; recover within it.                                |

**Observe is the default.** It explains what the same scheduler would choose
without changing a manually selected model. Choosing an Adaptive entry
activates routing for that session; choosing any normal model hands control back
immediately. With observation disabled and a normal model selected, Adaptive is
off. Off mode does not route or recover work.

Pinned tier entries ignore the agent's tier request and do not automatically
escalate by default. The Preferences dialog can explicitly enable
`escalateFromPinned`; evidence and task budgets still apply. A concrete model
pin always wins over automatic routing and recovery. Use Auto for the default
evidence-backed movement between tiers.

The agent tool `adaptive_tier` takes `quick`, `standard`, or `advanced`. Its
declaration applies from the next user prompt and stays on the session branch
until replaced. A new user prompt starts a new task at that base tier; it does
not inherit the last task's escalation. Forking or rewinding follows Pi's branch
state. `adaptive_escalate` is evidence reporting, not a planning tool.

## Providers, capabilities, and settings

Configure credentials and models in Pi first. Adaptive uses Pi's available-model
registry; it does not add providers, fetch a marketplace, or invent tier
memberships. Do not run multiple automatic routers in the same session.

Settings live under Pi's agent directory, normally
`~/.pi/agent/adaptive/settings.json`. The shared settings include `mode`
(`off`, `observe`, `active`), ordered `tiers`, and a concrete-model `pin`
(`null` means unpinned). For example, replace these placeholders with your
actual Pi provider/model IDs:

```json
{
  "mode": "observe",
  "tiers": {
    "quick": [{ "providerID": "your-provider", "id": "your-quick-model" }],
    "standard": [{ "providerID": "your-provider", "id": "your-standard-model" }],
    "advanced": [{ "providerID": "your-provider", "id": "your-advanced-model" }]
  },
  "pin": null
}
```

List multiple models in a tier in your preferred order for same-tier recovery.
Empty tiers do not authorize cross-tier fallback. The interactive tier editor
and the first-run proposal build tiers from available-model metadata, never
from prompt classification, and nothing is saved until you confirm.

A tier entry can include a Pi-supported thinking level as `variant`, such as
`"variant": "high"`. Admission checks that exact variant, and dispatch uses it;
unsupported variants are not silently replaced with a different thinking level.

Pi's catalogue does not declare model-level tool capability. Explicit
declarations live in `adaptive/capabilities.json` beside the settings file:

```json
{
  "models": [{ "providerID": "your-provider", "id": "your-model", "tools": true }]
}
```

Declare support only after verifying that model's tool calls. Missing declarations
remain unknown; `tools: false` explicitly excludes a model from tool-enabled
requests. Declarations do not add providers, tier memberships, or credentials.
Malformed capability files produce field-specific errors rather than guessed
declarations. Capacity is evidence-driven: unknown capacity is not a promise of
remaining quota, and not every provider exposes usable capacity readings.

## Status, notes, and commands

Adaptive uses one footer item for the current tier and model, recovery,
task escalation, observation of a manual model, tier setup, or degraded
operation. Waiting countdowns and parked-work status take priority in that same
item; parked work also has a card. A manual model pick or session change clears
stale status, and disabling observation clears its manual-model footer.

One-line transcript notes stay out of model context. The note verbosity choices
are `changes` (default: model changes or problems), `all` (every unit), and
`quiet` (no transcript notes). The footer and receipts remain useful with
`quiet`; neither depends on note verbosity.
Real-terminal frames at 80 columns are in [docs/screenshots](docs/screenshots/README.md):
[first-run proposal](docs/screenshots/first-run-proposal-80x24.txt),
[routed note](docs/screenshots/routed-note-80x24.txt),
[parked card](docs/screenshots/parked-card-80x24.txt), and
[doctor](docs/screenshots/doctor-80x24.txt). Dialogs are checked at 60, 80, and
120 columns.

The `/adaptive` command (also `Ctrl+Alt+A`) uses the same dialog flow as OpenCode:

| Command                     | Purpose                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/adaptive`                 | Open the main menu.                                                                                             |
| `/adaptive status`          | Show tiers, resource health, and available capacity evidence.                                                   |
| `/adaptive why`             | Explain the latest routing receipt.                                                                             |
| `/adaptive tiers`           | Edit ordered tier membership.                                                                                   |
| `/adaptive health`          | Inspect health and manually mark a resource healthy.                                                            |
| `/adaptive resume`          | Act on parked work.                                                                                             |
| `/adaptive cancel`          | Cancel parked work.                                                                                             |
| `/adaptive observe on\|off` | Enable or disable observation of manual-model sessions.                                                         |
| `/adaptive doctor`          | Check host compatibility, credentials, capability declarations, storage, router conflicts, health, and parking. |

Typed subcommands complete in Pi's argument menu; the first Enter accepts the
completion and the second runs it.

## Waiting, parking, and cancellation

Parking keeps work in the required tier:

- A known reset within two minutes waits in place with a countdown; Esc cancels.
- Longer waits persist parked work with its session and a shared local index.
  A cross-process claim permits at most one wake for a parked record.
- No provider request is dispatched while parked. An initial prompt is saved as
  normal Pi conversation history before parking at the routing boundary, so it
  survives closing and reopening Pi. Cancelling its parked work leaves that
  message in history. Later intercepted prompts are kept in session-only payloads
  until resumed. After partial execution, recovery uses one hidden continuation message telling the agent to
  continue from existing session/workspace state, not replay the original prompt
  or redo completed steps. That small continuation **does** enter model context;
  operational notes and receipts do not.
- A new user message or manual model selection cancels parked work. User aborts
  never trigger failover or restart. A manual choice of another tier is explicit
  user intent, not automatic cross-tier recovery.
- Reopening a parked interactive session re-arms its wait; already-due work asks
  for confirmation. An owned wake writes a resumed note unless verbosity is
  quiet. Wake cycles that find every model still unavailable are free — they
  re-arm and try again later — so the give-up budget counts **failed resume
  deliveries, at most five per task**. Reaching it stops automatic wakes and
  says so in the transcript; `/adaptive resume` or reopening with consent
  still tries immediately. Terminal infrastructure failures get at most
  **two automatic restarts per task**; capability escalation is separately
  bounded. Permanent auth/configuration errors do not enter recovery loops.

Headless print/JSON runs never show dialogs. Detached wake timers are not a
supported headless continuation mechanism: Pi can exit or invalidate the
extension context after the owned handler returns. Only an awaited, owned
recovery may continue that process; otherwise the run ends with a clear
unavailability error. There is no background daemon.

## Privacy

Adaptive sends no external telemetry and makes no classifier requests. Normal
model requests still go through the providers you configured in Pi. Shared
health, capacity, receipts, and parking metadata stay locally under Pi's agent
directory; credentials and raw response headers do not belong in those records.
Receipts are bounded and never injected into prompts. Pi retains its own session
content, including any input parked before dispatch; the shared parked index
must contain metadata only, not a second copy of your prompt.

## Small router comparison

These are **source-audit facts, not runtime benchmarks**, from the
[2026-11-08 audit](../../research_notes/Pi%20port%20feasibility/pi_auto_model_audit.md).
They apply only to the inspected versions; none of those packages was run.

| Inspected router                    | Selection and recovery found in source                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-auto-model` **0.9.2**           | Keyword analysis, optional LLM classification (off by default), and utility ranking; its failover target list spans tiers. |
| `pi-shift-router` **1.8.0**         | An LLM judge chooses fast/smart; its failover explicitly stays within the tier.                                            |
| `@pedro_klein/pi-gateway` **0.6.0** | User-declared tier aliases with same-slot fallback and atomically persisted unhealthy-until times.                         |
| Pi Adaptive                         | Explicit capability tiers without a classifier; same-tier recovery, evidence-backed escalation, and durable parking.       |

The audit found no durable park-and-auto-resume path in those three inspected
routers. This does not establish behavior of later versions.

## Development and release evidence

From the repository root:

```sh
npm run check -- --pkg pi
npm run verify -- --pkg pi
npm run verify -- --all
```

See the [test strategy](docs/TEST_STRATEGY.md) for the unit, real-SDK,
packed-host, and PTY evidence. Publication requires a full, unskipped
`npm run verify -- --all`; a scoped run alone is not release evidence.
