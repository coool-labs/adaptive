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

## Remaining gates

The rest of M0 is not yet verified: TUI model selection/footer behavior,
delayed headless wake lifetime, capacity
metadata, package installation without duplicate host dependencies, and
cross-process storage/probe claims. These remain release blockers, not assumed
platform guarantees.
