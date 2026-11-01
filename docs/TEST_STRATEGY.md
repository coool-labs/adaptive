# Test Strategy

Deterministic by construction: injected clocks everywhere; no paid models; unit/integration/property/web/TUI suites use no sleeps — the real-host runtime E2E additionally uses fixed `settle()` pauses where the host's own retry/grind timing cannot be observed conditionally (polling is used wherever a condition exists).

## Layers

1. **Unit** — every module in PLAN Step 1–4; 100% statement/branch/function/line coverage gate on first-party code (ADP-037). No blanket excludes; entrypoints (`index.ts`, `tui.tsx`, `gui.tsx`) are covered through wiring tests, not excluded.
2. **Property / state-machine** — `fast-check` (ADP-038): classification totality; health-state legality; scheduler invariants (unavailable/incompatible never selected; availability failure never escalates; Observe≡Control decisions; Observe never changes execution; pin wins; no silent downgrade; finite budgets terminate; one half-open probe; preferred resource returns only at a safe boundary); receipt no-secrets/boundedness.
3. **Integration** — real seams with fake adapters: scheduler→health→state; retry hook policy→adapter; rpc validation; settings migration; restart round-trips; fail-open (throwing dependencies → defer).
4. **Fault injection** — deterministic provider fixture + clock: 429, quota reset, 503, timeout, disconnect, malformed error, context overflow, auth failure, recovery-after-N, concurrent sessions, child-session failure, OpenCode restart, Adaptive internal exception.
5. **Packed-plugin** — `@coool/opencode-plugin-test` packed mode against real isolated OpenCode hosts: targets 2.2.1, current, latest; surfaces server/rpc (the `tui` surface is not declared — the interactive TUI cannot be driven by the packed-plugin harness; the TUI journeys run in the Termwright E2E layer below); behavioral scenarios (first-install defaults, settings round-trip via rpc incl. invalid-patch rejection, status mirror, receipts.list, unknown-method rejection, host session API still works) — not just "plugin becomes active" (ADP-040).
6. **Server E2E (real host + fake provider)** — runtime scenario list below (ADP-041).
7. **Web E2E (Playwright)** — real OpenCode Web UI + packed plugin; Chromium + WebKit; desktop + narrow viewports; semantic locators; zero retries; screenshot checks as secondary assertions (ADP-042).
8. **TUI E2E (Termwright)** — real PTY; 80x24 (narrow floor) / default / wide; condition-based waits only; failure artifacts captured (ADP-043).
9. **Cross-surface E2E** — Web→TUI and TUI→Web settings sync (ADP-044).
10. **Headless** — full CONTROL recovery flow with no UI surface loaded (ADP-045).

## Runtime E2E scenarios (ADP-041)

Real-host coverage (`test/runtime-e2e/` against `opencode serve` + the fake provider; supervision, routing, lifecycle, rpc files):

Quick routing, Standard routing, Advanced routing, agent-tier hint (warm-up + warm session) and explicit pin override (routing); Observe mode, Control mode, Observe≡Control decision parity (supervision); same-tier fallback, short throttling + Retry-After (supervision quota/rate-limit flows); provider outage, circuit breaker, single half-open probe, parking before dispatch (lifecycle breaker; supervision parks); tier escalation on context overflow (lifecycle 413 → escalate → owned continuation); quota exhaustion and its native-retry exemption (lifecycle); restart while parked, resume after recovery (lifecycle persisted-parked restart); durable tool side effects through owned recovery without replay (lifecycle marker file); multiple concurrent sessions (supervision); subagent children supervised as their own units (lifecycle subagent); user cancellation never fails over (supervision); fail-open on corrupted persisted settings (routing); headless execution (every scenario runs on bare `opencode serve` with no UI surface — ADP-045 by construction); RPC surface defaults/persistence/validation/receipts (rpc).

Documented limitations (minimal proofs per GOAL):

- **Draining** is unit-covered only: the drain health event has no runtime emitter in the host wiring (verified by source search); no runtime trigger exists.
- **Variant/effort escalation** is unit-covered: escalating at runtime requires a model inventory entry with a variant ladder; the fake provider's host config exposes none, and strength is never guessed from variant names (ADP-004).
- **Native `/goal` through a mid-goal model transition** is impossible on host 2.2.5: goal auto-continuation turns run inside one execution unit with no prompt hook and no execution boundary between them; the lifecycle /goal test instead proves the GOAL.md flow (goal starts → preferred fails → veto → owned recovery continues the goal on the fallback → completes → preferred again at the next boundary) and records the limitation.
- **Compatibility-gate demand is empty in production**: the host exposes no per-episode demand source (tools/modalities/context tokens) in the v2 wiring, so runtime admission passes `demand: {}` and only the `model-unavailable` dimension can fire live; the remaining gate dimensions (tools, modalities, context capacity, variant availability) are exercised at the unit layer (`checkCompatibility` tests). The `drain`/`reset` health-event kinds are likewise requirement-driven surfaces with no runtime producer; capacity signals flow through `CapacityRegistry` directly.
- **Explicit tier requests and auxiliary-request tiering are unwired**: the priority ladder and the core honor `tierRequest` and auxiliary→`quick`, but the v2 host wiring has no source for either (no slash/RPC channel; auxiliary `model.request` kinds are observed but not routed separately — switching for an auxiliary request would move the primary model). Covered at the unit layer (`resolve.test.ts`).
- **Before-dispatch parking defers to OpenCode**: when a required tier has no usable resource at admission time, the scheduler emits `park`, but the wiring records the decision as a receipt and lets the episode proceed on OpenCode's own model (fail-open; the host's own selection is not overridden). Persisted parked records arise from owned-recovery failures and are resumed at idle boundaries; the restart/resume journey is proven in `lifecycle.test.ts`.
- **Prompt overhead**: the plugin sends exactly one fixed continuation prompt and nothing else — `test/execution/continuation/execute.test.ts` property-proves every owned prompt is `CONTINUATION_PROMPT` and a generated original never appears, so receipts and operational metadata cannot reach a prompt; routing CPU overhead is bounded by `test/core/scheduler/perf.test.ts` (ADP-052/053).
- **Headless (ADP-045)** is covered by construction: every runtime E2E scenario runs against bare `opencode serve` with no UI surface loaded (`supervision.test.ts` declares ADP-045).

## Web E2E journeys (ADP-042)

Real-web coverage (`test/e2e-web/web.spec.ts` via `npm run e2e:web`: Playwright against the real OpenCode v2 web app served by `opencode serve` with the packed plugin on an isolated host; Chromium desktop, Chromium narrow 390x844, WebKit; zero retries):

Password connect → home empty state; wrong password → error state (stays on the form); keyboard-operable connect (pressSequentially + Enter); server disconnect kills the host process (own host per test) and the app surfaces the loss visibly — the next server round-trip produces the SPA's application-error screen on 2.2.5 (host-UI behavior, pinned so it can never regress to silence); settings page reachable and renders at every viewport width (narrow reaches Settings through the banner Tabs dialog); documented settings tabs visible; models catalog search finds the configured model and shows its empty state for unknown models; Extensions → Plugins lists `coool.adaptive`; plugin RPC integration from browser page context (settings.get Observe default on first install, settings.set control → reload → persistence → back to observe, invalid patch rejected at the schema gate, status.get mirroring mode/tiers/receipts).

Documented limitations (minimal proofs per GOAL):

- **Plugin GUI surfaces** (open Adaptive settings, mode switch, health/status/quota/draining/unavailable/recovery displays, receipts preview) cannot load on any shipped host: the web SPA (2.2.5) mounts plugin GUI contributions only through the desktop-shell bridge (`bridge.pluginGuis()`), never fetches `/api/plugin/gui?id=…`, and `/api/command` lists only native commands; the desktop app's renderer build (1.15.4 and current 1.19.5, verified by asar archaeology and a live probe) ships neither the plugin-GUI SDK nor the bridge. The canary test asserts the absence so a future host that mounts plugin GUIs fails the canary and the journeys get implemented; the settings features themselves are fully covered through the TUI journeys (above) and the typed RPC (Web E2E). Desktop apps older than 1.19.5 additionally reject the `plugins` config key outright. Visual inspection note (T-31): on disconnect the host SPA disables actions ("Add project" greyed) without an error banner — host-UI behavior on 2.2.5, not Adaptive-owned.
- **Add model / model search / variants / reorder / remove** as web journeys: the host web settings expose only the model-catalog picker (search + visibility) and OAuth-managed providers; custom providers are "Manage in opencode.json" (file configuration, not a UI journey). Model search and its empty state are covered; catalog mutation journeys are not applicable to a custom-provider host.

## TUI E2E journeys (ADP-043)

Real PTY (Termwright) against the real OpenCode TUI + fake-provider sidecar, with the packed plugin mounted (`npm run e2e:tui`): boot/first-run state (empty editor, configured model active); keyboard-only command-palette navigation with Escape/cancel; the `/adaptive` dialog flow driven end-to-end from the palette — first-run invitation rendered and confirmed, the status alert (observe snapshot on a fresh install), the observe→control mode switch with persistence (re-opening the flow shows no invitation again and the status alert reads `mode: control`), the receipts empty-state alert, and Escape cancellation at every dialog level; the same flows entered through the editor slash menu (`/` → Enter opens the invitation — the slash menu lists `/adaptive`, though typing the full word races the slash filter); the tier editor — model search over the host catalog, add through the picker (incl. the variant step), "Settings saved", persistence re-verified by reopening the editor; reorder (Move up/Move down) with the editor list re-asserted; Remove with its confirm dialog plus the Escape-cancel path keeping the resource; pin set → status shows the pin → clear via "No pin" → `pin: none`; a full session turn through the provider; dimension runs at 80x24 (the narrow floor), the 100x30 default, and 200x50 wide.

Requirements the TUI RPC under test imposes on the sandbox (both established empirically on 2.2.5 after the earlier "TUI does not load plugin TUI bundles" limitation was falsified — its real root causes were two Adaptive-side bugs, since fixed):

- The plugin must be configured in the **HOME-based global config** (`~/.config/opencode/opencode.json`). A project-local `plugins` entry registers the palette command but every `context.client.rpc(definition)` call fails with `rpc.unavailable`; the `$XDG_CONFIG_HOME` config file is not consulted for plugin discovery at all (the service-port override via `opencode service set port` _is_ written under `XDG_CONFIG_HOME` and honored).
- The plugin's keymap layer must register with `mode: "global"` (`src/tui.ts`); the default input-mode scoping kept the palette from matching the command.
- The keymap layer registers asynchronously some seconds after the boot prompt, so the suite retries the palette match; the `/adaptive` slash form does not match the host's slash menu ("No matching commands"), making ctrl+p the keyboard path.

## Cross-surface sync E2E (ADP-044)

`test/e2e-web/sync.spec.ts` (part of `npm run e2e:web`, all three browser projects) proves the server is the single source of truth in both directions against one shared real host:

- Web → other surface: a settings change made from the real web app arrives live on a second typed client — the `settings-changed` event is observed on the host event stream and the client's `settings.get`/`status.get` reflect the change.
- Other surface → Web: a settings change made by the second typed client is observed live (`settings-changed`) and visible in a freshly loaded web app (`settings.get` and `status.get` mirror it) — no surface-local settings state anywhere.

Surface fidelity (both limitations are proven by canaries, not assumed): the web side speaks the plugin RPC from inside the page because the plugin GUI does not mount in the browser-served app (Web E2E canary above); the second client is bound to the exact RPC definition `src/tui.ts` binds (`context.client.rpc(adaptiveRpc)`) because driving two interactive TUIs in one automated test is not automated — the TUI's own RPC path is covered for real by the Termwright journeys above. Subscription liveness is proven before each journey with a same-value probe patch (a valid no-op patch still succeeds and emits) — no fixed sleeps.

## Deterministic fake provider (ADP-039)

Local OpenAI/OpenCode-compatible HTTP+SSE server scripting: success, streaming, tool calls, partial execution, 429 (+Retry-After), quota/reset headers, 503, timeout, disconnect, malformed response, context rejection, recovery after N calls. Real OpenCode talks to it in E2E; unit/integration layers use in-process fakes typed against the same shapes.

## Traceability (ADP-047)

- Test files, plugin-test scenarios, `vitest.config.ts`, CI workflow, CONTRIBUTING.md, and release scripts declare coverage with a `covers: ["ADP-xxx"]` literal (above the first import; `#` comment in YAML).
- `npm run traceability` (`scripts/traceability.ts`) parses `docs/REQUIREMENTS.md` headings and fails on: an unknown ADP id (typo gate), a requirement with no declaring files, or an E2E-applicable requirement that no E2E file (runtime-e2e / e2e-web / e2e-tui / plugin-test) declares. Requirements that are inherently unit-level carry an explicit `NOT_E2E_APPLICABLE` exemption with a why-comment inside the script (safe default: applicable). The report lands in `test-artifacts/traceability.json`.

## Coverage (ADP-037)

Vitest + V8 coverage, thresholds 100/100/100/100 on first-party `src/**`. Only genuinely generated/vendor code may be excluded, clearly identified. No `istanbul ignore`, no empty tests, no implementation-trivia assertions. `npm run coverage` runs the `unit` project only: real-host runtime E2E under V8 instrumentation is pathologically slow and timing-flaky (receipt polling against an instrumented host), and `src/**` coverage is complete from the deterministic suite alone; runtime E2E still runs in every `npm test` and in `verify:release`.

## Packaging and CI (ADP-048/049/050)

- `npm run pack:check` (`scripts/pack-check.ts`): builds a real tarball with `npm pack`, inspects it — required entrypoints (`dist/index.js`, `dist/tui.js`, `dist/rpc.js`, `dist/gui-experimental.cjs`, their `.d.ts`, `LICENSE`, `README.md`, `package.json`), forbidden content (`src/`, `test/`, `docs/`, `scripts/`, `node_modules`, `GOAL.md`, `coverage/`), manifest fields (name / semver version / MIT) — then runs `npm publish --dry-run`. Report artifact: `test-artifacts/pack-check.json`. The static publish contract is additionally asserted in `test/package.test.ts` (exact exports key set, MIT, minimal runtime dependencies).
- CI (`.github/workflows/ci.yml`): `gates` job (ubuntu, Node 20/22/24: format, lint, typecheck, `npm test` — including the real-host runtime E2E project —, coverage, build, pack:check, traceability; the opencode CLI is installed from npm and picked up through `OPENCODE_BIN`), `plugin-test` job (packed plugin against OpenCode 2.2.1 / current / latest, self-installed hosts), `web-e2e` job (ubuntu; Chromium + WebKit via `playwright install --with-deps`), `tui-e2e` job (macOS runner — the Termwright PTY backend is darwin-only — with Node pinned to a Termwright-certified major 24). No paid credentials anywhere; all provider traffic goes to the fake provider.
- `npm run verify:release` (`scripts/verify-release.ts`) runs the whole chain in one command, aborting at the first failure: format:check → lint → typecheck → test → coverage → build → pack:check → plugin-test → e2e:web → e2e:tui (Node 22/24 PATH prefix on newer runtimes, macOS-only PTY) → traceability.

## Regression policy (ADP-046)

Every behavioral bug: failing-first test → fix → wider suite → keep test forever. Enforced in CONTRIBUTING.md and applied throughout the project including the final adversarial review.

## Flakiness rules

Zero retries in E2E; a flaky test is a bug (regression-test it or fix the nondeterminism); all waits are condition-based (`session.wait`, Termwright `wait_for_idle`, Playwright auto-waiting).
