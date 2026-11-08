# Self-hosted / open-source LLM gateways and proxies (state as of 2026-11-07)

Scope note: repo metadata (stars, license, language, last push, latest release) was pulled live from the GitHub REST API on 2026-11-07 (`https://api.github.com/repos/<owner>/<repo>`); each repo URL is cited inline. Feature claims come from official docs/READMEs fetched the same day unless marked otherwise. Tools are grouped as (A) general-purpose gateways, (B) infra/K8s gateways, (C) coding-agent / subscription-pooling proxies (the closest analogues to a "local OpenRouter for coding harnesses"), (D) routers/classifiers.

## Q1. Deployment, language, license, maturity, and 2026 status changes

### Takeaway

LiteLLM (62.9k★) and new-api (51.5k★) are the largest general gateways. Three of the named tools changed status in 2026: TensorZero was archived, Portkey was acquired by Palo Alto Networks, and Helicone moved to maintenance mode. The fastest-growing category is local, desktop-friendly proxies built for coding agents and subscription/OAuth pooling: CLIProxyAPI (57.8k★), claude-code-router (38k★), 9router (32k★), sub2api (45.6k★), and the cc-switch desktop app (152k★). The K8s-native gateways (Agent Router/Envoy, agentgateway, Kong, APISIX) are poor fits for a single-user local daemon.

### Cited Findings

**(A) General-purpose gateways**

- **LiteLLM Proxy**: Python, migrating to Rust. 62,858★. License shows as NOASSERTION: an OSS core plus features under a "LiteLLM Commercial License". Latest tag v1.110.0-dev.1 (2026-11-07). Repo description now reads "Rust core with Python SDK". Install with `uv tool install 'litellm[proxy]'` or Docker. "-stable" Docker tags go through 12-hour load tests. — [GitHub](https://github.com/BerriAI/litellm)
- LiteLLM Rust migration: an Axum server will front all requests. "Supported requests will use the Rust fast path. Other requests will be forwarded to a Python worker on the same host." The Dec 1 2026 target is `/v1/messages` end-to-end in Rust (simple-shuffle routing; Anthropic models on Anthropic/Bedrock/Vertex) at about 1.5 ms proxy latency. Other routing strategies stay on Python until the fast path expands. — [LiteLLM Rust Migration](https://docs.litellm.ai/rust-migration); [blog](https://docs.litellm.ai/blog/rust-migration-rerouted)
- Third-party stability signal: Respan says a January 2026 LiteLLM upgrade caused intermittent connection failures. Respan rebuilt its gateway in Rust after accumulating about 100,000 lines of LiteLLM patches. — [The New Stack](https://thenewstack.io/respan-rust-ai-gateway/)
- **Bifrost (Maxim AI)**: Go, Apache-2.0, 9,420★. Latest release transports/v2.5.0 (2026-11-06). Runs with `npx -y @maximhq/bifrost` or `docker run -p 8080:8080 maximhq/bifrost`. The README says zero configuration is needed. "Adaptive load balancing, clustering, guardrails, MCP gateway" are Enterprise-only. — [GitHub](https://github.com/maximhq/bifrost)
- **Portkey AI Gateway (OSS)**: TypeScript, MIT, 13,337★. Last release v1.15.2 (2026-01-12); last push 2026-05-25. — [GitHub](https://github.com/Portkey-AI/gateway). Palo Alto Networks closed its acquisition of Portkey on 2026-05-29. Portkey becomes the core AI gateway of Prisma AIRS, and portkey.ai/pricing reads "Portkey is now PRISMA AIRS AI Gateway". — [INFRO, citing PANW/Portkey pages](https://infro.io/blog/who-owns-your-ai-gateway-2026)
- **TensorZero**: Rust, Apache-2.0, 11,705★. Last release 2026.6.0 (2026-06-04). Archived read-only on 2026-06-12 with no shutdown notice in the README. — [GitHub](https://github.com/tensorzero/tensorzero); [INFRO](https://infro.io/blog/who-owns-your-ai-gateway-2026). One directory listing says versions before 2026.6.0 have a high-severity file-read vulnerability and that no further security fixes will ship. This is secondary and unverified. — [EnterpriseDNA](https://enterprisedna.co/directories/open-source/tensorzero/). HN thread: "repo goes archived over night after raising $7.3M Seed". — [HN](https://news.ycombinator.com/item?id=48516504)
- **Helicone AI Gateway**: Rust, GPL-3.0, 643★. Last release v0.2.0-beta.30 (2025-07-21); last push 2025-11-21. — [GitHub](https://github.com/Helicone/ai-gateway). Helicone joined Mintlify on 2026-03-03, and its services "will remain live for the foreseeable future in maintenance mode". — [INFRO](https://infro.io/blog/who-owns-your-ai-gateway-2026)
- **one-api**: Go backend (GitHub lists the language as JavaScript), MIT, 37,348★. The description advertises a single executable. Last release v0.6.10 (2025-02-02); last push 2026-01-09. Effectively stale. — [GitHub](https://github.com/songquanpeng/one-api)
- **new-api** (one-api fork, QuantumNous): Go, AGPL-3.0, 51,522★. v1.0.0-rc.48 (2026-11-04); very active. — [GitHub](https://github.com/QuantumNous/new-api)
- **Plano** (formerly Arch gateway, katanemo; `katanemo/archgw` redirects to `katanemo/plano`): Rust (Envoy-based data plane), Apache-2.0, 7,110★. Release 0.4.39 (2026-10-24). — [GitHub](https://github.com/katanemo/plano)
- **LLM Gateway** (theopenco): TypeScript, 1,729★, license NOASSERTION, v1.24.0 (2026-11-02). Its README mentions "billing and subscription management", so it is SaaS-oriented. — [GitHub](https://github.com/theopenco/llmgateway)
- **any-llm** (Mozilla.ai): Python, Apache-2.0, 2,247★, v1.46.0 (2026-11-05). Primarily an SDK. — [GitHub](https://github.com/mozilla-ai/any-llm)
- **Olla** (thushan): Go, Apache-2.0, 335★, v0.1.0 (2026-11-01). A single binary using under 50 MB RAM, focused on self-hosted backends (Ollama, vLLM, etc.). Its README recommends LiteLLM as the bridge to cloud APIs. — [GitHub README](https://github.com/thushan/olla)
- **Glide** (EinStack): last push 2024-08, so effectively abandoned. — [GitHub](https://github.com/EinStack/glide)

**(B) Infra / Kubernetes gateways**

- **Envoy AI Gateway → renamed "Agent Router"** (Agentic AI Foundation project; repo `envoyproxy/ai-gateway` redirects to `theagentrouter/agent-router`): Go, Apache-2.0, 2,366★, v1.2.1 (2026-11-06). The README says: "Same code, same maintainers... Nothing you deploy is renamed." It uses a "two-tier gateway pattern": a Tier One gateway handles auth and global rate limiting, and a Tier Two gateway fronts self-hosted model serving. That "tier" is a network topology tier, not a capability tier. — [GitHub](https://github.com/theagentrouter/agent-router)
- **agentgateway** (Linux Foundation project, originally from Solo.io): Rust, Apache-2.0, 6,012★, v1.7.0 (2026-10-27). LLM routing has "budget and spend controls... load balancing, and failover". Inference routing for self-hosted models uses GPU utilization, KV cache, and queue depth. — [GitHub](https://github.com/agentgateway/agentgateway)
- **Kong**: Lua, Apache-2.0, 44,365★, 3.9.4 (2026-10-12). The **AI Proxy Advanced** plugin (load balancing, failover, semantic routing) "is only available as part of our AI Gateway Enterprise offering." — [Kong GitHub](https://github.com/Kong/kong); [AI Proxy Advanced docs](https://developer.konghq.com/plugins/ai-proxy-advanced/)
- **Apache APISIX**: Lua, Apache-2.0, 17,302★, 3.19.0 (2026-09-28). The `ai-proxy-multi` plugin is OSS. — [GitHub](https://github.com/apache/apisix); [ai-proxy-multi docs](https://apisix.apache.org/docs/apisix/plugins/ai-proxy-multi/)

**(C) Coding-agent / subscription proxies (local daemons/desktop apps)**

- **CLIProxyAPI** (router-for-me): Go, MIT, 57,845★, v8.0.59 (2026-11-07); releases are near-daily. It wraps Antigravity, ChatGPT Codex, Claude Code, Grok Build, and others "as an OpenAI/Gemini/Claude/Codex compatible API service". Third-party wrappers form an ecosystem: macOS menu-bar apps, Windows tray forks, quota inspectors, and systemd installers. — [GitHub README](https://github.com/router-for-me/CLIProxyAPI)
- **Claude Code Router (CCR)**: TypeScript, MIT, 38,030★, v3.1.3 (2026-10-09). Now a desktop app for macOS, Windows, and Linux (listening on `:3456`), described as "One local control plane for every AI agent". — [GitHub README](https://github.com/musistudio/claude-code-router)
- **9router** (decolua): JavaScript/Next.js, MIT, 32,062★, v0.5.35 (2026-07-16). Distributed as an npm package with a dashboard at `localhost:20128`. Deploys to localhost, a VPS, Docker, or Cloudflare Workers, and has an optional "Cloud Sync". — [GitHub README](https://github.com/decolua/9router)
- **sub2api** (Wei-Shaw): Go, LGPL-3.0, 45,606★, v0.2.20 (2026-11-07). Needs Redis 7+. It is a multi-user "subscription quota distribution" platform. — [GitHub README](https://github.com/Wei-Shaw/sub2api). **claude-relay-service** (same author): JavaScript, MIT, 12,788★. — [GitHub](https://github.com/Wei-Shaw/claude-relay-service)
- **claude-code-hub** (ding113): TypeScript, MIT, 3,399★, v0.9.8. A Claude Code and Codex proxy with load balancing and usage statistics. — [GitHub](https://github.com/ding113/claude-code-hub)
- **cc-switch** (farion1231): Rust desktop app, MIT, 152,494★, v4.0.27 (2026-11-07). An "All-in-One assistant for Claude Code, Codex, OpenCode...". Primarily a config/provider switcher; I did not verify its proxy and failover features. — [GitHub](https://github.com/farion1231/cc-switch)
- **FreeLLMAPI**: MIT, local-first, with desktop packages for Windows, macOS, and Linux. Pools free-tier keys from 34 providers. — [joaoqueiros.com review, 2026-09-15](https://www.ai.joaoqueiros.com/blog/freellmapi-free-model-routing-coding-agents-media)

**(D) Routers / classifiers**

- **vLLM Semantic Router**: Go, Apache-2.0, 6,414★, v0.4.0 (2026-09-27). — [GitHub](https://github.com/vllm-project/semantic-router)
- **RouteLLM** (lm-sys): last push 2024-08, dormant. — [GitHub](https://github.com/lm-sys/RouteLLM)
- Stripe agreed to acquire OpenRouter on 2026-08-19 (hosted, not self-hosted; included for market context). — [INFRO](https://infro.io/blog/who-owns-your-ai-gateway-2026)

### Inferences

- The only general gateways that are actively maintained, permissively or OSS licensed, and trivially local are LiteLLM, Bifrost, and new-api. new-api's AGPL license matters if code is borrowed from it.
- TensorZero, Helicone, and Portkey OSS should be treated as non-viable bases or competitors for new work: archived, maintenance mode, and acquired with a stalled OSS repo, respectively.
- The real "market" for a local coding-harness proxy is group C. It is large by stars, iterates very quickly, and in several cases exists mainly to pool or share consumer subscriptions.

### Gaps

- I did not find the reasons TensorZero was archived in primary sources. The README has no notice.
- I did not verify cc-switch's proxy, failover, or quota internals.
- I could not resolve a stable agentgateway LLM-failover doc URL (two candidate paths returned 404).

## Q2. API surfaces: can Claude Code, Codex, and Cursor point at them?

### Takeaway

By late 2026, every serious entrant exposes Anthropic Messages (`/v1/messages`) and usually OpenAI Responses alongside Chat Completions, so Claude Code (`ANTHROPIC_BASE_URL`) and Codex can point at LiteLLM, Bifrost, new-api, CLIProxyAPI, CCR, 9router, sub2api, and Olla. Infra gateways (Agent Router, agentgateway, Kong, APISIX) are mostly OpenAI-shaped and less coding-harness-oriented.

### Cited Findings

- **LiteLLM**: Claude Code uses `export ANTHROPIC_BASE_URL="http://0.0.0.0:4000"`. The docs include a Claude Code × LiteLLM compatibility matrix and pages on prompt cache routing, context management, and "Use Claude Code with Non-Anthropic Models". — [LiteLLM Claude Code Quickstart](https://docs.litellm.ai/docs/tutorials/claude_responses_api). The README shows harness integration "tagged `harness,claude_code`" for `claude`, `codex`, `opencode`, and `pi`. — [GitHub](https://github.com/BerriAI/litellm)
- **Bifrost**: OpenAI-compatible API plus drop-in Anthropic and GenAI replacement (`base_url = "http://localhost:8080/anthropic"`). — [GitHub](https://github.com/maximhq/bifrost). Claude Code connects through the `/anthropic` path, and Bifrost ships a "Bifrost CLI" that launches Claude Code preconfigured. — [Bifrost Claude Code docs](https://docs.getbifrost.ai/cli-agents/claude-code.md)
- **new-api**: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, Gemini APIs, plus Realtime and Responses WebSocket. RelayKit converts between "the four text protocols". — [GitHub README](https://github.com/QuantumNous/new-api); [README.en](https://raw.githubusercontent.com/QuantumNous/new-api/HEAD/README.en.md)
- **CLIProxyAPI**: works with "any OpenAI (including Responses), Gemini (including Interactions), or Claude-compatible client or SDK"; supports streaming, non-streaming, and WebSocket. — [GitHub README](https://github.com/router-for-me/CLIProxyAPI)
- **CCR**: supports "OpenAI Chat / Responses, Anthropic Messages, Gemini Generate Content / Interactions". It has agent profiles for Claude Code, Codex, Grok CLI, Kimi CLI, Kilo Code, OpenCode, Pi, and others. — [GitHub README](https://github.com/musistudio/claude-code-router)
- **9router**: OpenAI-compatible `/v1` at `localhost:20128`, translating "OpenAI ↔ Claude ↔ Gemini ↔ Cursor ↔ Kiro ↔ Vertex" plus OpenAI Responses. It claims to work with Claude Code, Codex, Cursor, Cline, and Copilot. — [GitHub README](https://github.com/decolua/9router)
- **sub2api**: `/v1/responses`, `/backend-api/codex/responses`, and `/v1/messages` (converted to xAI Responses for Grok accounts); accepts Codex CLI Responses WebSocket ingress. — [GitHub README](https://github.com/Wei-Shaw/sub2api)
- **Olla**: Anthropic Messages via passthrough to native backends or translation to OpenAI. — [README](https://github.com/thushan/olla)
- **Agent Router (Envoy)** and **agentgateway**: "unified OpenAI-compatible API" (agentgateway). — [agentgateway GitHub](https://github.com/agentgateway/agentgateway)
- **Kong AI Proxy Advanced**: lists "Messages" among its capabilities, supports passthrough "without payload format conversion", and says fallback "works across targets with any supported format". — [Kong docs](https://developer.konghq.com/plugins/ai-proxy-advanced/)
- **APISIX ai-proxy-multi**: transforms to OpenAI, DeepSeek, Azure, Anthropic, OpenRouter, Gemini, Vertex, Bedrock, and OpenAI-compatible formats. — [APISIX docs](https://apisix.apache.org/docs/apisix/plugins/ai-proxy-multi/)
- **Plano**: OpenAI-style chat completions in examples; its routing docs reference Claude Code turn structure ("A turn starts when the last message is from the user and still has text after Claude Code's..."). — [Plano LLM router docs](https://docs.planoai.dev/guides/llm_router.html)
- **vLLM Semantic Router** published "Adding Cursor-Style Auto Model Selection to OpenCode" (2026-07-09). It exposes one virtual model ("MoM") behind an OpenAI-compatible endpoint, runs as an ext-proc to AgentGateway, and is configured as an OpenCode custom provider. — [vLLM-SR blog](https://vllm-sr.ai/blog/opencode-auto-mode/)

### Inferences

- API-surface parity is now table stakes. A new local proxy would not differentiate on protocol translation. Its supervision semantics would be the differentiator (see Q5).

### Gaps

- I did not verify Cursor-specific compatibility; Cursor's custom base URL routes requests through Cursor's servers. CLIProxyAPI's ecosystem and 9router claim Cursor support.

## Q3. Fallback, retries, load balancing, cooldowns, circuit breakers, and quota/reset awareness (including waiting or parking)

### Takeaway

Everyone implements ordered fallback chains, retries with backoff, and cooldowns or circuit breakers. Bifrost has the most rigorous public failure taxonomy: it separates rate limits, permanent quota exhaustion, and caller fault, and it reads Retry-After but deliberately not reset headers. The subscription proxies (CLIProxyAPI, 9router, sub2api) are the only ones that track 5-hour, daily, and weekly quota windows and reset countdowns. None of the tools I reviewed parks work durably until a quota resets and then resumes. The longest "wait" behavior found is CLIProxyAPI waiting up to `max-retry-interval` (default 30 s) for a cooled-down credential.

### Cited Findings

**LiteLLM**

- Fallbacks are in-order and run after `num_retries`. There are 3 fallback types: generic, `ContentPolicyViolationError`, and `ContextWindowExceededError`. LiteLLM maps these error classes across providers. Generic fallback "covers all errors (429, 500, etc.)". A deployment is cooled down "once it fails more than [allowed_fails] calls within cooldown_time". "If all models in a group are in cooldown (e.g. rate limited), LiteLLM will fallback to the model with the specific model ID… This skips any cooldown check." Spend logs record whether a fallback served the request and the number of fallback attempts. — [LiteLLM Fallbacks](https://docs.litellm.ai/docs/proxy/reliability)
- Routing strategies: Weighted Pick (default), Rate-Limit Aware, Least Busy, Latency-Based, and Cost-Based. One option "moves a request off a deployment whose daily quota is spent". Deployments have an `order` (priority): "Each order level gets its own set of retries before escalating to the next," and failed deployments are excluded across hops so "a deployment that just failed is never picked again in the same request chain." Redis is used to share cooldown and TPM/RPM state across instances. — [LiteLLM Routing](https://docs.litellm.ai/docs/routing)
- Session affinity: "If the pinned deployment is in cooldown… the request falls through… The pin is kept, so the session returns to its deployment once it is healthy again" (since v1.97.0). The opt-in `session_affinity_repin_on_failover` keeps the replacement instead. — [LiteLLM Routing](https://docs.litellm.ai/docs/routing)

**Bifrost**

- Failures are classified as per-key, transient server, or request (caller) failures. A `429` rotates to another key "but still appl[ies] backoff, since providers often enforce account-level quotas shared across keys". Exhausted quota (`402`, OpenAI `insufficient_quota`, Anthropic "credit balance") marks the key "permanently dead for this request" with no backoff, because "waiting can't refill an account". `cancelled` (the caller disconnected) means "Fallbacks do not run". — [Bifrost Retries & Fallbacks](https://docs.getbifrost.ai/features/retries-and-fallbacks.md)
- Bifrost reads `google.rpc.RetryInfo`, `retry-after-ms`, and `Retry-After`, clamped to 1 s–5 min. "Rate-limit reset headers (`x-ratelimit-reset-*`, `anthropic-ratelimit-*-reset`) are not used: they say when each limit refills, not how long a given request must wait." In OSS the hint is informational only. Enterprise Adaptive Routing uses it to hold a refused key out of rotation (minimum 10 s). Backoff is `min(initial×2^attempt, max)×jitter(0.8–1.2)` with defaults of 500 ms and 5 s. Default `max_retries` is 0. "Each fallback provider gets its own full retry budget." — [same](https://docs.getbifrost.ai/features/retries-and-fallbacks.md)
- Enterprise Adaptive Routing has provider and key states Healthy, Degraded, Failed, and Recovering. A recovering key gets "a reduced share that grows as it serves cleanly". "Every usable key keeps a share, so a key that has recovered is noticed". "The failing provider stays as the last fallback, since a node's view of a failure can be out of date." — [Bifrost Adaptive Routing](https://docs.getbifrost.ai/enterprise/adaptive-routing/how-it-works.md)

**Portkey (OSS gateway configs)**

- `strategy.mode: fallback`, by default triggered on any non-2xx, or restricted with `on_status_codes: [429, 503]`. Strategies nest arbitrarily (load balancer, conditional router, fallback). — [Portkey Fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks.md)
- Circuit breaker settings: `failure_threshold`, `failure_threshold_percentage`, `cooldown_interval` (minimum 30 s), and `failure_status_codes` (the example includes 401 and 429). The circuit "closes automatically after cooldown_interval"; there is no half-open probe. "If all targets are OPEN, circuit breaker is bypassed." Conditional-mode strategies are not evaluated by the breaker. — [Portkey Circuit Breaker](https://portkey.ai/docs/product/ai-gateway/circuit-breaker.md). Retries go up to 5 with exponential backoff. — [GitHub README](https://github.com/Portkey-AI/gateway)

**Kong AI Proxy Advanced (Enterprise)**

- Balancers: round-robin (weighted), consistent-hashing (sticky by header), lowest-usage, lowest-latency (EWMA), semantic, and priority groups ("Higher-priority groups receive all traffic until they fail… Useful for cost-aware routing and controlled failover"). "Client errors don't trigger failover." `failover_criteria` is configurable. Circuit breaker example: after 3 failures a target is marked unhealthy; "After 10 seconds, the target is reconsidered. If the request to this target still fails, the target remains unhealthy… If the request succeeds, the target is marked healthy again". That is effectively a passive half-open check. "If all targets become unhealthy simultaneously, requests fail". — [Kong Load Balancing](https://developer.konghq.com/ai-gateway/load-balancing/)

**APISIX ai-proxy-multi**

- Priority and weight per instance. A fallback strategy of `instance_health_and_rate_limiting`, `http_429`, or `http_5xx` controls fallback. When a high-priority instance's token budget is exhausted, the request is forwarded to the next instance only if the strategy is set; otherwise lower-priority instances are not used. Additional fallback status codes (for example expired or out-of-quota keys) are opt-in "because most… responses are caused by the request itself and retrying them on another instance would only burn quota". `max_fallback_retries` and `retry_on_failure_within_ms` bound retries. Active health checks treat `[429,404,500,…]` as unhealthy by default. — [APISIX ai-proxy-multi](https://apisix.apache.org/docs/apisix/plugins/ai-proxy-multi/)

**Agent Router (Envoy AI Gateway)**

- Fallback is a list of backends: the first is primary and the rest are fallbacks. It triggers on "network errors, 5xx responses, or other health check failures" via Envoy retry policies, with an option for "only one attempt... per priority". — [Agent Router Provider Fallback](https://aigateway.envoyproxy.io/docs/capabilities/traffic/provider-fallback)

**CLIProxyAPI**

- `request-retry` retries on 403, 408, 500, 502, 503, and 504. `max-retry-interval` is the "Maximum wait time in seconds for a cooled-down credential before triggering a retry" (default 30; 0 means never wait). There are additional "credential retry rounds" for 403, 408, 429, and 5xx. Transient-error cooldown defaults to 60 s. `save-cooldown-status` can persist per-auth cooldown to `.cds` files; it defaults to in-memory. A quota-exceeded section has `switch-project` and `switch-preview-model`, plus "use credits as last-resort fallback when all free-tier auths are exhausted". — [CLIProxyAPI config docs](https://help.router-for.me/configuration/basic.html); [config.example.yaml](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/HEAD/config.example.yaml)
- Session binding: "Automatic failover is always enabled when bound auth becomes unavailable." In `"quota"` mode, transient errors (408, 5xx, empty stream) "fail over for that request only while keeping the session bound to its original credential; quota and auth errors (429, 401/402/403…) rebind". Subagents can inherit the parent's upstream credential. — [config.example.yaml](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/HEAD/config.example.yaml)
- Ecosystem apps show "per-account codex 5h/7d quota windows", "restore forecasts", and "reset countdown". — [GitHub README](https://github.com/router-for-me/CLIProxyAPI)

**9router**

- "Real-Time Quota Tracking: Live token count + reset countdown (5-hour, daily, weekly)". "Fallback to next account when one hits quota". "Auto switches when quota runs out or errors occur". — [GitHub README](https://github.com/decolua/9router)

**sub2api**

- "`429` responses use `Retry-After` or a short cooldown to temporarily remove the account from scheduling." 401 removes accounts with invalid credentials. 403 is treated as an entitlement failure, "instead of token-refresh loops". Quota display is passive: it records whitelisted rate-limit headers and shows "unknown" before the first response. — [GitHub README](https://github.com/Wei-Shaw/sub2api)

**Others**

- **CCR**: "retries, credential pools, key rotation, and ordered fallback models"; per-client "local request, token, and image limits". — [GitHub README](https://github.com/musistudio/claude-code-router)
- **new-api**: "channel priorities and weights, retries, channel affinity, and multiple upstream keys". — [GitHub README](https://github.com/QuantumNous/new-api)
- **TensorZero** (archived): "routing, retries, fallbacks, load balancing, granular timeouts" and custom rate limits by tag scope. — [GitHub](https://github.com/tensorzero/tensorzero)
- **Olla**: priority-based routing with automatic failover, health checks "with circuit breakers and automatic recovery", and retry on connection failure. — [README](https://github.com/thushan/olla)
- **FreeLLMAPI**: cools routes down on rate-limit or server errors. A "strict model group can keep the model identity stable while changing the route". Thompson-sampling adaptive routing. — [review](https://www.ai.joaoqueiros.com/blog/freellmapi-free-model-routing-coding-agents-media)

### Inferences

- **No tool parks requests or work durably and resumes after a quota reset.** Every tool is request-scoped: it retries, falls over, or returns an error to the client. Even quota-window-aware proxies (CLIProxyAPI, 9router) respond to exhaustion by moving to another account or model, not by waiting for the reset. CLIProxyAPI's longest wait is bounded per request (default 30 s). This is the clearest open gap relative to opencode-adaptive's "park durably and resume from session state".
- Strict half-open single-probe semantics are not documented anywhere. Kong's "reconsidered after 10 s; one success heals" comes closest. Portkey closes the circuit after a timer, and Bifrost Enterprise ramps traffic share gradually.
- On "429s don't trip breakers", the defaults diverge. Portkey's example counts 429 as a breaker failure, APISIX health checks treat 429 as unhealthy by default, and Bifrost explicitly treats 429 as a rotate-plus-backoff event rather than a dead key. That matches the plugin's philosophy most closely.
- Reset headers: Bifrost deliberately ignores `anthropic-ratelimit-*-reset`. sub2api passively records headers for display. The subscription proxies infer windows (5h, 7d) from provider-specific knowledge.

### Gaps

- I did not verify whether new-api auto-disables channels on 429 or quota errors; its docs page fetch returned nothing useful.
- I found no documented semantics for CCR's fallback triggers (which status codes) or cooldowns; its docs site is a JS app and did not render.
- I could not confirm whether LiteLLM's cooldown honors Retry-After or reset headers.

## Q4. Model-routing approaches: aliases, rules/metadata, cost/latency, semantic/LLM classifier, and capability tiers

### Takeaway

Routing ranges from static alias groups (LiteLLM model groups, Bifrost, new-api channels), through header/body rules (Portkey conditional, CCR conditions) and metric-based selection (latency, cost, usage), to learned or LLM classifiers. The learned/classifier routers are Plano-Orchestrator (a 4B model), the vLLM Semantic Router, LiteLLM's complexity "auto router", Kong's and APISIX's embedding-based semantic balancers, and FreeLLMAPI's bandit. The "tiers" that do exist are complexity tiers chosen by a classifier (LiteLLM) or cost tiers (9router: Subscription → Cheap → Free). No tool offers deterministic, evidence-gated capability tiers like opencode-adaptive's.

### Cited Findings

- **LiteLLM Auto Router**: `auto_router/complexity_router` with `complexity_router_config.tiers` (`SIMPLE`, `MEDIUM`, …) mapping to models, plus a `complexity_router_default_model`. "Choose a model for each prompt". — [GitHub README](https://github.com/BerriAI/litellm). There is also a "Claude Code - Auto Mode" page. — [LiteLLM docs nav](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- **Plano**: routes "by model name, alias (semantic names) or automatically via preferences". Preference-aligned routing uses Plano-Orchestrator to "infer domain and action" from the conversation (not the system prompt) and map them to configured models. Plano uses a hosted Plano-Orchestrator endpoint by default; it can be self-hosted (Arch-Router-1.5B GGUF, or via vLLM). — [Plano docs](https://docs.planoai.dev/guides/llm_router.html); "Powered by our 4B-parameter routing model". — [README](https://github.com/katanemo/plano)
- **vLLM Semantic Router** offers similarity between the prompt and model descriptions (RouterDC embeddings), a cascade with self-verification (AutoMix: "try the cheap model, verify its answer, escalate only on low confidence"), trained policies, and "Intent + operational signals" for "Compliance and predictability: category X always routes to model Y". — [vLLM-SR blog](https://vllm-sr.ai/blog/opencode-auto-mode/)
- **Kong**: semantic balancer based on prompt similarity to model descriptions. — [Kong Load Balancing](https://developer.konghq.com/ai-gateway/load-balancing/). **APISIX**: `semantic` algorithm. On upstream failure, "the semantic algorithm does not participate in health checks or… retry — an upstream failure on the chosen instance is returned to the client". — [APISIX docs](https://apisix.apache.org/docs/apisix/plugins/ai-proxy-multi/)
- **Bifrost OSS** offers routing rules and governance routing. Enterprise adds adaptive (health-based) provider and key selection. — [Bifrost Adaptive Routing](https://docs.getbifrost.ai/enterprise/adaptive-routing/how-it-works.md). Maxim markets Bifrost against OpenRouter Auto, Not Diamond, and RouteLLM as an "auto routing" tool. — [Maxim article](https://www.getmaxim.ai/articles/top-5-auto-routing-tools-for-llm-apps-in-2026/)
- **CLIProxyAPI** example: "Claude Code with a Codex backend: … classifier routing". — [GitHub README](https://github.com/router-for-me/CLIProxyAPI)
- **CCR**: "conditions on headers and bodies; prefixes; rewrites"; "model descriptions for task selection". — [GitHub README](https://github.com/musistudio/claude-code-router)
- **9router**: user-defined "combos" (ordered model lists) with a "Smart 3-Tier Fallback: Subscription → Cheap → Free". — [GitHub README](https://github.com/decolua/9router)
- **Hosted context**: OpenRouter introduced "New Auto and Auto Code Routers" on 2026-11-06. — [OpenRouter](https://openrouter.ai/)

### Inferences

- The market's idea of "tiers" is either cost tiers (9router) or classifier-inferred complexity (LiteLLM, vLLM-SR, Plano, OpenRouter Auto Code). opencode-adaptive's rule of no classifier, a deterministic priority order, and escalation only on structured evidence has no direct equivalent. The closest conceptual neighbor is vLLM-SR's AutoMix cascade, but that escalates on model-judged confidence, not on structured evidence.

### Gaps

- I did not check whether any gateway reads harness-supplied role hints (for example a subagent or "background" flag). Older CCR versions had `background`/`think`/`longContext` routes, but I could not confirm the current v3 config.

## Q5. Capacity vs capability failures: is the tier kept on fallback?

### Takeaway

Most gateways fall back to whatever comes next in the configured list, regardless of capability. Several do distinguish error classes:

- LiteLLM routes context-window and content-policy errors to dedicated chains.
- Bifrost separates rate limits, quota, and caller fault.
- APISIX and Kong refuse to fail over on client errors.
- CLIProxyAPI separates transient from quota/auth failures for session rebinding.
- FreeLLMAPI offers "strict model groups".

None models a capability tier as a first-class invariant. 9router explicitly does the opposite: it intentionally degrades from subscription models to cheap and then free models when quota runs out.

### Cited Findings

- **LiteLLM**: separate `context_window_fallbacks` and `content_policy_fallbacks`. "If a matching context window chain is exhausted, the request returns an error rather than continuing through the original group's order or generic fallback chain." "Sibling retries, order failover, and cross-group fallbacks are separate operations." Within a group, retries "re-pick… only among the deployments in the current minimum-order tier". Promotion to the next order happens through order-based fallback. — [LiteLLM Fallbacks](https://docs.litellm.ai/docs/proxy/reliability); [Routing](https://docs.litellm.ai/docs/routing)
- **Bifrost**: fallback runs "whatever the error", except when the caller cancelled, when a plugin set `AllowFallbacks=false`, or when the error is `caller_fault` and the fallbacks came from the model catalog rather than being named by the caller. — [Bifrost Retries & Fallbacks](https://docs.getbifrost.ai/features/retries-and-fallbacks.md). With "Redirect To: The request's own fallbacks", Enterprise Adaptive Routing moves to "the first of its own fallbacks that is not failing, whatever its provider or model". — [Adaptive Routing](https://docs.getbifrost.ai/enterprise/adaptive-routing/how-it-works.md)
- **Kong**: "Client errors don't trigger failover." — [AI Proxy Advanced](https://developer.konghq.com/plugins/ai-proxy-advanced/). **APISIX** makes 4xx fallback opt-in because retrying a request-caused error "would only burn quota". — [APISIX](https://apisix.apache.org/docs/apisix/plugins/ai-proxy-multi/)
- **Portkey** recommends "Ensure fallback LLMs are compatible with your use case" and per-slot fallback chains so "One model family failing doesn't trigger another family's backup". — [Portkey Fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks.md)
- **9router**: "Subscription hits limit → Auto-fallback to cheap tier"; example combo `claude-opus` → `glm-5.1` → `kr/claude-sonnet-4.5` → `minimax`. — [GitHub README](https://github.com/decolua/9router)
- **FreeLLMAPI**: "a strict model group can keep the model identity stable while changing the route. Broader fallback chains can then move to another model if the workflow allows it." The reviewer warns that fallback "does not prove semantic equivalence". — [review](https://www.ai.joaoqueiros.com/blog/freellmapi-free-model-routing-coding-agents-media)
- **CLIProxyAPI**: `switch-preview-model` on quota exceeded swaps to a different model. In session-binding `"quota"` mode, transient errors versus quota/auth errors decide whether a session rebinds to another credential. — [config docs](https://help.router-for.me/configuration/basic.html); [config.example.yaml](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/HEAD/config.example.yaml)

### Inferences

- Users can approximate "same tier on fallback" in LiteLLM (model groups plus `order`), Portkey (nested per-family chains), and Kong (priority groups). They do it by hand-curating lists. No tool enforces the rule or refuses to borrow across tiers when a tier is exhausted.
- No tool has an escalation path driven by structured evidence (verification failure, reviewer rejection). Escalation in the market is either classifier-driven (vLLM-SR AutoMix confidence) or a by-product of fallback order. This is opencode-adaptive's sharpest differentiator.

### Gaps

- I found no documentation in any tool of a "do not cross capability tier when exhausted; wait instead" policy.

## Q6. Mid-stream failures, tool-call continuity, and prompt caching

### Takeaway

Gateways can safely fail over only before the first byte or chunk is sent. LiteLLM and Bifrost document this explicitly, and CLIProxyAPI has "safe bootstrap retries". After output has started, errors surface to the client as stream errors. LiteLLM documents a notable continuity problem: encrypted reasoning items cannot be carried to another provider or key, so they are dropped on fallback. Session or credential affinity is the common tool for keeping prompt caches warm.

### Cited Findings

- **LiteLLM**: mid-stream fallback applies "when the chosen deployment's stream fails before its first chunk". On any fallback to another provider or API key, the target "cannot decrypt the encrypted reasoning the failed deployment produced on earlier turns". LiteLLM "drops what the target cannot decrypt and keeps each Responses reasoning item's readable summary (a thinking block is dropped whole), so the fallback target reasons fresh on that turn". "There is no per-deployment switch for it." — [LiteLLM Fallbacks](https://docs.litellm.ai/docs/proxy/reliability)
- **LiteLLM** session affinity returns a session to its pinned deployment after cooldown. There is also a "Claude Code - Prompt Cache Routing" doc. — [Routing](https://docs.litellm.ai/docs/routing); [docs nav](https://docs.litellm.ai/docs/tutorials/claude_responses_api)
- **Bifrost**: startup buffering lets errors that arrive before output reach retry and fallback. "Buffered events from failed attempts are discarded… Errors after that boundary remain stream errors." "Raw streaming passthrough and Responses retrieval/resumption are excluded." Timeouts include TTFT limits. — [Bifrost Retries & Fallbacks](https://docs.getbifrost.ai/features/retries-and-fallbacks.md)
- **CLIProxyAPI**: "Streaming behavior (SSE keep-alives + safe bootstrap retries)… Retries before first byte is sent." Responses WebSocket "Keeps one upstream account/model per socket; accepted input is never replayed." Session headers from Claude Code, Codex, OpenCode, and pi pin sessions to credentials. — [config docs](https://help.router-for.me/configuration/basic.html); [config.example.yaml](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/HEAD/config.example.yaml)
- **sub2api**: Nginx drops underscore headers such as `session_id`, which "breaks sticky session routing in multi-account setups" for Codex CLI. — [GitHub README](https://github.com/Wei-Shaw/sub2api)
- **Kong**: consistent-hashing gives "sticky sessions for maintaining context across user interactions". — [Kong Load Balancing](https://developer.konghq.com/ai-gateway/load-balancing/)

### Inferences

- Because a proxy sees only one request at a time, it cannot implement "switch only at safe boundaries, i.e. work-unit start". Its only safe boundary is "before the first byte of this HTTP request". In an agent loop, a proxy fallback can switch models between tool-call turns of the same work unit, which opencode-adaptive's invariants forbid. A proxy version of the plugin would need harness-level session or work-unit signals, for example session headers like those CLIProxyAPI already parses, to approximate this.
- LiteLLM's reasoning-stripping note shows that cross-provider fallback mid-session has a real continuity cost: lost reasoning state and cache misses. Session pinning ("return to preferred once healthy") is the industry's answer and partially mirrors the plugin's "restore preferred model at next safe boundary".

### Gaps

- I found no gateway that resumes a broken stream with native continuation. Bifrost explicitly excludes "Responses retrieval/resumption".

## Q7. Subscription/OAuth accounts (Claude Pro/Max, ChatGPT/Codex, Copilot) vs API keys

### Takeaway

Two models exist. (1) Pass-through of the client's own subscription token: LiteLLM and Bifrost forward Claude Code's OAuth token to Anthropic while adding governance and logging. (2) Proxy-held OAuth credential pools: CLIProxyAPI, 9router, sub2api, claude-relay-service, and CCR log into Claude Code, Codex, Copilot, Grok, and other accounts and load-balance across them. The pooling projects are explicitly built around sharing subscriptions ("拼车", carpooling), which carries terms-of-service risk.

### Cited Findings

- **LiteLLM**: "Send Claude Code requests through LiteLLM using your own Claude Pro, Max, Team, or Enterprise subscription." LiteLLM forwards the client OAuth token to direct Anthropic deployments "ahead of any configured API key", adds the OAuth beta header, and logs `used_client_oauth_token=true`. Cost is reported at API list prices. Bedrock and Vertex use their own credentials. The docs nav lists "Claude, Codex & Copilot subscriptions". — [LiteLLM: Use your Claude subscription](https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription)
- **Bifrost**: in subscription mode Claude Code sends `Authorization: Bearer sk-ant-oat…`, "Bifrost forwards that token to Anthropic instead of selecting a provider key", and uses the `x-bf-vk` header for governance. "Subscription usage limits still apply." — [Bifrost Claude Code](https://docs.getbifrost.ai/cli-agents/claude-code.md)
- **CLIProxyAPI**: "OpenAI Codex support… via OAuth login", "Claude Code support via OAuth login", "Grok Build support via OAuth login", and "Multiple accounts with round-robin load balancing". Credential weights can be set per OAuth auth file. The ecosystem includes apps advertising "no API keys needed" and GitHub Copilot connectors. — [GitHub README](https://github.com/router-for-me/CLIProxyAPI); [config.example.yaml](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/HEAD/config.example.yaml)
- **9router**: OAuth providers include Claude Code, Codex, GitHub Copilot, and Cursor, with "Auto Token Refresh". — [GitHub README](https://github.com/decolua/9router)
- **sub2api**: "distribute and manage API quotas from AI product subscriptions"; OAuth and API-key account types; an xAI OAuth PKCE flow. — [GitHub README](https://github.com/Wei-Shaw/sub2api). **claude-relay-service** describes "拼车共享" (carpool sharing) of Claude, OpenAI, Gemini, and Droid subscriptions. — [GitHub](https://github.com/Wei-Shaw/claude-relay-service)
- **CCR**: "local login import where supported; single keys and credential pools". — [GitHub README](https://github.com/musistudio/claude-code-router)
- **new-api, Portkey, Kong, APISIX, Agent Router, agentgateway**: documentation is API-key and provider-credential oriented. new-api's OAuth/OIDC is for user login to the gateway, not upstream subscriptions. — [new-api README](https://github.com/QuantumNous/new-api)

### Inferences

- The pass-through model (LiteLLM, Bifrost) is the low-risk way to support subscription users. The pooling model is popular but legally and ToS-fraught. A local single-user supervisor fits the pass-through model, combined with per-account quota-window awareness.

### Gaps

- I did not verify provider ToS positions on proxying subscription tokens; that is out of scope here.

## Q8. Observability, privacy, telemetry, and local logs

### Takeaway

Most tools log locally (SQLite or Postgres, a dashboard) and export OpenTelemetry or Prometheus. Several default to or nudge toward hosted components: Plano's hosted router endpoint, Helicone's cloud integration, 9router's optional Cloud Sync, and TensorZero's ClickHouse/Postgres. I did not verify each tool's default anonymous-telemetry setting.

### Cited Findings

- **LiteLLM**: spend logs record which deployment served each request and whether a fallback occurred. There is an admin dashboard, Prometheus via docker-compose, and cosign-signed images. — [Reliability](https://docs.litellm.ai/docs/proxy/reliability); [GitHub](https://github.com/BerriAI/litellm)
- **Bifrost**: `extra_fields.routing_info` shows which provider served the request and whether it was a fallback. A per-attempt `attempt_trail` includes `retry_after_ms`. The repo has a `telemetry/` module ("Monitoring and observability"). — [Retries & Fallbacks](https://docs.getbifrost.ai/features/retries-and-fallbacks.md); [GitHub](https://github.com/maximhq/bifrost)
- **Portkey**: "logs all requests in a fallback chain". — [Fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks.md)
- **Plano**: "Every request is traced end-to-end with OpenTelemetry". Routing uses a hosted Plano-Orchestrator endpoint by default, which means prompts are sent off-box unless the model is self-hosted. — [README](https://github.com/katanemo/plano); [docs](https://docs.planoai.dev/guides/llm_router.html)
- **Olla**: embedded read-only dashboard at `/internal/ui/` that is "on by default and loopback-only". — [README](https://github.com/thushan/olla)
- **CLIProxyAPI**: a Management API used by third-party quota dashboards; cooldown state stays in memory unless `save-cooldown-status` is set. — [config.example.yaml](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/HEAD/config.example.yaml)
- **9router**: "Localhost - Default, works offline"; optional "Cloud Sync" of providers, combos, and settings across devices. — [README](https://github.com/decolua/9router)
- **TensorZero** (archived): stores inferences and feedback in your database; OTLP and Prometheus export. — [GitHub](https://github.com/tensorzero/tensorzero)
- **agentgateway**: "OpenTelemetry metrics/logs/tracing". — [GitHub](https://github.com/agentgateway/agentgateway)
- INFRO's 2026 checklist recommends knowing "which subprocessors process your data" after acquisitions. — [INFRO](https://infro.io/blog/who-owns-your-ai-gateway-2026)

### Inferences

- A strictly local-only, no-telemetry, bounded-receipt design is not a stated selling point of any major gateway. Olla's loopback-only dashboard is the nearest. This could be a differentiator for a privacy-focused local supervisor.

### Gaps

- I did not verify default anonymous usage telemetry in LiteLLM, Bifrost, new-api, CCR, or CLIProxyAPI. The LiteLLM production doc that may cover it returned 404 at the raw path tried.

### Summary matrix (compiled from the findings above; "—" means not documented or not found)

| Tool                     | Local daemon fit                            | Anthropic Messages / Responses | Fallback + cooldown/breaker                                                 | Reads Retry-After / reset                      | Quota-window aware               | Waits or parks until reset        | Capability-tier-preserving                  | Subscription OAuth                               |
| ------------------------ | ------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------- | --------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| LiteLLM                  | Python/uv or Docker (Rust core in progress) | Yes / Yes                      | Yes; cooldown via allowed_fails; order tiers; context/content-policy chains | —                                              | daily-quota routing option       | No                                | Manual (groups + order)                     | Pass-through (Claude); Codex/Copilot docs listed |
| Bifrost                  | npx / Docker, Go                            | Yes (/anthropic)               | Yes; failure taxonomy; Enterprise health states                             | Retry-After yes; reset headers deliberately no | —                                | No (hint is informational in OSS) | No (any listed fallback)                    | Pass-through (Claude)                            |
| Portkey OSS              | Node/Docker                                 | —                              | Yes; breaker with cooldown (≥30 s), no half-open                            | —                                              | —                                | No                                | Manual nesting                              | —                                                |
| Kong (Enterprise plugin) | Heavy                                       | Messages                       | Priority groups; breaker reconsidered after 10 s                            | —                                              | —                                | No                                | Manual priority groups                      | —                                                |
| APISIX ai-proxy-multi    | Heavy                                       | Translation                    | Priority/weight, health checks, bounded retries                             | —                                              | token-budget exhaustion fallback | No                                | Manual                                      | —                                                |
| Agent Router (Envoy)     | K8s                                         | OpenAI-shaped                  | Priority backends via Envoy retry                                           | —                                              | —                                | No                                | —                                           | —                                                |
| new-api                  | Go binary/Docker                            | Yes / Yes                      | channel priority/weight/retry/affinity                                      | —                                              | —                                | No                                | —                                           | —                                                |
| CLIProxyAPI              | Go binary, many desktop wrappers            | Yes / Yes (+WS)                | Credential cooldowns, retry rounds, session binding                         | Cooldown waits ≤30 s default                   | Yes (via ecosystem: 5h/7d)       | Bounded short wait only           | No (switch-preview-model)                   | Pools (Claude, Codex, Grok…)                     |
| CCR                      | Desktop app :3456                           | Yes / Yes                      | Ordered fallbacks, credential pools                                         | —                                              | local limits                     | —                                 | —                                           | Local login import                               |
| 9router                  | npm / Next.js :20128                        | via translation                | Combos, multi-account                                                       | —                                              | Yes (5h/daily/weekly countdown)  | No (falls to cheaper tier)        | Explicitly no (Subscription → Cheap → Free) | Pools (Claude, Codex, Copilot, Cursor)           |
| sub2api                  | Go + Redis                                  | Yes / Yes                      | 429 → Retry-After cooldown                                                  | Retry-After yes                                | passive header capture           | No                                | —                                           | Pools                                            |
| Plano                    | Rust/Envoy, Docker                          | OpenAI-shaped                  | fallbacks listed                                                            | —                                              | —                                | No                                | Classifier (LLM) routing                    | —                                                |
| vLLM-SR                  | Go, ext-proc                                | OpenAI                         | default-route fall-through                                                  | —                                              | —                                | No                                | Classifier / cascade                        | —                                                |
| TensorZero               | Archived 2026-06-12                         | —                              | Yes                                                                         | —                                              | —                                | No                                | —                                           | —                                                |
| Helicone GW              | Maintenance mode                            | —                              | Yes                                                                         | —                                              | —                                | No                                | —                                           | —                                                |
