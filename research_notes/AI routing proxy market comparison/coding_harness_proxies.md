# Proxies, routers and plugins for AI coding harnesses: model routing, fallback, quota handling, auto-resume (as of 2026-11-07)

Research date: 2026-11-07. Star counts come from shields.io GitHub badges, and download counts come from the npm registry search API (`downloads.monthly`). Both were fetched on 2026-11-07, so treat them as snapshots. "Last commit" values are shields.io relative strings such as "today" or "october", which mean October 2026 unless a year is given.

---

## Q1. Which tools exist in this niche, and how popular and well maintained are they?

### Takeaway

The niche falls into five groups:

1. **Harness-agnostic local gateways.** Claude Code Router (CCR) is the leader, with about 38k stars and about 174k npm downloads a month.
2. **Subscription-to-API bridges and multi-account pools.** CLIProxyAPI (about 58k stars), sub2api (about 46k), claude-relay-service (about 13k), AIClient2API (about 9k) and antigravity-claude-proxy (about 4k).
3. **Simple protocol translators.** claude-code-proxy (both forks), y-router and copilot-api.
4. **OpenCode-native fallback plugins.** Each has a few dozen stars at most, though some have thousands of npm downloads a month.
5. **Auto-resume tools.** These mostly lost their purpose once Claude Code shipped native auto-continue in August 2026.

### Cited Findings

**Harness-agnostic gateways and routers**

- **Claude Code Router (musistudio/claude-code-router, "CCR").**
  - 38k stars, MIT, last commit October 2026 — [shields.io](https://img.shields.io/github/stars/musistudio/claude-code-router.json).
  - npm package `@musistudio/claude-code-router` v3.1.3 published 2026-10-09; 94 versions, first published 2025-06-10; about 173.5k monthly downloads — [npm registry](https://registry.npmjs.org/@musistudio%2Fclaude-code-router).
  - It now calls itself "a local model gateway and control plane for coding agents". It supports Claude Code, Claude Design, Codex, Grok CLI, Kimi CLI, Kilo Code, **OpenCode**, Pi, ZCode, WorkBuddy and "compatible API clients" — [README](https://github.com/musistudio/claude-code-router).
  - Many forks exist on npm, e.g. `@wengine-ai/claude-code-router-next`, `@caeliq/claude-code-router` and `@taohaowei/claude-code-router`, the last a DeepSeek thinking-mode fix — [npm search](https://registry.npmjs.org/-/v1/search?text=claude%20code%20router).
- **ccproxy (starbased-co → starbaser/ccproxy).**
  - 357 stars, last commit August 2026 — [shields.io](https://img.shields.io/github/stars/starbaser/ccproxy.json).
  - v1.x sits on a LiteLLM Proxy and is installed via `uv tool install claude-ccproxy --with 'litellm[proxy]'`.
  - A "v2.0 prerelease" drops LiteLLM: it "jails your process in a rootless WireGuard namespace, intercepts at the network layer with full TLS inspection, and routes traffic through a DAG-driven hook pipeline. Any LLM client works — not just Claude Code" — [README](https://github.com/starbaser/ccproxy).
- **Claude Code Mux (9j/claude-code-mux).** Rust proxy, 518 stars, MIT, last commit November 2025, so it looks stale — [shields.io](https://img.shields.io/github/last-commit/9j/claude-code-mux.json); [README](https://github.com/9j/claude-code-mux).
- **LiteLLM (BerriAI/litellm).** General AI gateway, 63k stars, last commit "today". It describes itself as offering "load balancing" — [GitHub](https://github.com/BerriAI/litellm). It is the substrate that ccproxy v1 uses — [ccproxy README](https://github.com/starbaser/ccproxy).

**Subscription bridges and multi-account rotation proxies**

- **CLIProxyAPI (router-for-me/CLIProxyAPI).**
  - 58k stars, MIT, last commit "today" — [shields.io](https://img.shields.io/github/stars/router-for-me/CLIProxyAPI.json).
  - It wraps "Antigravity, ChatGPT Codex, Claude Code, Grok Build, Muse Code, Devin as an OpenAI/Gemini/Claude/Codex compatible API service" — [GitHub](https://github.com/router-for-me/CLIProxyAPI).
  - Features include "Multiple accounts with round-robin load balancing (Gemini, OpenAI, Claude, Grok)" and "Claude Code multi-account load balancing" — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
  - The README is heavily sponsored by paid "relay" resellers, e.g. PackyCode and AICodeMirror, which advertise "Claude Code / Codex / Gemini official channels at 38% / 2% / 9% of original price" — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
  - Ecosystem add-ons such as CPA-Manager-Plus provide "Codex and xAI quota checks, reset information, account-health inspection" — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
- **sub2api (Wei-Shaw/sub2api).**
  - 46k stars, LGPL-3.0, last commit "today" — [shields.io](https://img.shields.io/github/stars/Wei-Shaw/sub2api.json).
  - It bills itself as a "Gateway Platform for Subscription Quota Distribution" with "Smart Scheduling – Intelligent account selection with sticky sessions", per-user and per-account concurrency limits, rate limiting, and a built-in payment system (Alipay, WeChat Pay, Stripe) — [README](https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README.md).
- **claude-relay-service (Wei-Shaw/claude-relay-service, "CRS").**
  - 13k stars, MIT, last commit last week — [shields.io](https://img.shields.io/github/stars/Wei-Shaw/claude-relay-service.json).
  - It is a self-hosted relay that lets "Claude, OpenAI, Gemini, Droid subscriptions" be accessed through one endpoint and supports "拼车共享" (carpool sharing of one Max subscription among friends) — [GitHub](https://github.com/Wei-Shaw/claude-relay-service).
  - It uses sticky sessions in multi-account setups keyed on a `session_id` header — [README](https://raw.githubusercontent.com/Wei-Shaw/claude-relay-service/main/README.md).
- **claude-code-hub (ding113/claude-code-hub).** 3.4k stars, MIT. "Claude Code & Codex API proxy with intelligent load balancing, user management and usage stats" (translated from Chinese) — [GitHub](https://github.com/ding113/claude-code-hub).
- **AIClient2API (justlovemaki/AIClient2API).** 9k stars, GPL-3.0. "Self-hosted multi-protocol AI API proxy for Antigravity, Codex, Grok, Kiro, OpenAI, Claude" — [GitHub](https://github.com/justlovemaki/AIClient2API).
- **antigravity-claude-proxy (badrisnarayanan).** 4k stars, MIT, last commit "today". It exposes Antigravity-provided Claude and Gemini models to Claude Code and OpenClaw — [GitHub](https://github.com/badrisnarayanan/antigravity-claude-proxy).
- **copilot-api (ericc-ch).** 4.1k stars, MIT, last commit **October 2025**, so it looks unmaintained. "Turn GitHub Copilot into OpenAI/Anthropic API compatible server. Usable with Claude Code!" — [GitHub](https://github.com/ericc-ch/copilot-api); [shields.io](https://img.shields.io/github/last-commit/ericc-ch/copilot-api.json).

**Simple translators (no meaningful routing)**

- **1rgs/claude-code-proxy.** "Run Claude Code on OpenAI models", 3.8k stars, last commit June 2026 — [GitHub](https://github.com/1rgs/claude-code-proxy).
- **fuergaosi233/claude-code-proxy.** "Claude Code to OpenAI API Proxy", 2.8k stars, MIT, last commit March 2026 — [GitHub](https://github.com/fuergaosi233/claude-code-proxy).
- **luohy15/y-router.** "A Simple Proxy enabling Claude Code to work with OpenRouter", 384 stars, MIT, last commit January 2026 — [GitHub](https://github.com/luohy15/y-router).

**OpenCode plugins: auth bridges and quota**

- **opencode-antigravity-auth (NoeFabris).** 11k stars, MIT, last commit October 2026 — [GitHub](https://github.com/NoeFabris/opencode-antigravity-auth). A fork, `@cortexkit/opencode-antigravity-auth`, was published 2026-11-07 — [npm search](https://registry.npmjs.org/-/v1/search?text=opencode%20model%20rotation).
- **opencode-openai-codex-auth (numman-ali).** 2.2k stars, last commit January 2026 — [GitHub](https://github.com/numman-ali/opencode-openai-codex-auth).
- **@slkiser/opencode-quota.**
  - 1.1k stars, MIT, about 13.7k monthly downloads, v6.2.2 on 2026-11-05.
  - Shows quota, usage and limits for Copilot, OpenAI Plus/Pro, Google AGY, Z.ai and others in the TUI sidebar, Desktop and web.
  - It is display-only: it does not route — [npm](https://registry.npmjs.org/@slkiser%2Fopencode-quota); [GitHub](https://github.com/slkiser/opencode-quota).

**OpenCode plugins: fallback** (all published 2026; none has more than 40 stars)

- **@smart-coders-hq/opencode-model-fallback.** v1.3.4 (2026-04-01), about 14.6k monthly downloads, Apache-2.0, 6 stars — [npm](https://registry.npmjs.org/@smart-coders-hq%2Fopencode-model-fallback).
- **opencode-runtime-fallback (youngbinkim0/opencode-fallback).** v0.3.1 (2026-10-26), about 3.0k monthly downloads, 40 stars — [npm](https://registry.npmjs.org/opencode-runtime-fallback).
- **opencode-auto-fallback (HyeokjaeLee).** v0.4.61 (2026-09-28), 179 versions, about 2.2k monthly downloads, 12 stars — [npm](https://registry.npmjs.org/opencode-auto-fallback).
- **@azumag/opencode-rate-limit-fallback.** 71 versions, about 1.4k monthly downloads, 24 stars, last commit October 2026 — [npm](https://registry.npmjs.org/@azumag%2Fopencode-rate-limit-fallback).
- **opencode-fallback-model (vimtor).** v0.1.0 (2026-10-18), about 540 monthly downloads — [npm](https://registry.npmjs.org/opencode-fallback-model).
- **opencode-fallback (peva3).** v1.2.0 (2026-03-16), about 169 monthly downloads — [npm](https://registry.npmjs.org/opencode-fallback).
- **Retry-only plugins.** `@bdliyq/opencode-rate-limit-retry` and `opencode-rate-limit-retry-v2` retry the same model with backoff — [npm search](https://registry.npmjs.org/-/v1/search?text=opencode%20rate%20limit).

**Auto-resume and usage watchers**

- **terryso/claude-auto-resume.** 821 stars, MIT, last commit May 2026. "A shell script utility that automatically resumes Claude CLI tasks when usage limits are lifted" — [GitHub](https://github.com/terryso/claude-auto-resume).
- **ccusage (ryoppippi → ccusage/ccusage).** 19k stars, last commit "today". A usage analyzer, not a router — [GitHub](https://github.com/ccusage/ccusage).
- **A community tmux-based auto-continue tool.** It "monitors the tmux pane for rate limit messages, waits for the reset time (timezone-aware), and sends 'continue' automatically via `tmux send-keys`". It was proposed in [anthropics/claude-code#35744](https://github.com/anthropics/claude-code/issues/35744).

**Harnesses with built-in multi-model features**

- **Goose (block/goose → aaif-goose/goose).** 56k stars, Apache-2.0 — [GitHub](https://github.com/aaif-goose/goose).
- **Crush (charmbracelet/crush).** 29k stars — [GitHub](https://github.com/charmbracelet/crush).
- **Aider.** 50k stars, Apache-2.0, last commit May 2026 — [GitHub](https://github.com/Aider-AI/aider).
- **Roo Code.** 24k stars, Apache-2.0, last commit May 2026 — [GitHub](https://github.com/RooCodeInc/Roo-Code).
- **Kilo Code.** 28k stars, MIT, last commit "yesterday" — [GitHub](https://github.com/Kilo-Org/kilocode).
- **OpenCode (sst → anomalyco/opencode).** 225k stars — [GitHub](https://github.com/anomalyco/opencode).

### Inferences

- Popularity is concentrated in two places: harness-agnostic gateways (CCR) and subscription pooling and bridging proxies (CLIProxyAPI, sub2api, CRS). Popularity in the second group appears driven by cost arbitrage and account sharing, judging by their README positioning and sponsor lists. Supervisor-style reliability tooling is a thin, fragmented layer of small OpenCode plugins.
- Aider and Roo Code both show last commits in May 2026, so they may be slowing down. I did not verify their project status.

### Gaps

- The GitHub REST API was rate-limited, so I have no exact star counts, creation dates or archived flags. The figures above are rounded shields.io values.
- No data was gathered for the Gemini CLI, Codex CLI, Cline, Zed or Windsurf built-in model fallback behaviour.
- I found no reliable PyPI download data for `claude-ccproxy`.

---

## Q2. What do they route, and how is the routing decided?

### Takeaway

Routing in this niche is either **per request** inside a proxy (CCR, ccproxy, claude-code-mux) or **per session or agent** inside a harness plugin (the OpenCode fallback plugins). In the proxies, the decision rests on request heuristics: the requested model name (as a proxy for "background"), a thinking flag, token-count thresholds, web-search tool presence, user scripts, or an optional semantic classifier. None of the tools found here uses OpenCode-adaptive's model: deterministic **capability tiers per work unit** with a pin > request > role > evidence > default priority order.

### Cited Findings

- **CCR, legacy config (v1/v2).** The `Router` object maps request types to a `"provider,model"` pair:
  - `default`;
  - `background` (cheap tasks);
  - `think` (Plan Mode or reasoning);
  - `longContext` (above `longContextThreshold`, default 60000 tokens);
  - `webSearch`;
  - `image` (beta).

  Sources: [morphllm guide](https://www.morphllm.com/claude-code-router); [DataCamp tutorial](https://www.datacamp.com/tutorial/claude-code-router).

  A `custom-router.js` hook receives the request and config and returns a `"provider,model"` string or `null` to use the default. The README example matches on user-message text, e.g. `includes("explain this code")` — [npm fork README](https://www.npmjs.com/package/@washanhanzi/claude-code-router).

- **CCR v3.**
  - "Smart routing: pick models with conditional rules, rewrite requests, retry on failure, and fall back to backup models; Claude Code Subagents and Workflows can pick different models automatically" — [CCR docs](https://ccrdesk.top/en/).
  - The routing doc lists: a built-in Claude Code route; "Subagent / Workflow auto-routing"; a Codex route; custom rules with conditions, request rewrites and Node.js script rules (with `api.fetch`, `api.fs`, `api.env`); "Fallback modes", "Failure triggers", global and rule-level fallback; and "Optional: semantic routing with Jev" — [CCR routing doc](https://ccrdesk.top/en/routing).
  - "Claude Code main requests prefer an explicit client-selected model that CCR recognizes. The Agent Config model is only the default when the client model is missing or unrecognized" — [CCR routing doc](https://ccrdesk.top/en/routing).
  - It "automatically removes the first x-anthropic-billing-header system message injected by Claude Code" — [CCR routing doc](https://ccrdesk.top/en/routing).
  - It adds "Agent Profiles" (`ccr <profile>`), which launch a given agent CLI or app with isolated config pointed at the gateway — [npm README](https://registry.npmjs.org/@musistudio%2Fclaude-code-router).
- **ccproxy v1.** A `rule_evaluator` hook labels each request with the first matching rule:
  - `TokenCountRule` (threshold, e.g. 60000);
  - `MatchToolRule` (e.g. `WebSearch`);
  - `MatchModelRule` (a haiku model name means `background`);
  - `ThinkingRule` (`thinking: {enabled: true}` means `think`);
  - anything else gets `default`.

  The label is then mapped to a LiteLLM model alias — [README](https://github.com/starbaser/ccproxy).

- **claude-code-mux.** "Auto-route by task type (websearch, reasoning, background, default)". It also offers "Regex-based model name transformation", configurable regex for "background task detection", and "Dynamic model switching via `CCM-SUBAGENT-MODEL` tags" for multi-agent use — [README](https://github.com/9j/claude-code-mux).
- **CLIProxyAPI.**
  - Its routing is mainly account selection, via "multi-account round-robin load balancing" — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
  - An example, "Claude Code with a Codex backend", mentions "classifier routing" — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
- **sub2api.** "Intelligent account selection with sticky sessions". "Composite Groups" resolve "requested models to concrete providers for multi-provider groups" — [README](https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README.md).
- **OpenCode fallback plugins** route **per agent**, using ordered fallback chains:
  - `@smart-coders-hq/opencode-model-fallback`: "Per-agent ordered fallback chains with `"*"` wildcard support" — [npm](https://registry.npmjs.org/@smart-coders-hq%2Fopencode-model-fallback).
  - `opencode-runtime-fallback`: per-agent chains plus a global chain, configurable in agent frontmatter — [npm](https://registry.npmjs.org/opencode-runtime-fallback).
  - `opencode-auto-fallback`: per-agent chains plus a per-agent `largeContextModel` — [npm](https://registry.npmjs.org/opencode-auto-fallback).
- **Kilo Code "Auto Model".**
  - "a smart routing system that selects an underlying model for each request. Each tier uses its own routing strategy" — [Kilo docs](https://kilo.ai/docs/code-with-ai/agents/auto-model).
  - It "uses Kilo Code's existing work modes as signals to route each request" — [Kilo blog](https://blog.kilo.ai/p/auto-model-picks-the-right-ai-model).
  - It is tied to Kilo Gateway credits — [kilo.ai/auto-model](https://kilo.ai/auto-model).
- **Cursor Auto.**
  - A secondary source says that in July 2026 Cursor "replaced Auto mode's routing logic with Cursor Router, a dedicated classifier that decides, request by request, which model" — [vibecodingacademy](https://www.vibecodingacademy.ai/blog/cursor-auto-mode-router-explained). This is not verified against a Cursor primary source.
  - Auto is usage-billed — [r/cursor](https://www.reddit.com/r/cursor/comments/1p44rpo/auto_mode_is_now_usagebased_already_hit_7/).
- **Goose.** The current multi-model docs list mid-session `/model` switching and per-subagent provider and model selection, under the heading "Strategies range from manual or turn-based model selection to dynamic, context-aware switching" — [goose docs](https://goose-docs.ai/docs/guides/multi-model/). An issue asked to "untangle lead/worker config and code" in favour of multi-model auto-switching — [aaif-goose/goose#4036](https://github.com/aaif-goose/goose/issues/4036).

### Inferences

- CCR's "background/think/longContext/webSearch" scheme is the de facto vocabulary. It works by guessing request intent from wire-level hints. That differs from OpenCode-adaptive's per-episode tier assignment with explicit escalation evidence. CCR's v3 "semantic routing with Jev" and Cursor's classifier move in the opposite direction from OpenCode-adaptive's no-LLM-classifier stance.
- A proxy sees individual HTTP requests, not work units. Its "subagent" awareness comes from heuristics: CCR's Claude Code-specific route, mux's `CCM-SUBAGENT-MODEL` tag, or sticky session headers. Harness plugins like OpenCode-adaptive see session and agent identity directly.

### Gaps

- The JavaScript-rendered body of CCR's routing doc did not load, so I lack its exact "Fallback modes" and "Failure triggers" semantics, e.g. whether quota and rate-limit errors are distinguished from other failures.
- The content of Goose's current lead/worker mode (thresholds, fallback on failures) was not retrieved. The old docs page returned 404.
- Roo Code and Kilo per-mode "API configuration profiles" and any automatic switching between them were not verified.

---

## Q3. Failover on rate limits or quota, waiting and resuming after a usage reset, and mid-task continuity

### Takeaway

Failover to another model or provider on 429, 5xx or quota errors is common:

- CCR, claude-code-mux and LiteLLM do it per request;
- CLIProxyAPI, sub2api and CRS rotate accounts;
- OpenCode plugins do it per session.

**Waiting until a quota reset and then resuming** is rarer:

- Claude Code (native since v2.1.234, August 2026) does it for itself only, with no failover.
- `@azumag/opencode-rate-limit-fallback` has `wait` and `cycle` modes with exponential cooldown.
- Shell and tmux tools like claude-auto-resume do it from outside the harness.

No tool found combines **within-tier failover + durable parking across restarts + wake at the provider-reported reset time + restoring the preferred model at a safe boundary**.

### Cited Findings

- **CCR v3** advertises "Keep requests running with retries, credential pools, key rotation, and ordered fallback models" and "account status" in its logs — [README](https://github.com/musistudio/claude-code-router). Its docs list global and rule-level fallback and "Failure triggers" — [CCR routing doc](https://ccrdesk.top/en/routing).
- **claude-code-mux** advertises "Provider Failover – Automatic fallback to backup providers with priority-based routing" — [README](https://github.com/9j/claude-code-mux).
- **CLIProxyAPI** does round-robin across multiple accounts per provider. Third-party managers add "quota checks, reset information, account-health inspection, and controlled recovery actions" — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
- **sub2api** offers sticky-session account scheduling, plus per-account concurrency and rate limits — [README](https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README.md).
- **@smart-coders-hq/opencode-model-fallback.**
  - "Preemptive redirect via `chat.message` when a model is already known to be rate-limited".
  - "Reactive fallback from both `session.status` retry events and `session.error` API errors".
  - "Global model health tracking with automatic recovery windows".
  - Config knobs: `fallbackOn` (rate_limit, quota_exceeded, 5xx, timeout, overloaded), `cooldownMs`, `retryOriginalAfterMs` and `maxFallbackDepth`.
  - A `/fallback-status` command.
  - It replays a message via session revert ("`replay.revert.failed`" troubleshooting).

  Source: [npm README](https://registry.npmjs.org/@smart-coders-hq%2Fopencode-model-fallback).

- **opencode-runtime-fallback (v2).**
  - It "uses v2 request hooks, interrupts, model selection, and prompt admission to continue the existing conversation on a backup model. Completed tool results remain in history; the original task is not sent again."
  - Fallback entries are checked against OpenCode's enabled model inventory.
  - TTFT timeout: "models that are actively streaming are never interrupted".
  - "later user turns can recover to the original model. Manual model selections are respected."
  - In-memory background jobs are lost on cold restart ("loses this plugin's in-memory background delivery jobs").

  Source: [npm README](https://registry.npmjs.org/opencode-runtime-fallback).

- **@azumag/opencode-rate-limit-fallback (v2).**
  - Fallback modes `cycle`, `stop`, `retry-last` and `wait`.
  - Exponential cooldown "doubles with every consecutive exhausted pass … capped at one hour".
  - "The next user prompt puts the session back on its own model".
  - "A turn that was interrupted (by the user, …) is not resumed".
  - A circuit breaker (`failureThreshold`, `halfOpenMaxCalls: 1`), subagent fallback, headless-mode policies, and dynamic reprioritization by success rate and latency.

  Source: [README](https://github.com/azumag/opencode-rate-limit-fallback).

- **opencode-auto-fallback** splits errors into two classes: "immediate fallback for auth errors, exponential backoff retry for rate limits and transient failures — detected via structured SDK error types, not text matching". It has per-model timed cooldown, and "any unrecognized error is treated as retryable". On V2 it uses `ctx.session.hook("retry")` plus `switchModel` and `prompt`. Large-context switching is V1-only because V2 lacks `session.summarize`, `revert` and `messages` — [npm README](https://registry.npmjs.org/opencode-auto-fallback).
- **opencode-fallback-model (vimtor).** "The session stays on the fallback model. Switch back in the model picker once the original model works again." "Switching models drops the provider's prompt cache" — [npm README](https://registry.npmjs.org/opencode-fallback-model).
- **opencode-fallback (peva3).** Detection is text-pattern based (`rateLimitPatterns`, `disconnectPatterns` including "502", "503", "529"). Disconnect recovery re-sends a continuation prompt containing the captured partial output. It also has an optional "Ralph loop" auto-continue — [npm README](https://registry.npmjs.org/opencode-fallback).
- **Claude Code native auto-continue.**
  - Since v2.1.234, "Claude Code waits in the open session and continues your task automatically when a claude.ai usage limit resets".
  - It is on by default for interactive subscription sessions, with the opt-out key `autoContinueAtUsageLimit`.
  - "It does not resend your last message"; Claude is prompted to pick the task up — [AI Catchup](https://aicatchup.com/news/claude-code-desktop-auto-continue); [getclaudeskills](https://www.getclaudeskills.com/blog/claude-code-auto-resume-usage-limit).
  - The Desktop checkbox was announced 2026-08-14 — [Claude Code docs, week 33](https://code.claude.com/docs/en/whats-new/2026-w33); [explainx](https://explainx.ai/blog/claude-code-desktop-auto-continue-usage-limit-august-2026).
- **Codex has no equivalent.** As of late October 2026 users were still filing "Feature Request: Auto-Resume after Usage Limit" and "Automatically resume /goal tasks after usage limits reset", citing Claude Code's feature as a reason to prefer it — [OpenAI community](https://community.openai.com/t/feature-request-auto-resume-after-usage-limit/1397124).
- **External resume tools** work by screen-scraping and keystroke injection, e.g. tmux `send-keys` "continue" after parsing the reset time — [claude-code#35744](https://github.com/anthropics/claude-code/issues/35744); [terryso/claude-auto-resume](https://github.com/terryso/claude-auto-resume).
- **Cursor** shows a "Switch to Auto" button when a model's rate limit or quota is exceeded. It is a manual prompt, and bug reports say the button sets an invalid model value — [Cursor forum](https://forum.cursor.com/t/unable-to-switch-to-and-run-auto-model/166489); [Cursor forum](https://forum.cursor.com/t/bug-when-switching-to-auto-if-other-models-are-not-avilable/155161/7).

### Inferences

- **Proxies cannot do mid-task continuity.** A base-URL proxy can retry or fail over one HTTP request, but it cannot "park" an agent episode and wake it hours later. When the proxy finally fails, the harness has already surfaced an error or exhausted its own retries. Only a harness-integrated component (plugin or native feature) can resume from session state without replaying the prompt. OpenCode-adaptive and opencode-runtime-fallback both do this; Claude Code's native auto-continue does too, but without failover.
- **Health and quota tracking is in-memory everywhere.** Several OpenCode plugins track health with cooldowns, and azumag has a circuit breaker with one half-open call. None documents durable persistence of parked work or wake-ups across process restarts. opencode-runtime-fallback explicitly loses in-memory jobs on restart.

### Gaps

- I could not confirm whether CCR v3 parses `Retry-After` or quota-reset headers, or holds requests until a reset; its docs body was not retrievable.
- I could not confirm whether CLIProxyAPI marks an exhausted account until its reset time, or only round-robins. Its README mentions reset info only via third-party managers.

---

## Q4. Escalation to stronger models on failure, and the capability vs availability distinction

### Takeaway

Almost no tool in this niche separates _capability_ escalation from _availability_ failover. The fallback chains are ordered lists that mix stronger, weaker and cross-vendor models, and they trigger on infra errors. "Escalation" usually means moving down a chain, often to a weaker or free model. The closest analogues to capability routing are static: CCR and ccproxy's `think` route, Aider's architect/editor split, and Goose's lead/worker. None of them escalates on structured evidence such as reviewer rejection, verification failure, or a model-invoked escalate tool with reason and evidence.

### Cited Findings

- The typical chain mixes vendors and capability levels, e.g. `["anthropic/claude-sonnet-4-…", "google/gemini-flash-2-5"]` as fallbacks — [opencode-model-fallback README](https://registry.npmjs.org/@smart-coders-hq%2Fopencode-model-fallback).
- azumag's example falls back to free flash models (`glm-5.3-flash-free`, `deepseek-v4.1-flash-free`) — [README](https://github.com/azumag/opencode-rate-limit-fallback).
- opencode-auto-fallback's "large context fallback" switches to a larger-context model when context fills up, then switches back after compaction. It is V1-only. This is a **compatibility-driven** switch (context capacity), not a capability escalation — [npm README](https://registry.npmjs.org/opencode-auto-fallback).
- In ccproxy, the `think` label is assigned when the request carries `thinking: {enabled: true}`, so stronger models get selected by request flags, not by failure evidence — [README](https://github.com/starbaser/ccproxy).
- In CCR, `think` covers "Plan Mode / reasoning" — [morphllm](https://www.morphllm.com/claude-code-router).
- Goose's multi-model guide describes strategies "from manual or turn-based model selection to dynamic, context-aware switching" — [goose docs](https://goose-docs.ai/docs/guides/multi-model/).
- peva3's `opencode-fallback` uses "escalating" only in the retry sense: "On first disconnect, retry with the same model before escalating" — [npm README](https://registry.npmjs.org/opencode-fallback).

### Inferences

- OpenCode-adaptive's distinctive design points have no counterpart in any tool found:
  - a **capability vs availability separation**, under which infra errors never escalate tier;
  - a **schema-checked escalation tool** requiring reason and evidence;
  - **no hidden cross-tier borrowing**;
  - **parking instead of downgrading** when a tier is exhausted.

  Existing tools silently cross tiers by design, since that is the purpose of a fallback chain.

### Gaps

- I did not verify whether Aider (architect/editor, weak-model) or Roo Code and Kilo modes switch models automatically on failure. Only the routing-by-mode signal for Kilo Auto Model is sourced.

---

## Q5. Delivery form and cross-platform support

### Takeaway

Harness-agnostic tools are **local base-URL proxies or daemons**, often with a web UI and sometimes a desktop app. Harness-specific tools are **plugins** (OpenCode) or **wrapper CLIs and shell scripts** (auto-resume). CCR has moved into a full desktop control plane with agent launch profiles.

### Cited Findings

- **CCR.**
  - Desktop app for macOS, Windows and Linux (v3.1.3), recommended — [README](https://github.com/musistudio/claude-code-router).
  - npm CLI requiring Node 22+; `ccr start`, `ui`, `serve` and `stop`.
  - Gateway default `127.0.0.1:3456`, management UI `:3458`.
  - Config in `~/.claude-code-router` (SQLite).
  - A Docker image — [npm README](https://registry.npmjs.org/@musistudio%2Fclaude-code-router).
- **ccproxy.** v1 is a Python `uv` tool plus a LiteLLM proxy on `:4000`, used via `ANTHROPIC_BASE_URL` or `ccproxy run claude`. v2 (prerelease) intercepts traffic in a WireGuard network namespace — [README](https://github.com/starbaser/ccproxy).
- **claude-code-mux.** A single Rust binary (Linux, macOS Intel and Apple Silicon), "~5MB RAM, <1ms routing overhead", with an admin web UI — [README](https://github.com/9j/claude-code-mux).
- **CLIProxyAPI.** A Go service with an optional EasyCLIProxyAPI desktop client (tray, auto-update), a Management API, and a reusable Go SDK — [README](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md).
- **sub2api and CRS.** Self-hosted multi-user servers with admin dashboards. sub2api adds payment integrations — [sub2api README](https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README.md); [CRS README](https://raw.githubusercontent.com/Wei-Shaw/claude-relay-service/main/README.md).
- **OpenCode plugins** are npm packages loaded by OpenCode. Several now ship dual V1/V2 entry points, e.g. opencode-auto-fallback ("single package that supports both OpenCode V1 and V2") and azumag (V2 under the `opencode-v2` tag) — [npm](https://registry.npmjs.org/opencode-auto-fallback); [azumag README](https://github.com/azumag/opencode-rate-limit-fallback).
- **claude-auto-resume** is a shell script for macOS, Linux and Windows PowerShell — [GitHub](https://github.com/terryso/claude-auto-resume); [Shyft listing](https://shyft.ai/skills/claude-auto-resume).

### Inferences

- A harness-agnostic version of OpenCode-adaptive would most likely ship as a local proxy, competing directly with CCR v3, which already supports OpenCode as a client. In that form it would lose the session and work-unit visibility, safe-boundary switching and native continuation that the plugin form provides.

### Gaps

- Windows support for the various OpenCode plugins was not checked individually.

---

## Q6. Known problems: format translation, prompt cache loss, and ToS restrictions on subscription credentials

### Takeaway

The dominant risk is **Terms of Service**:

- Anthropic prohibited using Claude Free, Pro or Max OAuth tokens outside Claude Code and Claude.ai (formal documentation 2026-02-20, enforcement 2026-04-04).
- It then partially reversed course (2026-05-13), and the replacement credit scheme was paused (2026-06-15, per a secondary source).
- Multi-account pooling proxies (sub2api, CRS) carry explicit "may violate ToS / account bans" disclaimers.

On the technical side, documented problems include prompt cache loss on switches, translation fixes needed per vendor (e.g. DeepSeek reasoning replay), and harness-specific header handling.

### Cited Findings

- **Anthropic ToS change (2026-02-20).** "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service." OpenCode then "pushed code to remove support for Claude Pro and Max account keys", citing "anthropic legal requests" — [The Register, 2026-02-20](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546).
- **Earlier silent block.** HN discussion of an earlier block (about January 2026) notes that BYOK API keys remain allowed, while spoofing the Claude Code client to use subscription OAuth does not — [Hacker News](https://news.ycombinator.com/item?id=46549823).
- **Timeline (secondary source).**
  - Enforcement on 2026-04-04 against "OpenClaw, NanoClaw, OpenCode, and every other external application".
  - Reversal on 2026-05-13 with a planned non-rollover "Agent SDK credit" billed at API rates.
  - That plan was "paused" on 2026-06-15.

  Source: [BetterClaw (secondary)](https://www.betterclaw.io/blog/openclaw-anthropic-subscription-ban).

- **Claude Code legal docs** still state: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users" — quoted by [vincentvandeth.nl](https://vincentvandeth.nl/blog/best-openclaw-alternative-cli-subprocess-oauth-ban).
- **OpenAI** reportedly permits Codex subscription use inside third-party clients. This comes from an opinion piece, not a primary source — [Medium](https://medium.com/@aagarwal1012/the-walled-garden-has-a-point-why-anthropics-oauth-crackdown-makes-more-sense-than-you-think-7ca10cf48e50).
- **sub2api** disclaimer: "Using this project may violate the terms of service of Anthropic and other upstream providers… The authors assume no liability for account bans" — [README](https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README.md).
- **CRS** carries the same warning (translated from Chinese: "Terms of service risk: using this project may violate Anthropic's terms of service") and explicitly targets splitting one Claude Code Max subscription among friends — [README](https://raw.githubusercontent.com/Wei-Shaw/claude-relay-service/main/README.md).
- **claude-code-mux** markets "FREE access for Claude Pro/Max, ChatGPT Plus/Pro, and Google AI Pro/Ultra" via OAuth. The README predates or ignores the Anthropic restriction (last commit November 2025) — [README](https://github.com/9j/claude-code-mux).
- **ccproxy** reads `~/.claude/.credentials.json` to forward the Claude Code OAuth token (`forward_oauth` hook), which falls under the prohibited pattern for non-Claude-Code clients — [README](https://github.com/starbaser/ccproxy).
- **Prompt cache loss.** "Switching models drops the provider's prompt cache, so the retried request costs more" — [opencode-fallback-model README](https://registry.npmjs.org/opencode-fallback-model).
- **Translation bugs.**
  - A CCR fork exists solely for a "multi-turn DeepSeek thinking-mode fix (reasoning_content replay)" — [npm `@taohaowei/claude-code-router`](https://registry.npmjs.org/-/v1/search?text=claude%20code%20router).
  - CCR strips Claude Code's `x-anthropic-billing-header` system message — [CCR routing doc](https://ccrdesk.top/en/routing).
  - CRS sticky sessions break behind Nginx unless `underscores_in_headers on;` is set, because the `session_id` header gets dropped — [CRS README](https://raw.githubusercontent.com/Wei-Shaw/claude-relay-service/main/README.md).
- **OpenCode V2 plugin API limits.** "OpenCode V2 does not expose `session.summarize`, `session.revert`, or `session.messages` to plugins", which blocks some recovery features — [opencode-auto-fallback README](https://registry.npmjs.org/opencode-auto-fallback).
- **Fragile error detection.** Several plugins match on error text (peva3's substring and regex patterns). azumag must ignore "known benign Anthropic billing notices so they do not trigger false-positive fallbacks" — [opencode-fallback](https://registry.npmjs.org/opencode-fallback); [azumag README](https://github.com/azumag/opencode-rate-limit-fallback).

### Inferences

- A harness-agnostic proxy that pools or rotates subscription OAuth credentials is ToS-hostile for Anthropic, and the pooling projects say so themselves. A design limited to user-configured API keys and official providers avoids this, which matches OpenCode-adaptive's "only user-configured providers" invariant.
- Prompt cache loss on switches supports OpenCode-adaptive's rule of switching only at safe boundaries and never pulling a productive model mid-work.

### Gaps

- I could not confirm from a primary Anthropic source the exact state of third-party subscription use as of November 2026, after the June 15 pause. The BetterClaw account is secondary.
- No primary source was found for OpenAI's policy on Codex subscription OAuth in third-party tools.

---

## Q7. Does a harness-agnostic proxy or service equivalent of opencode-adaptive already exist? (feature comparison)

### Takeaway

**No.** CCR v3 is the closest harness-agnostic product. It covers multi-agent clients including OpenCode, per-request routing rules, retries, credential pools and ordered fallback, logs and UI. It lacks:

- deterministic capability tiers per work unit;
- an evidence-based escalation tool;
- the capability vs availability split;
- durable parking with wake at quota reset;
- safe-boundary model restore;
- observe and control modes.

The OpenCode plugins cover parts of the availability half: health tracking, cooldowns, a circuit breaker (azumag), wait mode, inventory checks and continuing without replay (runtime-fallback). None has tiers, escalation or durable parking. Claude Code's native auto-continue covers wait-and-resume for one vendor only, with no failover.

### Cited Findings (matrix; ✅ = documented, ◐ = partial or heuristic, ✗ = not found)

| Capability (opencode-adaptive)                          | CCR v3                                                               | ccproxy                     | cc-mux               | CLIProxyAPI / sub2api / CRS   | smart-coders model-fallback | runtime-fallback                           | azumag rate-limit-fallback                 | Claude Code native                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------- | -------------------- | ----------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| (a) Deterministic tier per work unit, priority order    | ◐ request-type routes + script rules + optional Jev semantic routing | ◐ first-match request rules | ◐ task-type regex    | ✗ (account and model mapping) | ◐ per-agent chain           | ◐ per-agent chain                          | ◐ chain                                    | ✗                                                                 |
| (b) Model-callable escalation tool, reason + evidence   | ✗                                                                    | ✗                           | ✗                    | ✗                             | ✗                           | ✗                                          | ✗                                          | ✗                                                                 |
| (c) Within-tier failover on 429, quota, 5xx, timeout    | ◐ ordered fallback, no tier concept                                  | ◐ via LiteLLM               | ✅ provider failover | ◐ account rotation            | ◐ crosses tiers             | ◐ crosses tiers                            | ◐ crosses tiers                            | ✗                                                                 |
| (d) Health, circuit breaker, quota reset awareness      | ◐ "account status"                                                   | ✗                           | ✗                    | ◐ via third-party managers    | ◐ health + recovery windows | ◐ cooldown                                 | ✅ breaker with 1 half-open call; cooldown | ◐ knows reset time                                                |
| (e) Durable park + wake at reset, continue from session | ✗                                                                    | ✗                           | ✗                    | ✗                             | ✗                           | ◐ continues without replay; in-memory only | ◐ "wait" mode retries after cooldown       | ✅ waits in open session (not durable across exit; single vendor) |
| (f) Switch at safe boundaries + restore preferred model | ✗ (per request)                                                      | ✗                           | ✗                    | ✗                             | ◐ `retryOriginalAfterMs`    | ◐ next user turn recovers to original      | ◐ next user prompt restores                | n/a                                                               |
| (g) Observe vs control modes; TUI or web status         | ◐ web UI and logs, no observe mode                                   | ✗                           | ◐ admin UI           | ◐ dashboards                  | ◐ `/fallback-status`        | ◐ toasts                                   | ◐ toasts and metrics                       | ✗                                                                 |

Sources for the matrix:

- CCR: [README](https://github.com/musistudio/claude-code-router); [routing doc](https://ccrdesk.top/en/routing); [docs home](https://ccrdesk.top/en/).
- ccproxy: [README](https://github.com/starbaser/ccproxy).
- claude-code-mux: [README](https://github.com/9j/claude-code-mux).
- Pooling proxies: [CLIProxyAPI](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/README.md); [sub2api](https://raw.githubusercontent.com/Wei-Shaw/sub2api/main/README.md); [CRS](https://raw.githubusercontent.com/Wei-Shaw/claude-relay-service/main/README.md).
- OpenCode plugins: [smart-coders](https://registry.npmjs.org/@smart-coders-hq%2Fopencode-model-fallback); [runtime-fallback](https://registry.npmjs.org/opencode-runtime-fallback); [azumag](https://github.com/azumag/opencode-rate-limit-fallback).
- Claude Code native: [AI Catchup](https://aicatchup.com/news/claude-code-desktop-auto-continue).

### Inferences

- **The gap is real but narrow on the availability side.** Health-aware fallback is crowded at the plugin level, with at least 8 OpenCode fallback plugins and CCR at the proxy level. The unoccupied parts are:
  1. separating capability from availability, with tier-preserving failover and parking instead of downgrading;
  2. evidence-based escalation, through a tool schema plus reviewer and verification signals;
  3. **durable** parking and waking keyed to quota reset times, surviving restarts;
  4. an observe/control split that shares a single scheduler.
- **Proxy form is weak for OpenCode-adaptive's model.** Work-unit boundaries, subagent identity, safe-boundary switching and native continuation all need harness integration; a proxy sees only individual requests. A harness-agnostic port would probably need per-harness adapters (Claude Code hooks, Codex, OpenCode plugin) around a shared core scheduler and health/quota service, plus an optional proxy data plane for failover. CCR's "Agent Profiles" show users accept a launcher plus gateway model.
- **Positioning risk.** CCR (38k stars, active, multi-harness, already listing OpenCode) is the incumbent a proxy port would compete with. Claude Code's native auto-continue reduces demand for wait-and-resume on Anthropic subscriptions specifically. Codex users are still asking for the feature as of October 2026, so demand there is unmet.

### Gaps

- CCR v3's fallback semantics (failure-trigger taxonomy, `Retry-After` handling, whether it holds requests across a quota window) could not be extracted from its JavaScript-rendered docs. A direct read of the CCR source would settle whether it distinguishes quota or rate-limit errors from capability failures.
- `@brainervirus/workit-opencode` describes an "adaptive policy" (14.4.0, about 30k monthly downloads). From its README it is a workflow and skills plugin, not a model router, but this was not checked in depth — [npm](https://registry.npmjs.org/@brainervirus%2Fworkit-opencode).
