# pi-adaptive 1.0.3

Pi now recognizes OpenAI's depleted-balance replies as quota exhaustion and
fails over to the next configured provider instead of retrying the account.
Contended state writes also wait long enough for a subagent burst to finish.

### Fixed

- OpenAI replies saying no credits remain or are left are classified as
  quota exhaustion. Both the shared-quota message and the textual
  `no credits remaining` / `no credits left` forms fail over to the next
  configured provider.
- A state-file lock now waits up to three seconds for a live holder. A busy
  subagent burst, or a host under CPU pressure, could previously exceed the
  one-second budget and fail a legitimate write open.

### Tests

- The Pi error corpus and subscription-recovery suite cover the no-credits
  reply and assert the failover.
