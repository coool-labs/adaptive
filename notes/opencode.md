# opencode-adaptive 1.6.4

Subagents now start on the tier their role asks for, and an interrupted
episode produces exactly one continuation prompt — even when several failures
or duplicate plugin instances report at once.

### Fixed

- Subagent sessions route their first request by the agent's role tier.
  Agent selection is read when the session is created or its agent changes,
  instead of waiting for the first execution report. A subagent that used to
  start on `standard` and only move to its role tier after one request now
  starts on the right resource.
- A failed turn no longer delivers the same "Continue the interrupted work…"
  prompt several times. Concurrent retry hooks, terminal quota reports, and
  escalation paths could all pass the per-instance pending check before its
  marker existed, and the host's duplicate plugin instance kept a separate
  marker. A synchronous, process-wide, token-scoped recovery lease now admits
  one recovery per session; the lease is shared with parked-work resume,
  expires after ten seconds, and is released when the continuation reaches
  the host. The continuation unit's own failure may still supersede the lease,
  so nested recovery keeps working.
- Receipts written by two plugin instances no longer overwrite each other.
  Receipt load-mutate-persist cycles are serialized across instances, and an
  instance reloads the ring when another instance has written since its last
  read, so an admission receipt from each instance survives.
- OpenAI replies saying no credits remain or are left are classified as
  quota exhaustion, so Adaptive fails over to the next configured resource
  instead of retrying the depleted account. This covers both the shared-quota
  message and the textual `no credits remaining` / `no credits left` forms.

### Tests

- Real-subagent lifecycle coverage for rate limiting, shared-quota fallback,
  and an exhausted tier that parks, including the absence of escalation.
- Regression coverage for concurrent retry hooks on one session, duplicate
  plugin instances delivering one continuation, stale-lease takeover, and
  duplicate-instance receipt survival.
- Classifier and subscription-recovery fixtures for OpenAI no-credits replies.
