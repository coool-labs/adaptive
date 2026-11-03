# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.2] — 2026-11-03

### Fixed

- Package metadata and release links point at the correct repository (coool-labs/opencode-adaptive).

## [1.2.1] — 2026-11-03

### Fixed

- Terminal quota failures now automatically continue on the next usable resource in the same tier, including failures on a manually selected model. Recovery uses current session state, requires no second user prompt, and has a finite per-task budget.
- Explicit shared subscription/session limits and depleted credit balances quarantine the configured provider; model-specific quota stays model-scoped across variants. Other providers remain independent, even when they offer the same model.
- A blocked manual selection stops suppressing routing after fallback, allowing the preferred resource to return at a later safe boundary when its quota window expires.
- Steering messages during active work no longer re-admit the episode, change its model, or reset recovery budgets. Tier changes apply at the next fresh episode.

### Added

- Real-host regressions for automatic recovery through two exhausted models to a third, manual-pick quota recovery with model/provider scope, and steering that completes without switching models mid-work.
- Deterministic recovery-edge tests for cancellation, OFF/OBSERVE, exhausted tiers, duplicate retry/terminal signals, bounded continuation, and probe release.

## [1.2.0] — 2026-11-03

Fallback correctness for real provider failures, plus real-host end-to-end coverage.

### Fixed

- The classifier recognizes subscription limits as quota exhaustion (ADP-009): "You've hit your session limit · resets …", "usage limit reached", "out of credits", and similar provider phrasings now quarantine the resource with a bounded window instead of reading as an unknown failure, so the next admission falls back to the tier's next resource (verified against the real ChatGPT and Claude session-limit messages).
- A health-blocked manual model pick yields to the configured fallback: the pick suppresses Adaptive's admission only while the picked resource stays usable (ADP-028).
- The tier editor stays on the tier page after each add/move/remove instead of bouncing back to the tier list.

### Added

- Real-host end-to-end coverage (runtime-e2e): provider failure modes (timeout, mid-stream disconnect, malformed response, 401 auth without retry loops), restart durability (settings, modes, tier requests, receipts), manual-selection semantics, once-only breaker counting, and the per-task escalation budget (45 runtime-e2e tests total).

## [1.0.1] — 2026-11-03

Post-release review fixes: correctness, durability, and honest behavior — no new features.

### Fixed

- Tier requests persist through a bounded store (ADP-055): a request recorded through the TUI's RPC instance now reaches the routing instance without a restart (the TUI host loads the plugin twice).
- A preferred resource whose breaker is due for its half-open probe is probed at its preferred position instead of being passed over for a ready sibling — it can actually fail back; probes that never dispatch are released still-due instead of restarting their backoff, and a probe's real outcome reaches the breaker instead of being swallowed by unit cleanup.
- Escalation budget is finite per task (one user prompt and its continuations), not per unit (ADP-015); escalation never targets the resource that failed when the host reports it as variant `default`.
- Quota exhaustion without a reset time is bounded by a default window instead of blocking the resource permanently (ADP-012); persisted parsers reject — rather than rewrite — malformed keys, windows, and usage above 100% (a Codex window reporting >100% voids the snapshot instead of leaving the other window to speak for it).
- Manual model selections are honored (ADP-028): a user pick suppresses Adaptive's prompt admission for the session until a tier request, mode change, or settings pin steers back; auxiliary requests (titles, compaction) no longer overwrite primary model attribution; one failed attempt counts once toward the breaker instead of up to three times.
- Persistent stores (receipts, parked work, session modes, tier requests, capacity, health, settings) serialize their mutations, so concurrent reports can no longer lose updates or duplicate receipt IDs.
- A failed plugin setup rolls back its registrations instead of leaking hooks and subscriptions; cleanup awaits every disposal; hook registration failures roll back already-acquired hooks.
- RPC: the schema gate rejects empty and oversized session identifiers, read failures reach the client through a declared internal error (with their message) instead of a generic defect, and internal failures are logged rather than thrown.
- Interrupted recoveries re-check the session before continuing (user interruption or mode `off` during the settle aborts the recovery); a session-read failure no longer prunes durable state except when the session is truly gone; tracker maps are bounded.
- The TUI carries the host location on every RPC call, so project-local installs reach the handlers; rejected dialogs settle instead of leaving the menu hanging.
- The tier editor refetches settings every pass (no stale rows); the status table renders window/reset times as full dates; receipt reasons are explained honestly (including `pin-incompatible`, `escalation-not-justified`, `escalation-budget-exhausted`); the GUI rolls back an unsaved dropdown after a failed save.
- Packaging: `dist` is cleaned at build (no stale files ship), the Darwin-only PTY is no longer a required devDependency (works on any platform via `npm ci`), and source maps carry their sources.

## [1.0.0] — 2026-11-03

Initial release.

### Added

- Capability-tier routing (`quick` / `standard` / `advanced`) over user-configured ordered resource lists, resolved by a deterministic priority ladder (user pin → session tier request or agent tier hint → default `standard`) with `defer` fallback — no LLM classifier in the routing path.
- Tier requests (ADP-055): the agent declares the current task's tier through the `adaptive_tier` tool (a typed sibling of `adaptive_escalate`, plain JSON Schema, code-mode bundled); the declaration is sticky per session (bounded at 1024, insertion-order evicted, pruned when the session dies), steers admissions between the user pin and default hints, defers with `tier-not-configured` when the requested tier has no configured resources, and is cleared with a null tier.
- Tier menu in the `/adaptive` TUI (ADP-055): inside a session, `Tier` requests a tier for that session (or returns to the routing ladder) over `tier-request.get`/`tier-request.set` with the `tier-request-changed` event.
- Sensed subscription capacity in the Status table (ADP-056): a resource whose provider reports usage headers shows `used N%, resets HH:MM` in its STATE column. Readings persist through a bounded capacity mirror so the instance serving status sees what the observing instance saw (the TUI host loads the plugin twice).
- Biome lint gate (`npm run lint:biome`, config in `biome.json`) alongside ESLint and Prettier: catches style anti-patterns (nested ternaries, parameter reassignment, string concatenation, collapsible ifs); wired into CI and `verify:release`.
- Operating modes `off` / `observe` (default after install, with a one-time dismissible invitation) / `active`; observe and active share one scheduler, so observed decisions are exactly the applied ones.
- Settings persisted under the old `control` mode name migrate to `active` on read; patches must use the current vocabulary.
- Horizontal failure recovery within the required tier: native-retry-aware veto with owned continuation, per-resource circuit breaker with a single half-open probe, recovery of preferred resources at safe boundaries, and durable park/resume of blocked work with clean continuation (never a replayed prompt).
- Capability escalation only on structured evidence (context overflow, content policy, or an explicit agent request through the `adaptive_escalate` tool) with a finite per-episode budget, recorded with reason and evidence.
- Error classification (rate limit, quota exhaustion, outage, timeout, auth, invalid model, context overflow, content policy, user cancellation) with definitive vs. inferred evidence levels.
- Decision receipts: a bounded ring (newest 200) recording admissions, escalations, parks, and recoveries with reasons, visible via TUI/GUI/RPC.
- Typed RPC surface (`settings.get`, `settings.set`, `status.get`, `receipts.list`) with a `settings-changed` event; the server plugin is the single source of truth for TUI and GUI surfaces.
- Per-session operating-mode override (ADP-054): every session can run under a different mode than the global default, managed through the `/adaptive` menu inside a session and the typed RPC surface (`session-mode.get`/`session-mode.set`, `session-mode-changed` event); overrides persist and are pruned when the session dies.
- `/adaptive` TUI command (mode switch, tier editor with model search / reorder / remove / validation, status and receipt inspection) and an experimental GUI settings page.
- Hierarchical resource health (provider → account → model → variant) with narrowest-scope quarantine.
- Capacity awareness from provider response headers (best-effort, never load-bearing).
- Fail-open on internal plugin failure; privacy and configured-provider restrictions fail closed.

[1.2.2]: https://github.com/coool-labs/opencode-adaptive/releases/tag/v1.2.2
[1.2.1]: https://github.com/coool-labs/opencode-adaptive/releases/tag/v1.2.1
[1.2.0]: https://github.com/coool-labs/opencode-adaptive/releases/tag/v1.2.0
[1.0.1]: https://github.com/coool-labs/opencode-adaptive/releases/tag/v1.0.1
[1.0.0]: https://github.com/coool-labs/opencode-adaptive/releases/tag/v1.0.0
