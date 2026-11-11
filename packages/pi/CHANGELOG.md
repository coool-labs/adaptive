# Changelog

## [Unreleased]

### Changed

- Doctor hints name `/adaptive` menu entries (Models, Health, Parked work)
  instead of typed subcommands.

## [1.0.1] — 2026-11-10

# pi-adaptive 1.0.0

First stable release of Adaptive for Pi. Goals keep running until they are
finished, regardless of how model availability changes behind the scenes:

- Tier routing through the `auto` / `quick` / `standard` / `advanced` virtual
  models, with in-unit stickiness so a productive model is never pulled away
  mid-unit.
- Subscription-first scheduling: configured models fail over within the
  required tier, and exhaustion is recovered horizontally — capability never
  escalates because a subscription ran out.
- Shared health across processes: one session's 429 steers the next session's
  admission instantly, and the half-open breaker admits exactly one probe.
- Non-stop parking semantics: a wake that finds every model still limited
  re-arms for free and never consumes the resume budget; only a resumed run
  that fails again counts. After five failed deliveries the park gives up
  visibly in the transcript and the chip, and `/adaptive resume` still
  dispatches it manually at any time.

### Shared core

- test: fill behavioral coverage gaps and fix the defects they exposed (d4599b8)
- fix: revive a session-failed goal after owned recovery continues (b10b093)
- fix: keep parked work waiting through multi-hour quota blackouts (b880fc1)
- feat: share health, parked work, doctor and tool-support actions through core (aa864eb)

## [1.0.0] — 2026-11-09

# pi-adaptive 1.0.0

First stable release of Adaptive for Pi. Goals keep running until they are
finished, regardless of how model availability changes behind the scenes:

- Tier routing through the `auto` / `quick` / `standard` / `advanced` virtual
  models, with in-unit stickiness so a productive model is never pulled away
  mid-unit.
- Subscription-first scheduling: configured models fail over within the
  required tier, and exhaustion is recovered horizontally — capability never
  escalates because a subscription ran out.
- Shared health across processes: one session's 429 steers the next session's
  admission instantly, and the half-open breaker admits exactly one probe.
- Non-stop parking semantics: a wake that finds every model still limited
  re-arms for free and never consumes the resume budget; only a resumed run
  that fails again counts. After five failed deliveries the park gives up
  visibly in the transcript and the chip, and `/adaptive resume` still
  dispatches it manually at any time.

### Shared core

- docs: record final acceptance verification and release boundary (5bd58cb)
- pi: park, observe, receipts, commands, host matrix and release-gate wiring (350fba1)
- pi: share resource health and recover within the tier (9545c6e)
- core: share failure events and cross-process probe ids; preflight TUI addon (fc9712a)
- pi: add tier and escalation tools with branch-aware task state (3bf8fdc)

Initial Pi integration; not yet published.

- Add four native virtual models: Auto, quick, standard, and advanced.
- Reuse the shared scheduler with configured tier order and explicit tool-capability declarations.
- Add branch-aware `adaptive_tier` and reason/evidence `adaptive_escalate` tools.
- Share resource health and passive provider capacity through locked local state; recover from provider failures within the same tier, with bounded retries, restarts, and wakes.
- Park work when a tier is exhausted: short waits stay in place with a countdown, longer waits are durable, cross-process safe, and resume once; Esc, a new prompt, or a manual model pick cancels.
- Add observe mode (the default), which runs the same scheduler without changing a manually selected model, plus bounded decision receipts and one-line transcript notes (`quiet`, `changes`, `all`).
- Keep one routing footer visible for normal, recovering, escalated, observing, setup, and degraded states, independently of quiet notes; waits and parks take priority in the same item, and model/session changes clear stale status.
- Preserve full-context compatibility in observation and dispatch, including tool-result images and configured thinking variants; virtual models remain active even when observation is disabled globally.
- Persist initial parked prompts through Pi's normal conversation history, and honor the explicit pinned-tier escalation preference without overriding concrete model pins.
- Add `/adaptive` (status, why, tiers, health, resume, cancel, observe on|off, doctor), a first-run tier proposal that saves only after confirmation, and Ctrl+Alt+A.
- Add deterministic tests, real-Pi SDK faux-provider scenarios, a versioned provider-error corpus, a packed minimum/latest host matrix over SDK, JSON, and real-terminal surfaces, and requirement traceability. See the [test strategy](docs/TEST_STRATEGY.md).

[1.0.1]: https://github.com/coool-labs/adaptive/releases/tag/pi-v1.0.1
[1.0.0]: https://github.com/coool-labs/adaptive/releases/tag/pi-v1.0.0
