# Pi test strategy

This is the release acceptance contract, not a claim that every gate has passed.
Pi Adaptive remains private and unpublished until M4–M7 of the
[Pi plan](../../../docs/plans/pi-plugin.md) are complete. Requirements are tracked
in [the shared catalogue](../../../docs/REQUIREMENTS.md), including ADP-057–065.

## Deterministic unit gate

- Require **100% statements, branches, functions, and lines** on first-party
  production code, including entrypoint wiring. Do not weaken thresholds, add
  blanket exclusions, or use coverage-ignore comments to make a gate pass.
- Exercise public interfaces using structural host fakes, in-memory stores,
  injected IDs, clocks, and timers. The normal unit suite uses no real network,
  wall-clock waits, or sleeps and starts no real host.
- Keep confirmed behavioral bugs as failing-before/passing-after regression
  tests. Test effects and observable results, not internal implementation trivia.
- Use `fast-check` properties/state machines for tier integrity, compatibility,
  Observe/Control decision identity, non-interfering observation, pin precedence,
  finite budgets, legal health transitions, and a single half-open probe.
- Cover park → wake → cancel → new-message interleavings, at-most-once wake
  claims, restart before/after reset, owned continuation-token consumption, and
  durable tool side effects. Original prompts must never be replayed after
  partial execution.
- Exercise storage concurrency, crash/stale-lock handling, malformed records,
  fail-open behavior, bounded receipts, and absence of secrets or prompt content
  from the shared parked index.

## Real SDK, faux provider

Use the actual `@earendil-works/pi-coding-agent` and `pi-ai` SDKs with Pi's
scripted faux provider, isolated model/auth/settings state, and local tool
fixtures. This proves the extension contract beyond structural fakes without
calling a paid model.

Required scenarios include:

- All four virtual models, tier precedence, same-model tool continuation, and
  manual takeover.
- Native retry after 429/503 redirects within the required tier and records
  health before re-admission; 429 does not trip the circuit breaker.
- Non-retried quota/billing failures continue through an owned hidden message,
  with at most two terminal infrastructure restarts per task.
- User abort and permanent auth/configuration errors never cause a recovery loop.
- Exhausted tiers wait/park rather than silently borrowing from another tier;
  automatic wakes stop at three per task and are claimed once across processes.
- Failed capability work can escalate one tier at a safe boundary; infrastructure
  failures and successful runs cannot earn an escalation. Pins and task budgets
  remain authoritative.
- Observe and active use the same scheduler inputs and decisions, but observe
  does not switch, wait, restart, or dispatch a recovery.
- Routing notes/receipts stay out of model context; the one owned continuation
  message is the documented exception for resuming partial work.

The error corpus in `test/fixtures/pi-errors/` is versioned and source-attributed.
Review each supported Pi version's error construction by hand. Assert the label
of every entry and that no infrastructure entry becomes capability evidence
(ADP-065). A corpus fixture is not a claim of live-provider testing.

## Packed artifact and host matrix

Acceptance uses the **`npm pack` artifact**, not only a source import or an
already-built development directory. Pack inspection must check the extension
entrypoint, declarations, license, README, manifest, and bundled shared core.
Private workspaces and a duplicate host must not become runtime dependencies.

Run isolated real hosts at **Pi 1.5.0 (minimum)** and the resolved **latest**
version. Record the exact resolved versions, package artifact, scenario results,
and `testedUpTo` evidence; never substitute the declared `>=1.5.0 <2` peer range
for a passed matrix. Install through a loopback registry to exercise Pi's package
installer and optional-peer behavior without publishing a package.

The matrix must exercise SDK loading and routed turns, `pi --mode json`/print
execution, and the real interactive TUI in a PTY. Use only a faux provider or
the testkit's deterministic provider on an ephemeral loopback port. Script
success, streaming/tool calls, 429/reset, quota, 503, auth, cancellation, and
recovery rather than relying on a real provider outage.

Headless tests must establish process lifetime explicitly: immediate owned
post-settle recovery can be awaited; a detached delayed callback may encounter a
stale extension context. Long parks must not report success while silently
abandoning the task, prompt for input without a UI, or claim an external wake
daemon exists.

## PTY and UX acceptance

Use Termwright with **Node 24** and its native PTY dependency installed. Run
against the real Pi TUI and packed plugin with an isolated agent directory.
Missing runtime/native prerequisites are a failure or an explicit skip, never
successful UI verification. See [contributor setup](../../../CONTRIBUTING.md).

Required journeys: first-run proposal/confirmation, routed turn and note, 429
recovery, all-down parked card and wake, Esc during an in-place wait, manual
model takeover, tier reorder persistence, doctor with a missing credential, and
two processes seeing shared health. Verify `quiet`, `changes`, and `all` note
behavior and that status remains useful without transcript notes.

Review status, notes, dialogs, and parked cards at **80×24**, **120×40**, and
narrow **60×24**. Assert content and width, use condition-based waits, and retain
failure artifacts. Fix flaky tests rather than hiding them with retries.
Screenshots/GIFs for the README must come from the completed M6 PTY review and
link to actual retained files; placeholders are not release evidence.

## Safety and privacy

No normal test or release-verification scenario uses paid models or external
telemetry. Unit tests use no network; runtime fixtures bind loopback only.
Fetching host packages for the matrix is test setup, not model traffic. Keep
credentials, prompt content, and raw headers out of logs and shared metadata;
synthetic fixture credentials are local test data only.

## Root verification and publish boundary

Run from the repository root:

```sh
npm test
npm run check -- --pkg pi
npm run verify -- --pkg pi
npm run verify -- --all
```

The completed Pi verification must include formatting, lint, strict typecheck,
100% unit coverage, build, pack checks, real-SDK tests, the packed minimum/latest
matrix, PTY E2E, and requirement traceability. Root verification also protects
OpenCode and shared-core behavior. Traceability must include Pi requirements and
real-host coverage where applicable; declaration comments alone are not proof
that scenarios passed.

Retain the exact command, revision/worktree state, resolved host versions,
exit code, and logs under `test-artifacts/run/<workspace>/<step>.log`, plus matrix
and PTY artifacts. Acceptance requires a final root verdict
**`verify: ok (...; skipped: none)`** on the completed release candidate. The
historical M3 verify result does not certify subsequent M4–M8 changes. A scoped
run, dry-run release preview, missing gate, or explicit skip is not full release
evidence.

Documentation preparation does not authorize commits, tags, manifest changes,
or publishing. Keep `private: true` and the README's unpublished warning until
all Pi release gates pass. After evidence review, the separate release workflow
may remove the private flag in its own commit. **Stop for user approval before
`npm run release -- --pi minor`.** Only the release CLI may prepare/verify the
bumped artifacts, commit/tag, publish, and push. After an approved publication,
verify a clean npm install with one routed turn and `/adaptive doctor`.
