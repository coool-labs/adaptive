# Pi Adaptive

[![npm downloads](https://img.shields.io/npm/dt/@coool/pi-adaptive)](https://www.npmjs.com/package/@coool/pi-adaptive)

**Keep working when your models stop working.** Pi Adaptive is a resilience layer for
[Pi](https://github.com/earendil-works/pi): it spends your subscriptions before your paid
credits, rides out rate limits, outages, and quota walls, and finishes parked goals on its
own — across restarts. You configure the models; Adaptive handles everything that goes
wrong behind them.

```sh
pi install npm:@coool/pi-adaptive
```

Requires Pi `>=1.5.0 <2`. Published as
[`@coool/pi-adaptive`](https://www.npmjs.com/package/@coool/pi-adaptive).

## Why it's different

Most routers guess. Adaptive doesn't.

- **Subscriptions first, credits last.** Order your tiers — Claude and OpenAI before
  OpenRouter, say. When a subscription limit lifts mid-goal, Adaptive switches back
  automatically instead of burning paid tokens.
- **No classifier, no keyword sniffing.** Tiers are explicit, pins always win, and moving
  a task up a tier requires recorded evidence — never an LLM judge.
- **Goals survive restarts.** A known reset waits with a countdown; anything longer parks
  durably and wakes itself later. Recovery continues from the real session state — tool
  effects are never repeated.
- **Bounded by design, and it tells you.** At most five failed resume deliveries and two
  restarts per task, then a clear note in the transcript. `/adaptive resume` retries on
  your word. Auth and config errors never enter retry loops.
- **Nothing leaves your machine.** No telemetry, no daemon, no classifier requests.
  Health, receipts, and parked-work metadata stay under Pi's agent directory.

Not sure yet? Run it in **Observe mode** (the default): it shows what it would route and
recover without touching your manually selected model.

## Quick start

1. Install the plugin and start Pi. The **first run proposes tiers** from your configured
   models — confirm or edit them, nothing is saved until you do.
2. Pick an Adaptive entry in the model picker — `adaptive/auto` for tier routing, or pin
   `adaptive/quick`, `adaptive/standard`, `adaptive/advanced`. You can also let the agent
   request a tier itself with its `adaptive_tier` tool.
3. Work. When something fails, watch the transcript: recovery, parking, and resumes show
   up as one-line notes. `/adaptive status` and `/adaptive why` explain any decision.

Real-terminal frames at 80 columns: [screenshots](docs/screenshots/README.md).

## Your goals, unattended

When every model in a tier is exhausted, Adaptive parks the goal — session state, partial
progress, and all — and resumes it when a model recovers:

- Reopening Pi re-arms the wait; already-due work asks before resuming.
- A wake that finds everything still down is free: it re-arms and tries again later.
- Recovery continues from where the work stopped, via one hidden continuation — the
  original prompt is never replayed.
- A new message or a manual model pick cancels parked work. You always have the final
  say; user aborts never trigger failover.

Headless print/JSON runs stay dialog-free and end with a clear error instead of
background waits — there is no daemon.

## Setup

Configure credentials and models in Pi first; Adaptive routes only what Pi already knows.
Settings live at `~/.pi/agent/adaptive/settings.json`:

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

List several models per tier in your preference order — that order is the recovery path.
A tier entry may carry a Pi thinking level as `"variant": "high"`. The interactive editor
(`/adaptive tiers`) builds tiers from model metadata, never from prompts.

Pi's catalogue doesn't declare tool support, so verified declarations live in
`adaptive/capabilities.json` beside the settings file:

```json
{ "models": [{ "providerID": "your-provider", "id": "your-model", "tools": true }] }
```

Undeclared models are treated as unknown, never guessed.

## Commands

| Command                     | Purpose                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `/adaptive`                 | Main menu (also `Ctrl+Alt+A`).                               |
| `/adaptive status`          | Tiers, resource health, capacity evidence.                   |
| `/adaptive why`             | Explain the latest routing decision.                         |
| `/adaptive tiers`           | Edit ordered tier membership.                                |
| `/adaptive health`          | Inspect health; manually mark a resource healthy.            |
| `/adaptive resume`          | Retry parked work now (bypasses the give-up budget).         |
| `/adaptive cancel`          | Cancel parked work.                                          |
| `/adaptive observe on\|off` | Enable or disable observation of manual-model sessions.      |
| `/adaptive doctor`          | Check host, credentials, capabilities, storage, and parking. |

## For comparison

A source-level audit of alternative Pi routers (2026-11-08; no runtime benchmarks) found
keyword or LLM-judge selection in `pi-auto-model` and `pi-shift-router`, and no durable
park-and-auto-resume path in any of them. Adaptive's approach is explicit tiers,
evidence-backed escalation, and durable parking. Details in the
[audit notes](../../research_notes/Pi%20port%20feasibility/pi_auto_model_audit.md).

## Development

From the repository root:

```sh
npm run check -- --pkg pi
npm run verify -- --pkg pi
```

The [design plan](../../docs/plans/pi-plugin.md) and
[test strategy](docs/TEST_STRATEGY.md) cover the architecture and the release evidence.
