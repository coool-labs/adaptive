# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-01

Initial release.

### Added

- Capability-tier routing (`quick` / `standard` / `advanced`) over user-configured ordered resource lists, resolved by a deterministic priority ladder (user pin → agent tier hint → default `standard`) with `defer` fallback — no LLM classifier in the routing path.
- Operating modes `off` / `observe` (default after install, with a one-time dismissible invitation) / `active`; observe and active share one scheduler, so observed decisions are exactly the applied ones.
- Settings persisted under the old `control` mode name migrate to `active` on read; patches must use the current vocabulary.
- Horizontal failure recovery within the required tier: native-retry-aware veto with owned continuation, per-resource circuit breaker with a single half-open probe, recovery of preferred resources at safe boundaries, and durable park/resume of blocked work with clean continuation (never a replayed prompt).
- Capability escalation only on structured evidence (context overflow, content policy) with a finite per-episode budget, recorded with reason and evidence.
- Error classification (rate limit, quota exhaustion, outage, timeout, auth, invalid model, context overflow, content policy, user cancellation) with definitive vs. inferred evidence levels.
- Decision receipts: a bounded ring (newest 200) recording admissions, escalations, parks, and recoveries with reasons, visible via TUI/GUI/RPC.
- Typed RPC surface (`settings.get`, `settings.set`, `status.get`, `receipts.list`) with a `settings-changed` event; the server plugin is the single source of truth for TUI and GUI surfaces.
- Per-session operating-mode override (ADP-054): every session can run under a different mode than the global default, managed through the `/adaptive` menu inside a session and the typed RPC surface (`session-mode.get`/`session-mode.set`, `session-mode-changed` event); overrides persist and are pruned when the session dies.
- `/adaptive` TUI command (mode switch, tier editor with model search / reorder / remove / validation, status and receipt inspection) and an experimental GUI settings page.
- Hierarchical resource health (provider → account → model → variant) with narrowest-scope quarantine.
- Capacity awareness from provider response headers (best-effort, never load-bearing).
- Fail-open on internal plugin failure; privacy and configured-provider restrictions fail closed.

[0.1.0]: https://github.com/Hacklone/opencode-adaptive/releases/tag/v0.1.0
