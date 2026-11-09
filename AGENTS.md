# AGENTS.md — working rules for this repository

Adaptive is a multi-host **execution supervisor**. The existing OpenCode v2 plugin
is `@coool/opencode-adaptive`; the Pi integration (`packages/pi`) is undergoing final release acceptance. Adaptive
assigns each execution episode to a capability tier (quick / standard /
advanced), escalates capability only on structured evidence, recovers within a
tier through provider failures and quota limits, and restores preferred
resources at safe boundaries. The host owns sessions, agents, tools, goals,
planning, and model invocation; Adaptive owns routing, health, capacity
awareness, failover, durable parking, and observability. It must never become
an agent framework, planner, task manager, goal engine, or provider marketplace.

Architecture and conventions are cloned from `@coool/opencode-decision-mode`
and `@coool/opencode-custom-provider`. Product contract: `docs/PRODUCT.md`;
`GOAL.md` is a local, gitignored execution objective, not shipped documentation.
Requirements with stable IDs: `docs/REQUIREMENTS.md` (`ADP-xxx`).

## Architecture rules (non-negotiable)

- **Dependency rule**: `packages/core/` and `packages/testkit/` never import any
  host SDK or plugin package. Plugins never import each other's implementation
  or host SDK. Platform access stays in each plugin's adapters and entry/RPC/UI
  bindings. OpenCode's `src/supervisor/` is wiring: it consumes
  structural mirrors of the host surfaces (`SupervisorOptions`), never the
  host package directly.
- **Pure core**: the scheduler is a pure function of
  `(settings, inventory, health, capacity, request context, clock) → Decision`.
  Clock and inventory are injected. Effects (model switches, receipts, park)
  are applied by the execution layer, not by the scheduler.
- **Extraction test**: every module must be instantiable/exercisable with
  fakes alone. If something needs the real plugin context to be constructed
  or tested, the seam is wrong — add a narrow interface.
- **OBSERVE and CONTROL share one scheduler.** There is no separate
  "simulation" router that can drift from production behavior. OBSERVE wraps
  the identical decision without applying it.
- **No dead knobs**: a parameter that no caller sets is removed, not kept
  "for later". No speculative abstractions, factories, registries, or DTO
  layers — every abstraction must name the concrete duplication, boundary,
  lifecycle, or testability problem it solves.
- **No dead code**: no TODO/FIXME placeholders, no commented-out code, no
  meaningless comments. Comments explain _why_ (invariants, empirical
  findings), never restate the code.

## Product invariants (violating any of these is a bug, not a feature)

- **Capability and availability are separate.** Infra failure (429, quota,
  timeout, 503, outage) triggers horizontal recovery _within the required
  tier_, never capability escalation. Escalation happens only on structured
  capability evidence (explicit request, reviewer rejection, deterministic
  verification failure, repeated structured failure, explicit blocker) with
  the schema requiring reason + evidence.
- **No LLM classifier and no keyword soup in the routing path.** Routing
  priority: user pin > explicit tier request > supported role hint >
  deterministic local evidence > default `standard`. Ambiguity defaults to
  `standard`; the scheduler may return `defer` (OpenCode's own choice stands).
- **Routing happens at safe boundaries only** (work-unit start/termination).
  A work unit is one execution episode; tool continuations stay in-unit,
  subagents are separate units sharing health. Never switch models mid-unit
  and never pull a productive model away mid-work to save money.
- **User cancellation (`interrupted{reason:'user'}`) never triggers
  failover.** Permanent config/auth errors never enter retry loops. All
  retry/escalation loops are provably bounded.
- **Half-open admits exactly one probe.** Concurrent callers join the probe's
  outcome or stay rejected — no thundering herd. 429s do not count toward
  breaker trips.
- **No hidden cross-tier borrowing.** Availability alone never silently moves
  work to another tier; if the tier is exhausted, park/wait (unless escalation
  independently established a stronger tier). Recovery of a preferred
  resource makes it eligible only at the next safe boundary.
- **Partial work is durable.** Completed tool side effects are treated as
  durable; recovery continues from session/workspace state (native
  continuation where the API supports it) — never a replayed original prompt,
  never duplicated ambiguous side effects.
- **Compatibility gates before preference.** Never route to a resource known
  not to fit the active context (capacity, tools, modalities, availability).
  Only user-configured providers are ever eligible.
- **Manual intent wins.** Do not fight manual model changes; `OFF` costs
  nothing and changes nothing.
- **Fail-open by default.** An internal Adaptive failure (sensor, receipts,
  optional adapter, unknown metadata) logs/notify-throttles and defers to
  ordinary OpenCode behavior. Privacy/configured-provider restrictions fail
  closed.
- **Privacy**: no telemetry leaves the machine; no secrets in state,
  receipts, logs, or RPC payloads; receipts are bounded (ring, oldest
  evicted) and never injected into prompts.

## TypeScript conventions

- Strictest sensible config (see `tsconfig.json`: `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `useUnknownInCatchVariables`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals`,
  `noUnusedParameters`). No `any`, no `@ts-ignore`/`@ts-nocheck`.
- State and error models are discriminated unions, exhaustively handled.
  Avoid non-null assertions and type assertions; if an upstream API genuinely
  forces one, isolate it at the adapter boundary, state why in a comment, and
  cover it with tests.
- Treat provider/OpenCode/persisted data as untrusted: narrow through
  defensive readers, hard-error on malformed payloads — never silently coerce.
  Validate RPC inputs at the boundary; error messages name the offending
  field (the message is the user's/model's only feedback).
- Inject time (`clock: () => number`) wherever behavior must be
  deterministic in tests. No uncontrolled process-global mutable state.

## OpenCode platform facts (empirical, from the sibling plugins)

Verified live in `@coool/opencode-decision-mode` and
`@coool/opencode-custom-provider`; re-verify against this plugin's wiring
before relying on them on a new surface:

- **RPC schemas must be zod (Standard Schema)** — raw JSON Schema literals
  are silently ignored by `ctx.rpc.register`.
- **RPC handler failures must be declared + returned via
  `context.error(...)`** — a plain `throw` becomes a server DEFECT and the
  client receives the generic `rpc.internal` message.
- **RPC handlers are location-scoped** — every client call must pass
  `{ location: context.location }`; a location-less request fails with
  `rpc.unavailable`. Global installs mask this bug: test with a
  project-local install.
- **Command-name shadowing** — a server command with the same name as a TUI
  slash entry appears twice in the palette; keep server commands distinctly
  named from TUI commands.
- **Command feedback must not wake the model** — admit via
  `ctx.session.synthetic({ ..., resume: false })`; synthetic input schedules
  a model turn by default.
- **Host hooks mutate their inputs; callbacks never return replacements** —
  the retry hook veto assigns `{ retry: false }` onto the input object.
- **`session.switchModel` at a safe boundary only** (`session.wait` first,
  then switch, then resume) — timestamps compared, never raced.

## Pi platform facts (empirical)

- Pi >= 1.5.0 < 2; tested against the packed minimum and `latest` host. SDK imports stay
  in `src/host` and `src/index.ts`; `@earendil-works/pi-ai` and `-pi-tui` are never bundled.
- Virtual models route at `route()`; `input` may return `{ action: "handled" }` to
  consume a prompt. Detached timers hit "extension ctx is stale", so headless waits must
  be awaited inside the owned handler/route.
- `registerEntries` must run in production or `adaptive.note` entries are never drawn.
- A dialog as tall as the terminal loses its last row; keep one spare row.
- Pi writes a session file only once it holds a conversation.

## Testing rules

- **Coverage gate is 100%** for statements, branches, functions, and lines
  (`vitest.config.ts` thresholds; `npm run coverage` fails otherwise). If a
  branch is unreachable, delete the branch instead of weakening the gate. No
  blanket exclusions, no `istanbul ignore`, no empty tests.
- **Regression policy**: every confirmed behavioral bug gets an automated
  regression test that fails before the fix and passes after. Never fix a
  behavioral defect without preserving a test that would catch its return;
  never fix a bug only by changing tests.
- Tests assert **behavior through public interfaces** with in-memory fakes;
  not implementation trivia. Adapters are tested with injected/mocked
  dependencies.
- **Determinism**: no sleeps, no real network, no real clocks in the normal
  suite. The deterministic fake provider (`test/fixtures/fake-provider/`)
  scripts success, streaming, tool calls, 429/Retry-After, quota/reset
  headers, 503, timeouts, disconnects, malformed responses, context
  rejection, and recovery-after-N on an ephemeral loopback port only.
- **Property/state-machine tests** (`fast-check`) for invariants: unavailable
  or incompatible resources never selected; infra failure never escalates
  capability; Observe/Control produce identical decisions; user pin always
  wins; budgets cannot loop; half-open admits one probe; no impossible health
  states.
- Packed plugin tests (`@coool/opencode-plugin-test`, packed mode) target
  `2.2.1`, `current`, and `latest` over the server and rpc surfaces —
  see `plugin-test.config.json`. Never run the normal suite against paid
  real models.

## Verification workflow

```sh
npm install                       # once; see CONTRIBUTING.md for native PTY prerequisite
npm run doctor                    # check local runtimes, dependencies and host
npm test                          # all unit projects, no real host startup
npm run check                     # affected-workspace fast gates (includes tooling)
npm run check -- --all             # all fast gates
npm run verify -- --all            # full build, pack, runtime/UI E2E, traceability
npm run verify -- --pkg opencode   # scoped full verification
```

Run commands from the repository root. Package-scoped scripts use npm workspaces.
OpenCode code, configuration, and tests currently live in `packages/opencode/`;
paths in the OpenCode-specific rules above are relative to that package.
`npm test` deliberately excludes runtime E2E; `verify` runs it after building.
Logs are in `test-artifacts/run/<workspace>/<step>.log`. The runner stops on the
first failure and prints any explicitly skipped gates. Do not call a skipped run
release-ready. A change is done when typecheck, tests, coverage, and lint are
clean — not merely when it compiles.

## Style

- Concise, imperative code; small modules with clear ownership; boring,
  explicit code over cleverness.
- No speculative exports or re-exports; each module's surface is what its
  consumers use.
- UI copy is short and human ("Unavailable until 18:42", not "Provider health
  optimization"); TUI/GUI are views over typed RPC and hold no local routing
  or settings state — the server is the single source of truth. The TUI is
  dialog-driven; its one JSX exception is the footer status chip in
  `src/tui.tsx` (host UI slots via `@opentui/solid`, mirroring the host's own
  slot pattern — the file-level `@jsxImportSource` pragma is required).
- Release only with `npm run release`. It verifies bumped artifacts before the
  release commit and uses per-package tags (`opencode-adaptive@X.Y.Z` and
  `pi-adaptive@X.Y.Z`). Historical `vX.Y.Z` tags belong to OpenCode only.
