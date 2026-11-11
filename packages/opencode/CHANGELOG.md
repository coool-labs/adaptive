# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Picking `/adaptive` from the slash menu opens the menu on Enter, even when
  Enter inserts a newline and messages are sent with another key.

### Changed

- Typed `/adaptive <subcommand>` forms are gone from the OpenCode TUI; every
  action lives in the `/adaptive` menu (Status, Health, Parked work, Doctor…).
  Doctor hints name menu entries instead of typed subcommands.

### Tests

- Real-PTY journey with a custom keymap (submit on Ctrl+Return, Enter =
  newline) proves the slash pick opens the menu.

## [1.6.2] — 2026-11-10

# opencode-adaptive 1.6.2

Fixes the `/adaptive` and `/web-adaptive` command outage. When an older
Adaptive release had already run in the same long-lived OpenCode process,
the newer release reused its incompatible process ledger and died during
setup, so neither command existed. The shared ledger key is now versioned.

The outage is locked in with real E2E coverage: runtime, browser and
real-PTY TUI journeys all run beside a stale ledger, runtime boot failures
now surface plugin-load errors, and TUI turn tests wait for the configured
model instead of submitting into the startup window.

### Fixed

- Keep command setup working when an older Adaptive release has left an
  incompatible process ledger in the host. Version the shared ledger key.

### Tests

- Cover stale-ledger coexistence through real TUI `/adaptive` dialogs (global
  and project installs), browser `/web-adaptive` commands, and runtime RPC.
- Include plugin-load failures in runtime E2E startup diagnostics.
- Match sandbox RPC locations to the host's canonical project path on macOS.
- Wait for the configured model before submitting TUI turns, preventing a
  startup race into the host's sign-in flow.

## [1.6.1] — 2026-11-10

# opencode-adaptive 1.6.0

No behavioral changes. This release locks in the multi-provider subscription
experience with a new end-to-end regression suite: a goal configured across
ClaudeAgent / OpenAI subscriptions plus a paid OpenRouter fallback is proven to
walk the ladder in priority order, park and wake through quota resets, resume
across multiple limit changes, route sub-agents on their own tiers, and finish
unattended — including a regression test proving idle wake cycles never burn
the resume budget.

### Shared core

- test: fill behavioral coverage gaps and fix the defects they exposed (d4599b8)
- fix: revive a session-failed goal after owned recovery continues (b10b093)
- fix: keep parked work waiting through multi-hour quota blackouts (b880fc1)
- feat: share health, parked work, doctor and tool-support actions through core (aa864eb)

## [1.6.0] — 2026-11-09

# opencode-adaptive 1.6.0

No behavioral changes. This release locks in the multi-provider subscription
experience with a new end-to-end regression suite: a goal configured across
ClaudeAgent / OpenAI subscriptions plus a paid OpenRouter fallback is proven to
walk the ladder in priority order, park and wake through quota resets, resume
across multiple limit changes, route sub-agents on their own tiers, and finish
unattended — including a regression test proving idle wake cycles never burn
the resume budget.

### Shared core

- docs: record final acceptance verification and release boundary (5bd58cb)
- pi: park, observe, receipts, commands, host matrix and release-gate wiring (350fba1)
- pi: share resource health and recover within the tier (9545c6e)
- core: share failure events and cross-process probe ids; preflight TUI addon (fc9712a)
- pi: add tier and escalation tools with branch-aware task state (3bf8fdc)
- repo: extract shared core and testkit workspaces (c4b8c72)

## [1.5.0] — 2026-11-07

### Added

- Parked work resumes by itself. When every model in a session's tier is out of quota, the session waits and continues on the first model whose quota resets, without a new prompt. Before, parked work only resumed when some other turn finished in that session, which never happens after a failure, so the session stayed stuck. The wake time comes from the quota or rate-limit window, breaker cooldown, or sensed reset time; when nothing says when, Adaptive checks again after 5 minutes, backing off to every 30 minutes. The wait survives an OpenCode restart, and a session is resumed once even when the host loads the plugin twice. Waiting sessions resume independently: one long continued run does not hold up the others. A resume that fails backs off like a wake that found nothing, and a wait that keeps finding no usable model records its receipt once rather than on every check. After 5 resume cycles that each ran out of quota again, Adaptive gives up on that work and records a receipt saying so.
- The waiting session shows it: the TUI footer chip reads `Adaptive · waiting · resumes 18:42` (with a weekday or date when the reset is not today), the GUI composer shows a warning pill, and `status.get` returns `waiting` entries with the session, tier and the time the wake is due.

### Fixed

- A continuation that ran out of quota before the call that started it returned was mistaken for the earlier failure and ignored, leaving the session stuck. It now waits or moves on like any other quota failure.
- When the quota recovery budget for a task was used up, the task stopped silently. It now waits for a reset.
- Sending your own prompt or picking a model yourself in a session with saved work ends the wait, so that work no longer resumes on top of yours. The same goes for cancelling a run or starting one without a prompt (a shell or slash command). This holds in a session Adaptive is not driving (OFF or OBSERVE), and while a resume is still settling. A prompt in a session that never waited costs no extra storage read, so OFF still costs nothing.
- When the host loads the plugin twice, the two instances now share one process-wide record of Adaptive's own model switches and continuations. Before, the instance that heard the host could take a switch or continuation the other one made for a manual pick or a new user prompt, re-routing the unit and suppressing routing for the session. A switch the host rejects or a continuation it never delivers is withdrawn from that record, so the user's next prompt is not mistaken for one. A disposed instance can no longer pose as the one hearing the host, and the status the TUI and GUI read shows the wake time of the instance that will resume.

## [1.4.1] — 2026-11-06

### Fixed

- HTTP 402 (Payment Required) is classified as quota exhaustion for the whole provider. Gateways such as OpenRouter and Ofox, and providers such as Anthropic and DeepSeek, return 402 when the account balance runs out. Adaptive used to treat it as an unknown error, so it was never failed over. Now every model under that provider ID is skipped and work moves to another configured provider. A failure limited to one model still leaves its sibling models under the same provider eligible.

## [1.4.0] — 2026-11-05

### Added

- `/web-adaptive`: a server command for the web UI, including on mobile. The browser app never mounts plugin GUI bundles, but it lists server commands in the composer's slash menu. `/web-adaptive` shows the mode (off, observe, active) and every configured model with its tier and health, followed by help lines for switching. `/web-adaptive on` (same as `active`), `off` and `observe` switch the mode through the same settings write as the RPC, so an open TUI refreshes. Any other argument replies with the usage and changes nothing.
- Playwright web E2E for the command (`test/e2e-web/command.spec.ts`): the real composer's slash menu, status, switching with the server state verified, and the usage reply, at desktop, narrow and WebKit.

### Changed

- The settings write behind the `settings.set` RPC is one shared function (`patchSettings`), used by the RPC and the web command.

## [1.3.0] — 2026-11-04

### Added

- `/adaptive` in the GUI runs the same dialog flow as the TUI (status, models and tiers, mode, tier request, pin, receipts), over the same typed RPC. The settings page stays.
- GUI end-to-end suite (`npm run e2e:gui`): the built GUI bundle runs against a stand-in host wired to a real OpenCode server, with a 100% coverage gate on the GUI and shared-flow sources.

### Changed

- The `/adaptive` flow moved from `src/ui/tui/` to `src/ui/flow/` and is shared by both surfaces.
- The TUI model picker search is a case-insensitive substring match over the model's provider/model id and name.
- The TUI status table renders from the same code path whether or not models are configured.

### Fixed

- The `/adaptive` slash command is registered in the GUI.
- The GUI settings page now calls the Adaptive RPC with the open session's location, as the `/adaptive` flow does. Without it, a project-local install was unreachable whenever the host server's default location was not that project.

### Removed

- Unused code and options in the shared flow (`statusLine`, `validationMessage`, stale-index guards, unused select/confirm options).

## [1.2.3] — 2026-11-03

### Fixed

- A 429 whose message says the quota is spent (for example OpenAI's "You exceeded your current quota, please check your plan and billing details.") now quarantines the resource for the quota window and continues on the next usable resource, instead of being treated as a 30-second rate limit and retried every 30 seconds. 429s that name a rate limit or a per-minute ceiling keep the short window.

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

[1.6.2]: https://github.com/coool-labs/adaptive/releases/tag/opencode-v1.6.2
[1.6.1]: https://github.com/coool-labs/adaptive/releases/tag/opencode-v1.6.1
[1.6.0]: https://github.com/coool-labs/adaptive/releases/tag/opencode-v1.6.0
[1.2.3]: https://github.com/coool-labs/adaptive/releases/tag/v1.2.3
[1.2.2]: https://github.com/coool-labs/adaptive/releases/tag/v1.2.2
[1.2.1]: https://github.com/coool-labs/adaptive/releases/tag/v1.2.1
[1.2.0]: https://github.com/coool-labs/adaptive/releases/tag/v1.2.0
[1.0.1]: https://github.com/coool-labs/adaptive/releases/tag/v1.0.1
[1.0.0]: https://github.com/coool-labs/adaptive/releases/tag/v1.0.0
