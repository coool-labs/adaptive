# Pi Adaptive

Under development — not yet published or release-ready.

Capability-tier routing and bounded recovery for Pi. You choose the available
models and their tier order; Adaptive keeps provider failures separate from
capability gaps. Pi still owns the agent, tools, sessions, and model calls.

This is release-candidate documentation for the [Pi plan](../../docs/plans/pi-plugin.md),
not evidence that its parking, UX, or host-matrix gates have passed. The package
remains private at `0.0.0` until those gates are complete.

## Install

After publication:

```sh
pi install npm:@coool/pi-adaptive
```

The package declares Pi `>=1.5.0 <2`. The minimum/latest packed matrix must pass
before release; the declared range alone is not a compatibility test. For local
development, run `pi install ./packages/pi` from the repository root after building.

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
without changing a manually selected model. Choosing an Adaptive entry is the
release-candidate activation flow; choosing any normal model hands control back
immediately. With observation disabled and a normal model selected, Adaptive is
off. Off mode does not route or recover work.

Pinned tier entries ignore the agent's tier request and do not automatically
escalate. A concrete model pin also wins over automatic routing and recovery.
Use Auto when you want evidence-backed movement between tiers.

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
and first-run proposal are part of the release-candidate UX: proposals use
available-model metadata, not prompt classification, and require confirmation
before saving.

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

The release-candidate UI provides a footer status, one-line routing notes, and a
parked-work card. Notes stay out of model context. The note verbosity choices are
`changes` (default: model changes or problems), `all` (every unit), and `quiet`
(no transcript notes; status remains). Exact controls and rendering remain
subject to the M6 PTY review.

The planned `/adaptive` command uses the same dialog flow as OpenCode:

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

Command availability and doctor output must be checked against the completed M6
implementation. No interactive-note shortcut or default-model settings writer
is promised here without host verification.

## Waiting, parking, and cancellation

The release-candidate parking contract keeps work in the required tier:

- A known reset within two minutes waits in place with a countdown; Esc cancels.
- Longer waits persist parked work with its session and a shared local index.
  A cross-process claim permits at most one wake for a parked record.
- Work parked before dispatch is submitted only when resumed. After partial
  execution, recovery uses one hidden continuation message telling the agent to
  continue from existing session/workspace state, not replay the original prompt
  or redo completed steps. That small continuation **does** enter model context;
  operational notes and receipts do not.
- A new user message or manual model selection cancels parked work. User aborts
  never trigger failover or restart. A manual choice of another tier is explicit
  user intent, not automatic cross-tier recovery.
- Reopening a parked interactive session re-arms its wait; already-due work asks
  for confirmation. Automatic wakes are limited to **three per task**. Terminal
  infrastructure failures get at most **two automatic restarts per task**;
  capability escalation is separately bounded. Permanent auth/configuration
  errors do not enter recovery loops.

Headless print/JSON runs never show dialogs. Detached wake timers are not a
supported headless continuation mechanism: Pi can exit or invalidate the
extension context after the owned handler returns. Only an awaited, owned
recovery may continue that process; otherwise the run must end with a clear
unavailability error. Exact long-wait behavior is an M4/M7 acceptance check, not
a promise of a background daemon.

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

| Inspected router                           | Selection and recovery found in source                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `pi-auto-model` **0.9.2**                  | Keyword analysis, optional LLM classification (off by default), and utility ranking; its failover target list spans tiers. |
| `pi-shift-router` **1.8.0**                | An LLM judge chooses fast/smart; its failover explicitly stays within the tier.                                            |
| `@pedro_klein/pi-gateway` **0.6.0**        | User-declared tier aliases with same-slot fallback and atomically persisted unhealthy-until times.                         |
| Pi Adaptive **release-candidate contract** | Explicit capability tiers without a classifier; same-tier recovery, evidence-backed escalation, and durable parking.       |

The audit found no durable park-and-auto-resume path in those three inspected
routers. This does not establish behavior of later versions or claim that
Adaptive's unfinished release gates have passed.

## Development and release evidence

From the repository root:

```sh
npm run check -- --pkg pi
npm run verify -- --pkg pi
npm run verify -- --all
```

See the [test strategy](docs/TEST_STRATEGY.md) for the required unit, real-SDK,
packed-host, and PTY evidence. M4–M7 completion and a full, unskipped root verify
are required before publication. A green partial or scoped run alone does not
make this package release-ready.
