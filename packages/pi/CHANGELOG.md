# Changelog

## [Unreleased]

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
