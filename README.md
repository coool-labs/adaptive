# Adaptive

**Your goals shouldn't stop when your models do.** Adaptive is a resilience layer for
coding agents: it routes every task to the first model that works, spends your
subscriptions before your paid credits, and parks anything that can't continue until a
model returns — so a long goal finishes without you babysitting it.

Put your Claude and OpenAI subscriptions at the top of your list and an OpenRouter model
at the bottom. Adaptive spends the subscriptions first, rides out their limits on the API,
and switches back the moment a limit resets — as many times as limits change mid-goal.
Work that runs out of models entirely waits and resumes itself, even across a restart.
Completed tool calls are never repeated.

## Why it's different

- **No classifier, no prompt sniffing.** Routing follows fixed rules over tier lists you
  own — not an extra LLM call that may misread the prompt.
- **Availability is not capability.** A 429 or a dead provider never silently moves work
  to a stronger or weaker tier. Moving up requires real evidence, and it is budgeted.
- **Fail-open by design.** If Adaptive itself malfunctions, your agent keeps working as it
  would without it. No daemon, no telemetry: receipts and health stay on your machine.
- **Observe before you trust.** New installs watch only: they record every decision they
  would have made, with the reason, and change nothing until you switch to `active`.

## Get it

### OpenCode — [`@coool/opencode-adaptive`](https://www.npmjs.com/package/@coool/opencode-adaptive)

[![npm version](https://img.shields.io/npm/v/@coool/opencode-adaptive)](https://www.npmjs.com/package/@coool/opencode-adaptive)
[![npm downloads](https://img.shields.io/npm/dt/@coool/opencode-adaptive)](https://www.npmjs.com/package/@coool/opencode-adaptive)

```sh
opencode plugin add @coool/opencode-adaptive
```

Set up entirely from the `/adaptive` menu — no config files, no model IDs to type. See the
[OpenCode guide](packages/opencode/README.md). Needs OpenCode ≥ 2.2.1.

### Pi — [`@coool/pi-adaptive`](https://www.npmjs.com/package/@coool/pi-adaptive)

[![npm version](https://img.shields.io/npm/v/@coool/pi-adaptive)](https://www.npmjs.com/package/@coool/pi-adaptive)
[![npm downloads](https://img.shields.io/npm/dt/@coool/pi-adaptive)](https://www.npmjs.com/package/@coool/pi-adaptive)

```sh
pi install npm:@coool/pi-adaptive
```

Tier routing, durable park-and-resume, and evidence-backed escalation for
[Pi](https://github.com/earendil-works/pi). See the [Pi guide](packages/pi/README.md).
Needs Pi ≥ 1.5.0 < 2.

Both hosts share one decision core (`packages/core`): one scheduler, one health model, one
parking format — behavior you verify in one host is the behavior the other one runs.

## Development

Run commands from this directory:

```sh
npm install
npm test                         # deterministic unit suites, all workspaces
npm run check                    # affected workspaces; no paid models
npm run check -- --all            # all workspaces
npm run verify -- --pkg opencode  # complete release gate, including real-host E2E
npm run doctor                   # local environment diagnostics
npm run release:status           # changes per publishable package, including core
npm run release -- --dry-run      # safe version/changelog preview; no publication
```

Checks print a short verdict and retain full logs under `test-artifacts/run/`.
`--skip e2e:tui` permits a partial verification, but its verdict explicitly records
the skip; it is not a release-ready result.

See [CONTRIBUTING.md](CONTRIBUTING.md), the [architecture](docs/ARCHITECTURE.md), the
[monorepo migration plan](docs/plans/monorepo.md), and the
[requirements](docs/REQUIREMENTS.md).
