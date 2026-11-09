# Changelog

## [Unreleased]

Initial Pi integration; private development package, not yet published.

- Add four native virtual models: Auto, quick, standard, and advanced.
- Reuse the shared scheduler with configured tier order and explicit tool-capability declarations.
- Add branch-aware `adaptive_tier` and reason/evidence `adaptive_escalate` tools.
- Share resource health through locked local state; recover from provider failures within the same tier, with bounded terminal restarts.
- Add deterministic tests, real-Pi SDK faux-provider scenarios, and a versioned provider-error corpus.

Durable parking, observe-mode parity, interactive UX, and the complete packed-host/PTY matrix remain release acceptance gates. See the [test strategy](docs/TEST_STRATEGY.md).
