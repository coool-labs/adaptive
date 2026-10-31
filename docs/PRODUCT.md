# Product

## Definition

OpenCode Adaptive (`@coool/opencode-adaptive`, plugin ID `coool.adaptive`) is an execution supervisor for OpenCode v2. Per execution episode it decides which configured capability tier and resource should run, escalates capability on structured evidence, keeps work moving through rate limits and outages, and lets preferred resources recover naturally — without replacing any part of OpenCode.

**The right model for the work, for as long as the work takes.**

## Tenets

1. OpenCode owns sessions, agents, tools, `/goal`, planning, reviewers, and model invocation. Adaptive owns tier routing, compatibility, preference, health, capacity awareness, failover/recovery, escalation, durable waiting, and observability.
2. Explicit user intent outranks every heuristic; ambiguity defaults to `standard`; the router may `defer`.
3. Infrastructure failure never means "harder work": it recovers horizontally within the tier.
4. User-configured resource order is policy. Adaptive never silently overrides it for cost, and never borrows across tiers.
5. Work units are OpenCode execution episodes — Adaptive invents no semantic tasks, goal engine, planner, or memory.
6. If Adaptive cannot see trustworthy evidence, it does not guess.
7. Adaptive itself must never be a single point of failure: fail open, except privacy restrictions.

## v1 scope

- Three capability tiers (`quick`, `standard`, `advanced`) as ordered user-configured resource lists (provider / account / model / variant).
- Event-driven work-unit tracking, deterministic routing with priority ladder and `defer`, compatibility gate, hierarchical resource health, error classification, circuit breaker with single half-open probe, draining, durable park/resume, native-retry-aware horizontal recovery, evidence-driven escalation with finite budgets, decision receipts, modes OFF/OBSERVE/CONTROL (OBSERVE default), typed RPC, `/adaptive` TUI command, GUI SettingsPage.

## Non-goals (v1)

- No agent framework, planner, task manager, memory, goal engine, coding methodology, prompt framework, or provider marketplace.
- No LLM-based routing classifier; no keyword-soup classifiers; no cost-optimizing reordering of user lists.
- No cross-tier borrowing, no failback mode, no de-escalation engine, no threshold sliders.
- No self-learning routing (receipts and scheduler interfaces are shaped so it can be added later without a core rewrite).
- No telemetry, ever.

## User experience

- **First install:** OBSERVE mode, one dismissible invitation to configure.
- **TUI:** `/adaptive` — mode switch, tiered model editor (search real models, variants, reorder, remove, validation), status and decision inspection.
- **GUI:** native SettingsPage on OpenCode's experimental GUI surface — the same settings, same server truth. Works on desktop and narrow widths.
- **Copy** is short and human ("Unavailable until 18:42", "Using GLM while Codex is unavailable").

## Supported OpenCode versions

Minimum **2.2.1**; tested against 2.2.1, current, and latest (packed-plugin tests). Requires Node ≥ 20.19 per current OpenCode.

## Known upstream limitations (verified, see docs/research/OPEN_CODE_API.md)

- No native capability-tier API — tier names are an ecosystem proposal, isolated behind our tier-policy adapter.
- OpenCode owns retries: the `retry` hook can veto/adjust within the built-in hard attempt limit; after exhaustion only clean continuation is possible.
- `experimental.idle` does not fire after failure/interruption — parking uses its own state plus `execution.failed`.
- WebSocket providers (OpenAI OAuth/Codex) bypass `http.request/response` — header-based capacity sensing is best-effort and never load-bearing.
- `http.response` body is one-shot (clone before reading).
- `session.model.selected` fires for manual and plugin switches — Adaptive tags its own switches.
- GUI plugin surface is experimental — isolated behind a thin adapter; business logic stays server-side.
