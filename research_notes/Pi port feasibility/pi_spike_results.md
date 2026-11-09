# Pi integration spike results

## Environment

- Pi coding agent, pi-ai, and pi-agent-core: **1.5.0**.
- Node: **26.4.0**.
- In-memory sessions and settings, plus a saved-session reopen check; isolated temporary auth/model stores.
- Scripted native faux provider; no paid model requests.
- Executable harness: `.scratch/pi-m0.mjs` (throwaway spike, not release code).

## Verified SDK checks

| Check                              | Observed result                                                                                                                                                    | Implementation decision                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Throw from virtual-model `route()` | Exactly one `user` route, zero provider requests, one `agent_settled`, terminal `stopReason: error`; custom error text preserved                                   | A non-retryable parking error can stop dispatch without a native retry loop. User-facing parked UI still needs separate TUI checks.                               |
| Quota failure                      | One route and one faux request; quota text preserved; no Pi retry; one settle event                                                                                | Adaptive must own a bounded post-settle continuation for quota recovery.                                                                                          |
| Native retry redirect              | Routes are `user`, then `retry`; `failed.message.errorMessage` contains `503 Service Unavailable`; second request uses fallback model; terminal `stopReason: stop` | Native same-tier redirect is viable without replaying the user prompt.                                                                                            |
| Hidden post-settle custom message  | `sendMessage({display:false}, {triggerTurn:true})` starts a second run; routes are `user`, **`continuation`**; two requests and two settle events; final success   | Recovery admission must recognize an owned post-settle continuation before the ordinary sticky-model path. The earlier assumption of `reason:user` was incorrect. |
| Input consumption                  | An extension returning `{action:"handled"}` from `input` produces no route calls, provider requests, or settle events                                              | Pre-dispatch parking can intercept input before the agent runs.                                                                                                   |
| Cancellation while awaiting route  | `session.abort()` aborts `request.signal`; the route's wait rejects; zero provider calls; final `stopReason: aborted`                                              | An in-place wait can respond to cancellation without dispatch or recovery. PTY Esc wiring still needs a TUI test.                                                 |
| Long asynchronous route wait       | Waited 181,013 ms, then made exactly one provider request and settled successfully                                                                                 | No preparation timeout was observed beyond the planned two-minute wait limit in Pi 1.5.0.                                                                         |
| CLI post-settle recovery           | Isolated `--print --mode text` and `--print --mode json` both dispatched twice, settled twice, printed the recovery response, and exited 0                         | The real CLI keeps an owned immediate post-settle continuation alive, not only the SDK.                                                                           |
| Plain JSON Schema tool             | An extension tool with an enum parameter validates, executes, and returns a tool result; the follow-up routes as `continuation`                                    | No TypeBox runtime dependency is needed. The SDK `tools: []` option blocks extension tools as well as built-ins; tests must explicitly enable the tested tool.    |
| Saved router state                 | A session returns `{taskID, escalationsUsed}` from `route`; reopening preserves it, while branching before its entry restores undefined state                      | Task budgets survive restoration without leaking from the future of another branch. Atomic wake ownership still requires separate tests.                          |

The faux provider must be registered, given a dummy runtime credential, and followed
by `await modelRuntime.refresh()` before virtual routing. Without refreshing the
availability snapshot, Pi rejects it as having no credentials. The dummy key is local
test data, never a real credential.

## Evidence

```text
$ node .scratch/pi-m0.mjs
throw: routes=[user], calls=0, settled=1, outcome=error
quota: routes=[user], calls=1, settled=1, outcome=error
retry: routes=[user,retry], calls=2, settled=1, outcome=stop
PASS: route throw, quota non-retry, same-tier retry redirect (Pi 1.5.0, no network)
hidden-continuation: routes=[user,continuation], calls=2, settled=2, outcome=stop
input-consumed: routes=[], calls=0, settled=0
PASS: SDK hidden continuation and input consumption
route-abort: routes=[user], calls=0, settled=1, outcome=aborted
PASS: route receives user abort signal and dispatches nothing
json-schema-tool: routes=[user,continuation], calls=2, settled=1, outcome=stop
PASS: plain JSON Schema extension tool validates and executes without TypeBox
state-write: calls=1, outcome=stop
state-read: calls=1, outcome=stop
PASS: virtual model state survives saved-session reopen with budget intact
state-branch: calls=1, outcome=stop
PASS: branching before the routing-state entry does not inherit future budgets

$ node .scratch/pi-m0.mjs --long-wait
long-wait: routes=[user], calls=1, settled=1, outcome=stop
PASS: async route waited 181013ms without preparation timeout

$ node .scratch/pi-cli-spike.mjs
text: status=0, routes=[user,continuation], dispatches=2, settled=2, recovered=true
json: status=0, routes=[user,continuation], dispatches=2, settled=2, recovered=true
PASS: isolated Pi 1.5.0 print text/json keeps owned post-settle recovery alive (no network)
```

The CLI check also passes with a 1,500 ms awaited delay inside `agent_settled`
before sending the owned continuation, in both text and JSON modes. This verifies
an awaited delayed recovery, not an unowned timer scheduled after the handler returns.

## Later checks

| Check                                  | Observed result                                                                                                                                                                                                                          | Implementation decision                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unowned timer in print/JSON            | `.scratch/pi-cli-spike.mjs --unowned`: a `setTimeout` that calls `sendMessage` 1.5 s after `agent_settled` returned fails with "This extension ctx is stale". The process exits 1 after one dispatch and one settle, without recovering. | Headless recovery and short waits must be awaited inside an owned handler or `route()`. A detached wake timer is only valid in the TUI, re-armed on `session_start`. |
| Package install with optional peers    | `.scratch/pi-install-spike.mjs`: `pi install npm:<pkg>` against a loopback registry requested only the package metadata and tarball. No `@earendil-works/*` request was made and no such package was installed under the agent dir.      | Keep the Pi packages as optional peers plus pinned devDependencies; Pi maps host imports to its own copy.                                                            |
| TUI model picker and footer (real PTY) | `.scratch/pi-tui-spike.mjs` (Termwright, 100×32): Ctrl+L opens the picker (no "Select model" title, footer "Enter to select"). Rows read `auto (Adaptive Auto) [adaptive]`, and typing filters them.                                     | PTY E2E drives the picker with Ctrl+L and text filters, and reads the screen with `terminal.screen().text()`.                                                        |
| TUI Esc during an awaited route        | Esc aborted `request.signal` exactly once. The route rejected and nothing was dispatched (one route, one abort in the trace).                                                                                                            | In-place waits cancel through the route signal.                                                                                                                      |
| TUI manual takeover                    | Picking a physical model fired `model_select` with `source: "set"`. The `ctx.ui.setStatus` footer item was cleared, and no further route calls happened.                                                                                 | `model_select` to a non-virtual model is the manual-intent signal.                                                                                                   |

```text
$ node .scratch/pi-cli-spike.mjs --unowned
PASS: detached timer observes disposed session in Pi print/json; awaited recovery is required
```

Cross-process health and the single half-open probe are now covered by
`packages/pi/test/health.test.ts`: two peers with separate registries share one locked
file, and exactly one of them gets the probe.

## Release-acceptance follow-up (2026-11-09)

The throwaway spike is no longer the acceptance harness. The packed matrix now
exercises Pi 1.5.0 and resolved `latest` over SDK, JSON CLI and real PTY surfaces:

- `test/packed/sdk.spec.ts` covers compaction's real `direct` request and its active
  context; the child-host fixtures cover global extension discovery with
  `--model adaptive/quick` and the virtual-model defaults.
- `test/tui/picker.spec.ts` covers Ctrl+P cycling, picker selection and physical
  takeover. Host fixture probes cover widget/status rendering and Ctrl+Alt+A;
  production journeys separately exercise Adaptive's actual dialogs and notes.
- `test/runtime/extension.test.ts` exercises passive response-header capacity
  ingestion and its status display. This is deterministic faux-provider evidence,
  not a claim that every live provider transport emits these headers.
- `test/tui/journeys.spec.ts` and `parking.spec.ts` cover production first-run,
  routing/recovery notes, parking, cancellation, tier editing and doctor. Retained
  terminal frames cover 60×24, 80×24 and 120×40.

Paths above are relative to `packages/pi/`. The completed baseline command
`npm run verify -- --all` passed at `dc835fd` with no skipped gates; the log is
`test-artifacts/m8/verify-all-2.log`. That baseline does not certify later fixes:
regression fixes for first-prompt park persistence, effective-mode recovery,
pinned-tier escalation, thinking variants and full-context observation have since
been implemented and require final integrated verification. The observation proof
also exercises 150 seeded cases through the real registered routing paths.

Live-provider error capture is optional, paid and opt-in. It has not been run and
is not silently counted as passed. The mandatory versioned, source-attributed
error corpus and deterministic real-host scenarios remain the release gate.
