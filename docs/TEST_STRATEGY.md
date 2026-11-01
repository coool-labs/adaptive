# Test Strategy

Deterministic by construction: injected clocks everywhere; no sleeps; no paid models.

## Layers

1. **Unit** — every module in PLAN Step 1–4; 100% statement/branch/function/line coverage gate on first-party code (ADP-037). No blanket excludes; entrypoints (`index.ts`, `tui.tsx`, `gui.tsx`) are covered through wiring tests, not excluded.
2. **Property / state-machine** — `fast-check` (ADP-038): classification totality; health-state legality; scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe≡Control decisions; Observe never changes execution; pin wins; no silent downgrade; finite budgets terminate; one half-open probe; preferred resource returns only at a safe boundary); receipt no-secrets/boundedness.
3. **Integration** — real seams with fake adapters: scheduler→health→state; retry hook policy→adapter; rpc validation; settings migration; restart round-trips; fail-open (throwing dependencies → defer).
4. **Fault injection** — deterministic provider fixture + clock: 429, quota reset, 503, timeout, disconnect, malformed error, context overflow, auth failure, recovery-after-N, concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
5. **Packed-plugin** — `@coool/opencode-plugin-test` packed mode against real isolated OpenCode hosts: targets 2.2.1, current, latest; surfaces server/tui/rpc; behavioral scenarios (routing defer in Observe, settings round-trip via rpc, receipt generation) — not just "plugin becomes active" (ADP-040).
6. **Server E2E (real host + fake provider)** — runtime scenario list below (ADP-041).
7. **Web E2E (Playwright)** — real OpenCode Web UI + packed plugin; Chromium + WebKit; desktop + narrow viewports; semantic locators; zero retries; screenshot checks as secondary assertions (ADP-042).
8. **TUI E2E (Termwright)** — real PTY; 80x24 / narrow / wide; `wait_for_idle` conditions only; failure artifacts captured (ADP-043).
9. **Cross-surface E2E** — Web→TUI and TUI→Web settings sync (ADP-044).
10. **Headless** — full CONTROL recovery flow with no UI surface loaded (ADP-045).

## Runtime E2E scenarios (ADP-041)

Real-host coverage (`test/runtime-e2e/` against `opencode serve` + the fake provider; supervision, routing, lifecycle, rpc files):

Quick routing, Standard routing, Advanced routing, agent-tier hint (warm-up + warm session) and explicit pin override (routing); Observe mode, Control mode, Observe≡Control decision parity (supervision); same-tier fallback, short throttling + Retry-After (supervision quota/rate-limit flows); provider outage, circuit breaker, single half-open probe, parking before dispatch (lifecycle breaker; supervision parks); tier escalation on context overflow (lifecycle 413 → escalate → owned continuation); quota exhaustion and its native-retry exemption (lifecycle); restart while parked, resume after recovery (lifecycle persisted-parked restart); durable tool side effects through owned recovery without replay (lifecycle marker file); multiple concurrent sessions (supervision); subagent children supervised as their own units (lifecycle subagent); user cancellation never fails over (supervision); fail-open on corrupted persisted settings (routing); headless execution (every scenario runs on bare `opencode serve` with no UI surface — ADP-045 by construction); RPC surface defaults/persistence/validation/receipts (rpc).

Documented limitations (minimal proofs per GOAL):

- **Draining** is unit-covered only: the drain health event has no runtime emitter in the host wiring (verified by source search); no runtime trigger exists.
- **Variant/effort escalation** is unit-covered: escalating at runtime requires a model inventory entry with a variant ladder; the fake provider's host config exposes none, and strength is never guessed from variant names (ADP-004).
- **Native `/goal` through a mid-goal model transition** is impossible on host 2.2.5: goal auto-continuation turns run inside one execution unit with no prompt hook and no execution boundary between them; the lifecycle /goal test instead proves the GOAL.md flow (goal starts → preferred fails → veto → owned recovery continues the goal on the fallback → completes → preferred again at the next boundary) and records the limitation.

## Web E2E journeys (ADP-042)

Real-web coverage (`test/e2e-web/web.spec.ts` via `npm run e2e:web`: Playwright against the real OpenCode v2 web app served by `opencode serve` with the packed plugin on an isolated host; Chromium desktop, Chromium narrow 390x844, WebKit; zero retries):

Password connect → home empty state; wrong password → error state (stays on the form); keyboard-operable connect (pressSequentially + Enter); settings page reachable and renders at every viewport width (narrow reaches Settings through the banner Tabs dialog); documented settings tabs visible; models catalog search finds the configured model and shows its empty state for unknown models; Extensions → Plugins lists `coool.adaptive`; plugin RPC integration from browser page context (settings.get Observe default on first install, settings.set control → reload → persistence → back to observe, invalid patch rejected at the schema gate, status.get mirroring mode/tiers/receipts).

Documented limitations (minimal proofs per GOAL):

- **Plugin GUI surfaces in the web app** (open Adaptive settings, mode switch, health/status/quota/draining/unavailable/recovery displays, receipts preview) cannot load on host 2.2.5: the web SPA mounts plugin GUI contributions only through the desktop-shell bridge (`bridge.pluginGuis()`), never fetches `/api/plugin/gui?id=…`, and `/api/command` lists only native commands — verified by network log and bundle archaeology; the canary test asserts the absence so a future host that mounts plugin GUIs fails the canary and the journeys get implemented. The desktop-shell GUI is covered by the gui unit tests; TUI status display is covered by TUI E2E.
- **Add model / model search / variants / reorder / remove** as web journeys: the host web settings expose only the model-catalog picker (search + visibility) and OAuth-managed providers; custom providers are "Manage in opencode.json" (file configuration, not a UI journey). Model search and its empty state are covered; catalog mutation journeys are not applicable to a custom-provider host.

## TUI E2E journeys (ADP-043)

Real PTY (Termwright) against the real OpenCode TUI + fake-provider sidecar: boot/first-run state (empty editor, configured model active); keyboard-only command-palette navigation with Escape/cancel; a full session turn through the provider; 80x24 and wide-dimension runs (`npm run e2e:tui`).

Documented limitation (2.2.5, proven by the minimal reproducible canary in `test/e2e-tui/tui.spec.ts`): the interactive TUI does not load plugin `./tui` bundles from project-config or config-dir discovery — plugin TUI commands (`/adaptive`, and with them the Observe/Control switch, model search/selection/reorder/remove, save/persistence, status/health/validation and restart/reconnect dialog journeys) cannot surface. The canary asserts the plugin command is absent from the palette; a host that mounts plugin TUI bundles flips it and those journeys get implemented.

## Cross-surface sync E2E (ADP-044)

`test/e2e-web/sync.spec.ts` (part of `npm run e2e:web`, all three browser projects) proves the server is the single source of truth in both directions against one shared real host:

- Web → other surface: a settings change made from the real web app arrives live on a second typed client — the `settings-changed` event is observed on the host event stream and the client's `settings.get`/`status.get` reflect the change.
- Other surface → Web: a settings change made by the second typed client is observed live (`settings-changed`) and visible in a freshly loaded web app (`settings.get` and `status.get` mirror it) — no surface-local settings state anywhere.

Surface fidelity (both limitations are proven by canaries, not assumed): the web side speaks the plugin RPC from inside the page because the plugin GUI does not mount in the browser-served app (Web E2E canary above); the second client is bound to the exact RPC definition `src/tui.ts` binds (`context.client.rpc(adaptiveRpc)`) because the TUI does not load plugin bundles (TUI E2E canary above). Subscription liveness is proven before each journey with a same-value probe patch (a valid no-op patch still succeeds and emits) — no fixed sleeps.

## Deterministic fake provider (ADP-039)

Local OpenAI/OpenCode-compatible HTTP+SSE server scripting: success, streaming, tool calls, partial execution, 429 (+Retry-After), quota/reset headers, 503, timeout, disconnect, malformed response, context rejection, recovery after N calls. Real OpenCode talks to it in E2E; unit/integration layers use in-process fakes typed against the same shapes.

## Traceability (ADP-047)

- Test files, plugin-test scenarios, `vitest.config.ts`, CI workflow, CONTRIBUTING.md, and release scripts declare coverage with a `covers: ["ADP-xxx"]` literal (above the first import; `#` comment in YAML).
- `npm run traceability` (`scripts/traceability.ts`) parses `docs/REQUIREMENTS.md` headings and fails on: an unknown ADP id (typo gate), a requirement with no declaring files, or an E2E-applicable requirement that no E2E file (runtime-e2e / e2e-web / e2e-tui / plugin-test) declares. Requirements that are inherently unit-level carry an explicit `NOT_E2E_APPLICABLE` exemption with a why-comment inside the script (safe default: applicable). The report lands in `test-artifacts/traceability.json`.

## Coverage (ADP-037)

Vitest + V8 coverage, thresholds 100/100/100/100 on first-party `src/**`. Only genuinely generated/vendor code may be excluded, clearly identified. No `istanbul ignore`, no empty tests, no implementation-trivia assertions. `npm run coverage` runs the `unit` project only: real-host runtime E2E under V8 instrumentation is pathologically slow and timing-flaky (receipt polling against an instrumented host), and `src/**` coverage is complete from the deterministic suite alone; runtime E2E still runs in every `npm test` and in `verify:release`.

## Regression policy (ADP-046)

Every behavioral bug: failing-first test → fix → wider suite → keep test forever. Enforced in CONTRIBUTING.md and applied throughout the project including the final adversarial review.

## Flakiness rules

Zero retries in E2E; a flaky test is a bug (regression-test it or fix the nondeterminism); all waits are condition-based (`session.wait`, Termwright `wait_for_idle`, Playwright auto-waiting).
