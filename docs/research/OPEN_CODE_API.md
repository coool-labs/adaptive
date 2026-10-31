# OpenCode v2 API research (verified against local host v2.2.5)

Sources: official docs (opencode.ai/v2/docs), `@opencode/plugin@2.2.5` and
`@opencode/client@2.2.5` type definitions installed from npm, `@opencode/schema`
runtime schemas introspected with node. Every claim below was verified in the
installed `.d.ts`/schema files or the official v2 docs page for the relevant
surface. Local CLI: `opencode v2.2.5` (brew binary, Bun-compiled).

## Package layout

A v2 plugin package declares exports:

```jsonc
{
  "type": "module",
  "exports": {
    ".": "./src/index.ts", // server part (runs inside opencode serve)
    "./tui": "./src/tui.tsx", // TUI part (Solid JSX / OpenTUI)
    "./gui-experimental": "./dist/gui-experimental.cjs", // GUI part (prebuilt CJS)
    "./rpc": "./src/rpc.ts", // RPC contract shared with clients
  },
  "dependencies": { "@opencode/plugin": "..." },
}
```

- Server plugin: `export default Plugin.define({ id, async setup(ctx) { ... return cleanup? } })`
  from `@opencode/plugin`. `setup` may return a cleanup function.
- Plugin loading: `opencode.json(c)` `"plugins": ["pkg", { "package": "pkg", "options": {...} }]`.
  TUI-only packages may be listed in `cli.json` (the TUI reads its plugins from
  `cli.json`, the desktop app only from `opencode.json(c)`; a package with a
  `./gui-experimental` export must be in `opencode.json(c)`).
- Plugin id must not be in the `opencode` namespace (GUI refuses to load;
  app plugins reserve ids). We use `coool.adaptive`.
- `ctx.options` carries the `options` object from config. Changing options reloads the plugin.

## Server plugin context (verified interfaces)

- `ctx.app`: `{ name, version, channel }`.
- `ctx.location`: `{ directory, workspaceID?, project: { id, directory, canonical } }`.
- `ctx.storage`: `get(key)`, `set(key, Json)`, `remove(key)`, `scan({ prefix, after?, limit? })`
  → `{ entries: {key, value}[], next? }`. Durable, scoped to the plugin.
- `ctx.event.subscribe({ types?, signal? })`: `AsyncIterable` of typed server
  events. Plugins run inside the server; they never receive `server.connected`.
  Unknown type names are ignored with a warning.
- `ctx.rpc.register(Rpc, impl)` / `ctx.rpc(Rpc)` (self-call). RPC methods have
  `input`/`output`/`errors` schemas (JSON Schema or Standard Schema/zod);
  handler context has `signal` and `context.error(type, message, data)`.
  Registration exposes `registration.events.emit(name, data)`.
- `ctx.provider`: `list()`, `get({providerID})`, `transform(editor)`, `reload()`.
  Editor reads return `ProviderRecord { provider: Provider.Info, models: Map<string, Model.Info>, sourceConnection? }`.
- `ctx.model`: `list(providerID?)`, `get(providerID, modelID)`, `default()`,
  `transform(editor)`, `reload()`. Editor: `list/get/update/remove/default.set/provider`.
- `ctx.agent`: `list/get/transform/reload`.
- `ctx.session` (subset relevant to us): `get/list/create/remove/context`,
  `switchAgent`, `switchModel({ sessionID, model: { providerID, id, variant? } })`,
  `prompt`, `generate`, `command`, `compact`, `synthetic`, `interrupt`, `update`,
  `move`, `wait` (experimental), `instructions.entry` (experimental).
- `ctx.tool`: `list()`, `transform(editor)`, `reload()`, plus hooks
  `execute.before` / `execute.after` (event has `tool`, `input`, `status`,
  `result`/`error`).
- `ctx.shell.hook("create.before", ...)`, `ctx.permission.hook("evaluate", ...)`.
- `ctx.experimental.generate.text({ model, prompt })` (no session, no history).

### Session hooks (registration via `ctx.session.hook(name, cb, opts?)`)

`ModelHooks<SessionHooks>` names, all verified in `dist/promise/session.d.ts`:

| hook                                     | event fields (readonly unless noted)                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                                 | `sessionID`, `messageID`, mutable `prompt {text, files, agents, skills}`, `metadata`, mutable `delivery: "steer"\|"queue"`. Runs once at admission. Synthetic/shell/compaction-control messages do not run it.                                                                                                                                                                                                               |
| `context`                                | `sessionID`, `agent`, `model: Model.Ref`, `system: SystemPart[]`, `messages`, mutable `options`, mutable `tools`. Runs for the agent loop incl. tool continuations.                                                                                                                                                                                                                                                          |
| `compaction`                             | same as context + mutable `result?: {summary, native?, metadata?, tokens?}`. `messages` is the transcript being summarized.                                                                                                                                                                                                                                                                                                  |
| `generate`                               | same as context; transient `session.generate` calls.                                                                                                                                                                                                                                                                                                                                                                         |
| `title`                                  | `sessionID`, `model`, `system`, `messages`, `options`, mutable `result?: string`. No agent/tools.                                                                                                                                                                                                                                                                                                                            |
| `model.request`                          | `sessionID`, `agent`, `model`, `kind`, `baseURL?`, mutable `headers`. Optional `{ providerID }` scoping.                                                                                                                                                                                                                                                                                                                     |
| `http.request`                           | `sessionID`, `agent`, `model`, `kind`, mutable `request: Request`.                                                                                                                                                                                                                                                                                                                                                           |
| `http.response`                          | `sessionID`, `agent`, `model`, `kind`, mutable `response: Response`. Body is a one-shot stream: clone before reading.                                                                                                                                                                                                                                                                                                        |
| `experimental.ws.handshake/send/receive` | WebSocket equivalents; experimental, shape may change.                                                                                                                                                                                                                                                                                                                                                                       |
| `retry`                                  | `sessionID`, `agent`, `model`, `error: SessionStructuredError`, `attempt` (initial request = 1), mutable `decision: {retry:false} \| {retry:true, delay:number}`. Runs after OpenCode classifies the failure and proposes its policy, before scheduling. Multiple hooks run in registration order; built-in max attempt count remains a hard limit. Context-overflow recovery is separate (it compacts instead of retrying). |
| `experimental.idle`                      | `{ sessionID, background: ReadonlyArray<SessionIdleBackground> }`. Runs when a session finishes model work with no pending input, just before going idle. NOT run after interruption or failure. Background entries: `{kind:"shell"                                                                                                                                                                                          | "subagent" | "image", ...}`. A synthetic message admitted by the hook runs in the same execution. Experimental. |

`kind` on model/HTTP hooks: `"primary" | "compaction" | "title" | "generate"`.
Use `kind` (not agent id) to distinguish auxiliary requests.

### SessionStructuredError (verified, `@opencode/client` generated types + `@opencode/schema/session-error`)

```ts
{ type: string; message: string; status?: number; response?: { body: string }; retryAfterMs?: number }
```

OpenCode already parses `retryAfterMs` — classification should prefer it over
regexing `Retry-After` headers ourselves (HTTP hooks remain a fallback for
cases where the structured error lacks it).

## Server events (verified in `@opencode/client/dist/promise/generated/types.d.ts`)

Work-unit lifecycle and boundary events:

- `session.execution.started { sessionID }`
- `session.execution.succeeded { sessionID }`
- `session.execution.failed { sessionID, error: SessionStructuredError }`
- `session.execution.interrupted { sessionID, reason: "user"|"shutdown"|"superseded"|"inactivity" }`
- `session.retry.scheduled { sessionID, assistantMessageID, attempt, at, error }`
- `session.step.failed { sessionID, assistantMessageID, error, finish?, cost?, tokens?, ... }`
- `session.idle { sessionID }`
- `session.status { sessionID, status: {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, action?, next} }`
- `session.model.selected { sessionID, model: ModelRef, previous? }` — manual and
  programmatic switches both emit this; it is how we observe pin/model changes.
- `session.usage.updated { sessionID, cost, tokens }` (ephemeral)
- `session.inbox.enqueued/delivered/cancelled/delivery.changed`
- `provider.updated {}`, `model.updated {}` (registry refresh signals)
- `config.updated`, `permission.asked/replied`, `plugin.updated`, `session.created/deleted/forked/moved`
- `session.tool.*`, `session.step.*`, `session.compaction.*`, `session.text.*`, `session.reasoning.*`
- RPC events surface as `rpc.<id>.<name>` on the same stream.

Work-unit model mapping (v1): one execution episode =
`session.execution.started` … `succeeded|failed|interrupted`. Tool continuations
stay inside one execution. A subagent runs in its own child session with its own
execution events. A goal continuation is a later execution on the same session.

## Model / provider metadata (verified runtime schema introspection)

- `Model.Ref = { providerID, id, variant? }`.
- `Model.Info` fields: `id, modelID, providerID, canonical, type, family, name,
compatibility, package, settings, headers, body, capabilities, variants, time,
cost, status, enabled, limit`.
- `Model.Variant = { id, settings?, headers?, body? }` — `Info.variants` maps
  variant ids (reasoning effort levels live here).
- `Provider.Info` fields: `id, canonical, integrationID, name, activation,
package, compatibility, settings, headers, body`.
- Model `capabilities` / `compatibility` / `limit` (context window) are exposed
  per model — the compatibility gate can use them without provider-specific code.

## Native /goal (verified)

`@opencode/schema/goal` defines `Goal.State = { id, objective, status, reason,
rounds, maxRounds, stalls, boot, updatedAt }`. Goal is a native OpenCode
feature with its own round/stall accounting; Adaptive must never create a
second goal engine. Our surface is: keep supplying healthy models per
execution and survive switch/park/recovery between goal rounds.

## TUI plugin (verified, docs + `dist/tui`)

- `export default Plugin.define({ id, setup(context) { ... } })` from
  `@opencode/plugin/tui`. Solid JSX; peers `@opentui/core`, `@opentui/solid`, `solid-js`.
- `context`: `{ app, options, location, client, data, renderer, theme, ui, keymap,
markdown, storage, attention, ... }`.
- Commands: `context.keymap.layer(() => ({ mode, priority?, commands: [{ id, title,
group, bind, palette, slash: { name, aliases?, arguments? }, run, ... }], bindings }))`.
  A slash command named `adaptive` gives us `/adaptive`.
- Dialogs: `context.ui.dialog.alert/confirm/prompt/select`; `select` supports
  `search(query, options)` for custom filtering and `actions: [{bind, title,
onTrigger, side?, selection?}]` — enough to build tier/model pickers with
  keyboard-only flows.
- Data: `context.data.session.*`, `context.data.location.model.list(location)`,
  `context.data.on(event, cb)`, `context.data.listen(cb)`.
- Slots: `app`, `home.footer`, `home.footer.status`, `prompt.footer`,
  `session.composer.top`, `sidebar.content`, `sidebar.footer`, `session.panel`.
- Router: `context.ui.router.register({ name, render })`,
  `navigate({ type: "plugin", name, data })`.
- Toasts: `context.ui.toast.show({ title?, message, variant?, duration? })`.
- Reactive storage: `context.storage.store(key, { initial })` (durable, cross-TUI-synced).

## GUI plugin (verified, docs)

- `./gui-experimental` must be ONE prebuilt CommonJS file built with the Vite
  preset `@opencode/plugin/gui/vite` (`gui({ entry, outFile })`).
- `setup(ctx)` runs in every window (Solid); `main(ctx)` in Electron main.
  `ctx.client` is the desktop app's server client — call server RPC through it.
- Registries: `Command`, `Panel`, `SettingsPage`, `Slot`, `MenuItem`,
  `TitlebarItem`, `ComposerPill`, `Server`, `Style`.
- `SettingsPage { id, page?, section?, title, icon?, entries?, render(input) }`
  gives a native Settings page — our GUI settings surface.
- API is experimental (export name says so); keep the adapter thin, all logic
  server-side via typed RPC.

## Testing tools (verified)

- `@coool/opencode-plugin-test@0.1.0` (github:Hacklone/opencode-plugin-test;
  NOT on the npm registry — install via git ref, MIT, node >= 20.19).
  Packed mode: `npm pack` → tarball export validation → sandbox project → real
  `opencode serve` boot (fresh HOME/XDG, generated password) → readiness when
  the plugin list becomes non-empty → checks plugin `state: active` + declared
  surfaces → runs author scenarios (`{ plugin, request, target, paths, options }`)
  → teardown. Config `plugin-test.config.json`: targets `["current","latest","2.2.1"]`,
  mode `packed|source`, surfaces, scenarios file, timeouts, reporters
  `pretty|json|junit`, `keepSandbox`. Exit codes 0/1/2. Caveat (its ADR 0003):
  `options` reach scenario context, not plugin `setup()`.
- `termwright@0.7.7` (npm): PTY automation — daemon + Unix-socket RPC
  (`screen`, `press`, `type`, `wait_for_idle`, `screenshot`) for real-TUI E2E.

## Limitations that shape the design (verified)

1. **No native capability-tier API.** `quick`/`standard`/`advanced` are an
   ecosystem proposal only. Tier semantics must be Adaptive-internal.
2. **OpenCode owns retries.** The `retry` hook can veto or adjust a proposed
   retry, but the built-in max attempt count is a hard limit. Infinite retries
   are impossible; after the last attempt the execution fails with
   `session.execution.failed`. Continuation after that must be a clean new
   prompt/synthetic continuation, not a resurrected HTTP call.
3. **`experimental.idle` does not run after interruption or failure** — the
   parking/continuation path cannot rely on it; use `session.execution.failed`
   - own state + a continuation prompt at a safe boundary.
4. **WebSocket-backed providers bypass `http.request`/`http.response`** (e.g.
   the OpenAI OAuth/Codex path in v2 uses WebSockets). `Retry-After`/quota
   header capture is not reliable for those providers; `experimental.ws.*` hooks
   exist but are experimental. Capacity sensors must treat HTTP-header evidence
   as optional, never load-bearing.
5. **`http.response` body is one-shot** — must clone before reading.
6. **`session.switchModel` is public** and `session.model.selected` events
   surface both manual and Adaptive switches; manual-intent detection must
   distinguish plugin-issued switches (we tag them in our own state).
7. **GUI API is experimental** and the GUI part must be a single prebuilt CJS
   bundle; the TUI reads `cli.json`, the desktop app `opencode.json(c)`.
8. **`@coool/opencode-plugin-test` is not on the npm registry**; install from
   the GitHub ref. `options` in its config do not reach plugin `setup()`.
9. **Minimum supported version 2.2.1** (goal) — the hook/event surfaces used
   here exist in 2.2.x; plugin-test will verify against 2.2.1 explicitly.
10. **V1 plugin API** (`@opencode-ai/plugin`, hooks like `chat.params`) is the
    pre-2.0 path; v2 Promise plugins are the target. Dual V1/V2 support is
    possible but not required for minimum 2.2.1.
