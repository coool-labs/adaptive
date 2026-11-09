# Adaptive

Keep your goals running when models fail. Adaptive supervises execution in
[coding agents](https://opencode.ai): it routes every task to the first model
that works, recovers from quota limits, rate limits, and outages inside the
tier the work needs, and parks what cannot continue until a model returns —
so a long goal finishes without you babysitting it.

**Put your subscriptions first, pay-as-you-go last.** With Claude and OpenAI
subscriptions at the top of the standard tier and an OpenRouter model at the
bottom, Adaptive spends your subscriptions before your credits, falls to the
API while they are out, and switches back the moment a limit resets — as many
times as limits change mid-goal. Work that runs out of models entirely waits
and resumes itself, even across a process restart. Completed tool calls are
never repeated.

## What makes it different

- **No classifier, no prompt sniffing.** Tiers are lists you own, in an order
  you choose. Routing follows fixed rules, not an extra LLM call that may
  misread the prompt.
- **Availability is not capability.** A 429 or a dead provider never silently
  moves work to a stronger or weaker tier. Moving up requires real evidence:
  a context overflow, a policy rejection, or an explicit agent request — and
  it is budgeted.
- **Fail-open by design.** If Adaptive itself malfunctions, your agent keeps
  working as it would without it. There is no background daemon and no
  telemetry: receipts and health stay on your machine.
- **Observe before you trust.** New installs watch only: they record every
  decision they would have made, with the reason, and change nothing until
  you switch them to `active`.

## Packages

| Package                                                 | Install                                        | Needs            |
| ------------------------------------------------------- | ---------------------------------------------- | ---------------- |
| [@coool/opencode-adaptive](packages/opencode/README.md) | `opencode plugin add @coool/opencode-adaptive` | OpenCode ≥ 2.2.1 |
| [@coool/pi-adaptive](packages/pi/README.md)             | `pi install npm:@coool/pi-adaptive`            | Pi ≥ 1.5.0 < 2   |

Both are configured from a single `/adaptive` menu — models, tier order, and
mode — and share the same decision core: one scheduler, one health model, one
parking format (`packages/core`, a private workspace), so behavior you verify
in one host is the behavior the other one runs.

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
