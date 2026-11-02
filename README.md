# @coool/opencode-adaptive

An execution supervisor plugin for [OpenCode](https://opencode.ai) v2. Per execution episode it decides which configured capability tier and resource should run, escalates capability only on structured evidence, keeps work moving through rate limits and outages, and lets preferred resources recover naturally — without replacing any part of OpenCode.

OpenCode owns sessions, agents, tools, `/goal`, and model invocation. Adaptive owns the layer between them: tier routing, health, failover, escalation, and decision receipts.

## Why it exists

OpenCode runs every episode on one model. When that model is rate-limited, down, or out of quota, the episode either fails or grinds through retries. And when the work is trivial or genuinely hard, the same model runs it regardless. Adaptive separates **capability** (how strong a model the work needs) from **availability** (which resources are actually usable right now): capability changes only on structured evidence, availability problems recover horizontally within the tier.

## Install

Add the plugin to your project's `opencode.json`:

```json
{
  "plugins": ["@coool/opencode-adaptive"]
}
```

OpenCode installs it from npm on the next start. Requires OpenCode ≥ 2.2.1 and Node ≥ 20.19.

After the first start, Adaptive runs in **observe** mode: it records what it would have done without touching your sessions. A one-time invitation in `/adaptive` walks you through configuration.

## 2-minute setup

1. Start OpenCode (TUI or desktop).
2. Run `/adaptive` (TUI) or open the Adaptive settings page (experimental GUI surface).
3. Fill the tier lists in the order you prefer them, for example:
   - **Quick** — fast models for small edits.
   - **Standard** — your default workhorse.
   - **Advanced** — the strongest model you have.
4. Switch the mode from **Observe** to **Control** when the receipts look right.

## Tiers

A tier is an **ordered list of resources** you configure. Order is policy: Adaptive never reorders it, never borrows across tiers, and never overrides it for cost.

- **Quick** — cheap/fast work: short edits, formatting, small lookups.
- **Standard** — ordinary execution episodes.
- **Advanced** — hard work that earns a stronger model.

A resource names a concrete `providerID`/`modelID`, optionally with a variant.

## Observe vs Control

- **Off** — Adaptive does nothing.
- **Observe** (default after install) — Adaptive routes, classifies, and records decision receipts, but applies nothing. Every decision it would have made is visible in the receipts.
- **Control** — Adaptive applies its decisions: model switches happen only at safe boundaries (work-unit start/termination), never mid-episode.

### Per-session mode

The operating mode is global, but every session can override it. Open `/adaptive` inside a session: the mode menu shows **Follow global (observe)** first — picking a mode there sets an override for that session only, and picking **Follow global** clears it again. Everywhere else (home, other sessions) the global mode applies unchanged; the menu title always shows the session's effective mode. Overrides persist across restarts, are pruned when the session dies, and are managed over RPC (`session-mode.get` / `session-mode.set`, `session-mode-changed` event).

## Example configuration

Settings live on the server; every surface (TUI, GUI, RPC) edits the same truth. The equivalent of the setup above as a settings patch:

```json
{
  "mode": "active",
  "tiers": {
    "quick": [{ "providerID": "fake", "id": "small-model" }],
    "standard": [{ "providerID": "fake", "id": "main-model" }],
    "advanced": [{ "providerID": "fake", "id": "big-model" }]
  },
  "pin": null,
  "agentTiers": { "build": "standard" }
}
```

`pin` names a concrete model and outranks every other routing input. `agentTiers` maps an agent name to a tier (a role hint). Both are optional.

## Recipe: subscriptions first

If you pay for subscriptions and keep a metered API as the safety net, list the subscriptions first:

```json
{
  "mode": "active",
  "tiers": {
    "standard": [
      { "providerID": "openai", "id": "gpt-5-codex" },
      { "providerID": "anthropic", "id": "claude-sonnet-4-5" },
      { "providerID": "openrouter", "id": "anthropic/claude-sonnet-4.5" }
    ]
  }
}
```

Order is policy, so the subscriptions are used first and OpenRouter only when both are windowed (rate limited) or exhausted. Nothing is force-failed back: once a preferred resource recovers, it is used again automatically at the next safe boundary — never mid-episode. The Status page shows each subscription's sensed usage (`used 72%, resets 18:42`) when the provider reports it, so you can see how close a window is to running out. Substitute the model IDs you actually have configured.

## How routing behaves

Routing happens only at safe boundaries, by a deterministic priority ladder — no LLM classifier, no keyword soup:

1. **User pin** — wins over everything.
2. **Agent tier hint** — the configured tier for the active agent.
3. **Default `standard`** — ambiguity resolves here.

If the required tier has no usable resource, Adaptive waits or parks the work — it never silently moves it to another tier. A compatibility gate skips resources that cannot fit the active context (unavailable, unknown, or unusable for the request); skipped candidates appear in the decision receipt.

## How failover and recovery behave

- Infrastructure failure (rate limits, quota, timeouts, outages) **never** escalates capability. It recovers horizontally within the required tier: the next resource in the same tier list.
- OpenCode's own retries stay in charge; Adaptive vetoes a retry only when a better same-tier resource exists, then continues the episode on it with a clean continuation prompt. User cancellations never trigger failover.
- Repeated failures trip a **circuit breaker** per resource: it stops being selected, and exactly one probe is admitted after a cooldown to check recovery.
- A preferred resource that went down is used again at the next safe boundary once it recovers. Nothing is force-failed back.
- Work that cannot run (whole tier blocked) is **parked durably** and resumes at an idle boundary when a resource returns. Completed tool side effects are treated as durable and never replayed.

## Quota and capacity behavior

Quota exhaustion (fixed-window exhaustion, `x-ratelimit` evidence) is classified separately from a transient rate limit: quota failures are not retried, only failed over. Header-based capacity sensing is best-effort and never load-bearing — WebSocket providers bypass the HTTP hooks OpenCode exposes.

## Escalation

Capability escalates only on structured evidence — context overflow or content-policy rejection — with a finite budget (2 escalations per episode), recorded with reason and evidence in the receipt. Escalation moves to the next tier's first resource (or a stronger variant of the same model). Infra failure never escalates.

## `/goal` compatibility

Adaptive does not manage goals. Native `/goal` episodes are ordinary execution episodes to the supervisor: routing, recovery, and receipts behave the same. The goal loop keeps running; Adaptive keeps supplying an available resource.

## Privacy

Nothing leaves the machine. No telemetry, no network calls of its own, and no secrets in settings, receipts, logs, or RPC payloads. Receipts are a bounded ring (newest 200) and are never injected into prompts.

## Supported OpenCode versions

Minimum **2.2.1**; the packed-plugin test suite runs against 2.2.1, current, and latest OpenCode hosts.

## Limitations

- **GUI surface:** the Adaptive settings page targets OpenCode's experimental GUI, which no released OpenCode host mounts yet — the browser UI served by `opencode serve` never loads plugin GUI bundles, and the desktop app (tested through 1.19.5) does not either. Settings work today through the `/adaptive` TUI command (OpenCode ≥ 2.2.x; the desktop app must be ≥ 1.19.5 to accept the `plugins` config key) and the typed RPC surface.
- **No cross-tier borrowing:** if a tier is exhausted, work waits or parks. This is deliberate.
- **No de-escalation:** after an episode escalates, the next episode routes fresh; Adaptive does not downgrade a running episode.
- **WebSocket-native providers** bypass the HTTP hooks used for capacity sensing; their capacity view is best-effort.

## Troubleshooting

- **Nothing changes** — you are probably in observe mode (the default). Check the mode in `/adaptive` or `status.get`; switch to active.
- **A model is never picked** — it must exist in the provider's configured inventory (`opencode.json` models). Unknown resources are skipped, not guessed.
- **`Plugin failed: <target>` toast in the TUI** — the plugin bundle failed to load; reinstall the package or check that the entrypoint builds (`npm run build` in a source checkout).
- **All resources parked / work waits** — every resource in the required tier is blocked (rate limits or an open breaker). Wait for the cooldown probe or add another resource to the tier.
- **Inspect decisions** — receipts record every admission, escalation, park, and recovery with reasons; read them via `/adaptive` or the `receipts.list` RPC method.

## Development

```sh
npm install
npm run verify:release   # full gate chain (format, lint, types, tests, coverage, build, e2e, traceability)
```

Individual gates and the regression policy are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs

- [docs/PRODUCT.md](docs/PRODUCT.md) — product definition, tenets, scope.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, dependency rules, decision flow.
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — requirements with stable IDs (ADP-xxx).
- [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) — test layers, scenario maps, limitations.
- [CONTRIBUTING.md](CONTRIBUTING.md) — gates, regression policy, traceability.
- [CHANGELOG.md](CHANGELOG.md) — release history.
