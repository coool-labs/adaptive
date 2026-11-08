# Hosted LLM routers/aggregators and "smart model routing" products (state as of Nov 2026)

Scope note: research done 2026-11-07, mostly from vendors' own docs (llms.txt / markdown endpoints), plus Hacker News threads and a few blog posts for criticism. Docs pages carry 2026 "last updated" stamps where shown. Information I only know from training data and couldn't re-verify is listed under Gaps and not stated as fact.

## How does model selection work in each product (classifier vs rules vs presets, per-request vs per-session, tiers/escalation)?

### Takeaway

The market has converged on a **per-turn learned/LLM "decision model" classifier with session stickiness**: OpenRouter Auto/Auto Code, Cloudflare `cloudflare/auto`, Requesty Auto Routing, Kilo `kilo-auto/efficient`, Copilot Auto, Azure model router, Bedrock prompt routing, Not Diamond. All of them make prompt-content-based judgments, and none uses only deterministic signals. Several now escalate on failure signals (OpenRouter Auto Code, NVIDIA Switchyard "stage") and rebrand "tiers" as cost tiers. Kilo's `kilo-auto/frontier`, which maps by agent mode, is the closest analogue to Adaptive's deterministic role-hint routing. None of them describes "capability tier preserved on infra failure" as an invariant.

### Cited Findings

**OpenRouter (model routers sit on top of provider routing)**

- Router slugs are sent as the `model`. The response's `model` field names the model actually used. Routers listed: `openrouter/auto`, `openrouter/auto-code`, `openrouter/free`, `openrouter/pareto-code`, `openrouter/fusion`, `nvidia/switchyard`, `typesafe/jev-router`. — [OpenRouter Model Routing overview](https://openrouter.ai/docs/guides/routing/routers/overview.md)
- Auto Router pipeline: (1) narrow the pool by guardrails, ZDR, capabilities, provider restrictions, BYOK keys, and allowed/excluded lists; (2) "A fast decision model rates eleven aspects of the request in one call, such as what kind of task it is, whether the task just changed, how hard it is, whether speed matters, whether it needs vision or knowledge of a codebase"; (3) a routing policy weighs that rating against live prices, cache status, and benchmarks within a `cost_tier` to pick **model and reasoning effort**; (4) normal provider routing; (5) "Carry signals to the next turn… such as whether the model is struggling and how much context is already cached." — [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)
- Auto Router session stickiness: "can pick a different model on every turn. Switching models costs extra while the new model rebuilds the prompt cache, so the router is restrained about it. It favors a change in reasoning effort… and switches models only when the gain is worth it, for example when the task changes or when signals such as a repeated error or failing tests point at the model." Sessions are identified by `session_id` or a message fingerprint. — [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)
- Auto Code (`openrouter/auto-code`) is tuned for coding harnesses: it starts in a higher cost tier, weighs speed more, and "penalizes failures more harshly, so it course corrects faster when tests fail or the same error comes back"; it "switches when failure signals show the model is the problem." It adds no fee. — [OpenRouter Auto Code](https://openrouter.ai/docs/guides/routing/routers/auto-code.md)
- Routing decisions can be inspected with the `X-OpenRouter-Metadata: enabled` header (`resolved_models`, `candidates`, `reason`). — [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)
- NVIDIA Switchyard on OpenRouter: you name 1–3 candidates, and OpenRouter assigns **efficient vs capable tiers purely by price** (cheapest = efficient, most expensive = capable; the middle one is neither). Algorithms: `stage` (default) "Scores the tool results already in the conversation, such as errors, repeated failures, and edits that landed… doesn't call a classifier", falling back to a small judge model when the score isn't decisive; `capability` (judge on every human turn); `composite` (remembers the chosen tier for the conversation and holds it through long agent tasks unless tool results point elsewhere); plus `random`/`passthrough`. Without `models`, the pair is chosen from the top-20 spend models over the past 7 days. — [OpenRouter Switchyard](https://openrouter.ai/docs/guides/routing/routers/switchyard-router.md); open source: [NVIDIA-NeMo/Switchyard](https://github.com/NVIDIA-NeMo/Switchyard)

**Requesty**

- Auto Routing (beta): an admin writes a plain-language question plus route labels, and each label maps to a model. A "decision model" classifier (e.g. `typesafe/jev-1.14.0`, `cloudflare/clef`, `azure/decision-1`) reads **only the first user message** of a conversation and returns a probability per label. Below the confidence threshold, or on a classifier error, the request goes to a fallback model. "The chosen model is remembered for the rest of the conversation… the model never switches halfway through a task. Prompt caches keep working." The pin lasts 60 min per conversation, keyed by `trace_id`. Requesty claims "Up to 43% lower cost" on coding in early internal benchmarks. — [Requesty Auto Routing](https://docs.requesty.ai/features/auto-routing.md)
- Requesty's example coding policy routes by **change type** ("additive… following an existing pattern" → Haiku; "changes existing behaviour in one place" → Sonnet; larger → Opus). — [Requesty Auto Routing](https://docs.requesty.ai/features/auto-routing.md)
- Other policies are static: Fallback chains, weighted Load Balancing, and Latency routing, all referenced as `model="policy/<name>"`. — [Requesty llms.txt](https://docs.requesty.ai/llms.txt)

**Cloudflare AI Gateway**

- Auto Router (`cloudflare/auto`, beta; page updated Nov 4, 2026): builds an eligible pool (format/inputs, credentials, billing, spend limits; "Unhealthy providers are excluded and restored automatically once they recover"). A classification step estimates task type and difficulty, and a scoring step weighs quality against cost. It "attempts the top-ranked model first, and falls back to the next one if a provider cannot serve the request." — [Cloudflare Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/index.md)
- Session affinity: with `cf-aig-session-id`, it "keeps the same model for an entire turn" (a turn is a user message plus tool-call follow-ups). "At the start of each turn, Auto Router switches models only when the expected benefit outweighs the cost of losing the cache." Without a session ID, model choice is per request and the cache is lost. OpenCode sends the session ID automatically. Response headers include `cf-aig-routed-model` and `cf-aig-routing-reason`. The default pool is managed by Cloudflare and changes over time; model aliases with "Smart routing" let you choose your own set. — [Cloudflare Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/index.md)
- Dynamic Routes (beta) are a versioned visual/JSON flow with Conditional nodes (on body, headers, metadata such as `user_plan == "paid"`), Percentage split, Model, Rate Limit and Budget Limit nodes ("switches to fallback when exceeded"). They are deterministic rules, not a classifier. — [Cloudflare Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/index.md)

**Vercel AI Gateway**

- No auto/smart model router found in the docs I read. Routing is explicit: provider `order` / `only` / `sort` (`cost`, `ttft`, `tps`), and `models` fallback arrays. A "decision fallbacks" feature can rerun on a successful-but-uncertain result based on confidence. — [Vercel provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.md); [Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks.md)

**Portkey (now branded "Prisma AIRS AI Gateway", Palo Alto Networks)**

- Rule/config based: composable `fallback`, `loadbalance`, and `conditional` strategies, and "Any strategy can nest inside any other." I found no learned router. — [Portkey Fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks.md); branding per [Portkey llms.txt](https://portkey.ai/docs/llms.txt)

**Kilo Gateway / Kilo Code (Kilo acquired by Anaconda, per docs banner)**

- `kilo-auto/frontier`: a **deterministic mode→model map**. `plan/general/architect/orchestrator/ask/debug` → `anthropic/claude-opus-4.7`; `build/explore/code` → `anthropic/claude-sonnet-4.6`; default → Sonnet. The mode is passed by header. — [Kilo Gateway Models & Providers](https://kilo.ai/docs/gateway/models-and-providers)
- `kilo-auto/efficient`: "Session-aware routing that classifies the difficulty of each request in real time and routes it to the cheapest model proven accurate enough… keeps using a model across related turns and only switches when a cheaper option is clearly worth it." Low-confidence decisions fall back to `z-ai/glm-5.3-flash`. `kilo-auto/small` serves background tasks (titles, commit messages). The underlying models change server-side. — [Kilo Auto Model](https://kilo.ai/docs/code-with-ai/agents/auto-model); [Kilo Gateway Models & Providers](https://kilo.ai/docs/gateway/models-and-providers)

**Azure AI Foundry model router**

- Deployed as one model. It "selects an underlying model for each request" with routing modes **Balanced** (default: considers models within ~1–2% of the top quality for that prompt and picks the cheapest), **Cost** (~5–6% band), and **Quality** (highest quality regardless of cost). You can choose a model subset. Version `2025-11-18` is updated in place with new models. It routes across OpenAI, DeepSeek, Meta, xAI, and Anthropic models (Claude must be deployed separately). "The effective context window is limited by the smallest underlying model." — [Azure model router concepts](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-router)

**AWS Bedrock Intelligent Prompt Routing**

- Routes "between different foundational models **within the same model family**", predicting response quality per request. A configured router has a **fallback model** anchor plus a "response quality difference" threshold (e.g. switch to Nova Pro only if its predicted quality is >10% better than Nova Lite's). Limitations: "only optimized for English prompts", "can't adjust routing decisions… based on application-specific performance data." — [Bedrock prompt routing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)

**Not Diamond**

- A per-query predictive router ("predicts which model will provide the highest quality response at the lowest cost for that specific query"). Tradeoff modes are Quality (default), Cost, and Latency. It offers a pre-trained chat router, custom routers trained on your eval data (`/trainCustomRouter`), and a `/modelSelect` API that **returns a recommendation; the caller makes the LLM call**. A "Pre-trained router: Code" for long-horizon coding agents (claimed 30%+ cost cut) is in early preview, sign-up only (page updated 2026-06-06). — [What is Model Routing](https://docs.notdiamond.ai/docs/what-is-model-routing.md); [Pre-trained router: Code](https://docs.notdiamond.ai/docs/pre-trained-router-code.md); [Not Diamond llms.txt](https://docs.notdiamond.ai/llms.txt)

**Martian**

- Martian's homepage now presents it as "an AI research lab focused on understanding machine intelligence" (interpretability, ARES RL framework, K-Steering) and mentions "Thesean AI — A Lab Building Best Execution for LLMs". Its current product is a "Gateway" giving "unified access to 200+ AI models" with OpenAI/Anthropic compatibility and integration guides for Claude Code, Cline, Codex, Cursor, OpenCode. I found **no current router feature** in the public docs. — [withmartian.com](https://withmartian.com); [Martian docs](https://docs.withmartian.com)

**Unify.ai**

- Pivoted: the homepage now sells "Continual learning for AI teams… Every user interaction trains the model driving your agent" (Continual-ARC, Oct 2026 post). Its earlier LLM router/benchmark product is no longer on the homepage. — [unify.ai](https://unify.ai)

**Research routers**

- RouteLLM (LMSYS, 2024): a binary strong/weak router (e.g. matrix factorization `mf`) with a **cost threshold** calibrated to a target share of strong-model calls. It ships as an OpenAI-compatible server (`model="router-mf-0.11593"`). Claims "reduce costs by up to 85% while maintaining 95% GPT-4 performance" on MT Bench. — [RouteLLM README](https://raw.githubusercontent.com/lm-sys/RouteLLM/main/README.md); [paper](https://arxiv.org/abs/2406.18665) _(older, 2024)_
- Arch-Router (Katanemo, Jun 2025): a 1.5B model (Qwen2.5-1.5B fine-tune) that maps queries to **user-defined domain/action preferences** (e.g. "travel", "image editing") rather than benchmark quality. New models can be added without retraining. — [arXiv 2506.16655](https://arxiv.org/abs/2506.16655); [HF model card](https://huggingface.co/katanemo/Arch-Router-1.5B)

**Harness "Auto" modes (brief)**

- GitHub Copilot Auto: available on all plans. "Auto with task optimization" combines a system that "tracks real-time system health and availability" with one that "evaluates task complexity". "Routing occurs along natural cache boundaries and large drifts in conversation complexity." Tiers are Efficiency / Balance / Intelligence. Paid plans get a 10% discount on model costs with Auto. — [GitHub Copilot auto model selection](https://docs.github.com/en/copilot/concepts/auto-model-selection)
- Cursor: Cursor is now sold as part of "The X Subscription". On Teams/Enterprise, "Cursor Router picks among Cursor models and third-party models for each Balance or Intelligence request based on your optimization mode." Lower plans (Plus) have "No Auto". — [Cursor Models & Pricing](https://cursor.com/docs/models)

### Inferences

- Adaptive's "no LLM classifier, no keyword soup" stance is now a clear differentiator. Every commercial "auto" product sends prompt content to a decision model (often a third-party one such as Typesafe Jev or Cloudflare Clef). Requesty's choice to pin per conversation and classify only the first message is closest to Adaptive's "route only at safe boundaries".
- Industry practice has independently converged on Adaptive's "switch only at safe boundaries" principle, which validates it: Cloudflare pins per turn, Requesty per conversation, Copilot routes on "natural cache boundaries", and OpenRouter favors effort changes over model switches. The motivation is prompt-cache economics, not correctness/side-effect durability as in Adaptive.
- Escalation on structured failure evidence now exists commercially: OpenRouter Auto Code (failing tests, repeated errors) and Switchyard `stage` (scores tool results without a classifier). Switchyard `stage` is the closest commercial/OSS analogue to Adaptive's "deterministic local evidence" signal, but it is inferred from tool output heuristics, not an explicit schema-validated escalation request with reason + evidence.
- Kilo's `kilo-auto/frontier` (agent mode → model) is effectively Adaptive's "supported role hint" rule, hosted.
- "Tiers" in these products are price buckets (OpenRouter `cost_tier`, Switchyard efficient/capable by price, Copilot Efficiency/Balance/Intelligence). None defines tiers by user-declared capability classes over the user's own provider set.

### Gaps

- Whether `openrouter/auto` is still powered by Not Diamond: current docs describe an in-house engine using a "fast decision model" (and list a separate Jev router). I didn't find a current statement either way, and the Not Diamond partnership I recall from 2024–2025 is unverified here.
- Martian's former model-router product: I found no current documentation, so I couldn't confirm whether it was discontinued or is partner-only ("Additional tooling is available for our partners").
- Unify's old router product status (sunset date) wasn't found.
- I found no independent evaluations of routing quality for OpenRouter Auto Code, Cloudflare Auto, or Kilo efficient. OpenRouter publishes its own [Model Routing Benchmarks](https://openrouter.ai/benchmarks/routers), but I didn't fetch it.
- Arch-Router's current deployment vehicle (Katanemo "Arch"/"Plano" gateway) wasn't researched.

## Failover: same model on another provider, or a different model? Is fallback capability-preserving?

### Takeaway

Hosted gateways do two layers. The first is automatic, health-weighted **same-model cross-provider failover** (capability-preserving by construction). The second is **user-listed cross-model fallback chains** that fire on any error, including rate limits and context-length errors, with **no capability-equivalence check**: docs examples happily chain Sonnet→GPT→Gemini or cheap→premium. The only "capability preservation" is whatever the user encodes in the list.

### Cited Findings

- OpenRouter provider routing: traffic shares are weighted by price, throughput, TTFT, 429 rate, reliability, and tool-call quality. "A provider whose errors or 429s are far worse… gets no traffic until it recovers." "Routing learns how much load each provider can take before it returns 429s." "A burst of 429s or a jump in latency briefly lowers a provider's share." Retries are picked from the remaining providers. `allow_fallbacks` (default true), `order`, `only`, `ignore`, `sort`, `require_parameters`. — [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection.md)
- OpenRouter model fallbacks (`models` array): "By default, any error can trigger the use of a fallback model, including: Context length validation errors, Moderation flags…, Rate-limiting, Downtime." The bill is at the price of the model actually used. The docs example falls back from `~anthropic/claude-sonnet-latest` to `gryphe/mythomax-l2-13b` (a much weaker model). On the Anthropic Messages endpoint, `fallbacks` allows at most 3 entries. — [OpenRouter Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md)
- OpenRouter `sort.partition: "none"` lets endpoints be sorted globally across all fallback models, so the primary model is no longer guaranteed to be tried first. — [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection.md)
- OpenRouter Auto Exacto: on by default for every request with tools. It reorders providers using throughput, a tool-calling success rate (JSON-Schema Draft 7 validation of tool args: InvalidJson / UnknownName / SchemaMismatch), and OpenRouter's own benchmark harness. — [OpenRouter Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto.md)
- Claude Code via OpenRouter: "automatically fail over between multiple Anthropic providers" (Anthropic, Bedrock, Vertex), i.e. same model across providers. — [OpenRouter Claude Code guide](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration.md)
- Requesty fallback policies: an ordered chain of models, each with 0–10 retries, exponential backoff (500ms→1s→2s→4s) with ±10% jitter, and "Immediate failover on non-retryable errors (invalid request, auth failure)". Examples include **cross-family** chains (GPT→Claude→Gemini) and "Start with cheaper models, only use expensive ones if needed." A warning tells the user to ensure all models support the request's parameters (context, tools); otherwise "the policy will skip to the next model." — [Requesty Fallback Policies](https://docs.requesty.ai/features/fallback-policies.md)
- Vercel AI Gateway: by default, providers are ordered by priority "adjusted for recent provider health, and fails over to other providers serving the same model." `only` is a hard filter ("never fails over outside the list"). The `models` array is tried model by model, applying provider rules for each. The docs example falls back from `openai/gpt-6-astra` to `openai/gpt-5.4-nano` (a smaller model) to `anthropic/claude-opus-5`. — [Vercel provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.md); [Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks.md)
- Portkey: fallback triggers on any non-2xx by default, customizable via `on_status_codes` (e.g. `[429]` only, or `[429, 503]`). Targets can be other providers for the same model or different models, and nesting allows "Isolate Failures Between Model Families". — [Portkey Fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks.md)
- Cloudflare: Auto Router falls back to the next-ranked model "if a provider cannot serve the request". Dynamic Routes' Rate Limit/Budget nodes switch to a fallback branch when **self-imposed** quotas are exceeded. — [Cloudflare Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/index.md); [Cloudflare Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/index.md)
- Switchyard on OpenRouter: "If that model fails, OpenRouter falls back to the next model in the plugin's order", which may cross tiers. — [OpenRouter Switchyard](https://openrouter.ai/docs/guides/routing/routers/switchyard-router.md)
- Bedrock: the "fallback model" is a routing anchor (the default choice), not an error-failover target. — [Bedrock prompt routing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)
- OpenRouter prompt-cache stickiness: after a cached request, it routes to the same provider (only when cache-read is cheaper than the prompt price). Stickiness expires after 60 min idle, and "If the sticky provider becomes unavailable, OpenRouter automatically falls back to the next-best provider." It is keyed by `session_id` / `x-session-id` / `prompt_cache_key`, or else a hash of the first system and first non-system message. — [OpenRouter Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching.md)

### Inferences

- No product documents a rule like Adaptive's "infra failure never changes capability tier". In OpenRouter, Requesty, Vercel, and Portkey, model-level fallback fires on rate limits and can silently go to a weaker or stronger model. The response's `model` field is the only signal. Silent cross-tier movement is exactly what Adaptive forbids.
- Same-model cross-provider failover (Anthropic↔Bedrock↔Vertex) is commoditized and done well by hosted players with global health data, which a local proxy cannot replicate. A local proxy can only fail over across providers for which the user holds keys.
- "Fallback to the original preferred model when it recovers" exists implicitly at the provider-share level (OpenRouter restores share automatically; Cloudflare restores unhealthy providers). At the model level each request starts again from the primary, so the preferred model is reclaimed on the next request, not at a "safe boundary". This may switch models mid-session and break caches.

### Gaps

- Whether OpenRouter's or Vercel's model fallback preserves the in-flight stream on mid-stream failure (vs. failing only before first token) wasn't documented in the pages I read.
- Vercel's exact error classes that trigger model fallback weren't captured (the page says "fails or is unavailable").

## Quota / rate-limit awareness, Retry-After handling, waiting for reset

### Takeaway

Hosted routers handle 429s by **moving traffic** (to other providers, keys, or models) and by learning provider capacity statistically. None that I found **parks work and resumes it when a quota window resets**. They are stateless per-request proxies, and waiting is left to the client. Subscription-style quota windows (5-hour/weekly limits) are not modeled at all, because these services sell API capacity.

### Cited Findings

- OpenRouter learns per-provider 429 thresholds, demotes 429-heavy providers, and briefly lowers a provider's share after a 429 burst. — [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection.md)
- With OpenRouter credits, "your rate limits for each provider are managed by OpenRouter". With BYOK you control limits via your provider account. By default, if all BYOK keys hit rate limits, OpenRouter falls back to its shared endpoints (spending credits) unless you set "Never use shared capacity". Multiple keys per provider are tried in priority order. — [OpenRouter BYOK](https://openrouter.ai/docs/guides/overview/auth/byok.md)
- Requesty uses fixed exponential backoff (500ms–4s, jitter) per model, then moves to the next model, and offers "Requesty first, then mine" / "Mine first, then Requesty" key fallback. — [Requesty Fallback Policies](https://docs.requesty.ai/features/fallback-policies.md)
- Vercel: free-tier requests are rate limited per model, and on exceeding a limit "AI Gateway returns a `429` error and you can retry after a short wait" (the client retries). `only`-restricted requests fail if all listed providers are rate limited. — [Vercel AI Gateway Pricing](https://vercel.com/docs/ai-gateway/pricing.md); [Vercel provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.md)
- Portkey can scope fallback to 429 only (`on_status_codes: [429]`). — [Portkey Fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks.md)
- Cloudflare Dynamic Routes enforce gateway-side request/budget quotas per key/period with a fallback branch. — [Cloudflare Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/index.md)
- Copilot Auto factors in "real-time system health and availability". — [GitHub Copilot auto model selection](https://docs.github.com/en/copilot/concepts/auto-model-selection)
- HN commenter context on why aggregators exist: frontier providers "gate new accounts to impractically low rate limits and spending caps", which aggregators work around. — [HN: OpenRouter is joining Stripe](https://news.ycombinator.com/item?id=49364559)

### Inferences

- Durable parking with resume-at-reset, quota/reset-header awareness tied to subscription windows, and half-open single-probe breakers are not offered by any hosted router reviewed. This is white space for a local proxy, especially for users on fixed subscriptions rather than pay-as-you-go credits.
- Hosted routers can "solve" 429s by spending more (shared capacity, other providers). A local proxy restricted to the user's own configured providers cannot, so explicit waiting/parking is the natural complement.

### Gaps

- None of the fetched docs explicitly say whether OpenRouter, Vercel, or Requesty honor upstream `Retry-After` / `anthropic-ratelimit-*-reset` headers internally or pass them through to the client.

## Privacy / data handling, pricing markup, BYOK

### Takeaway

All hosted routers see plaintext prompts. Most offer ZDR/no-logging switches and regional endpoints. Pricing is "no markup on tokens" plus fees elsewhere: OpenRouter charges a credit-purchase fee and 5% on BYOK above a free allowance; Vercel has zero markup including BYOK. Auto-routers add a further data path: prompt content goes to a separate decision model, sometimes a third party's.

### Cited Findings

- OpenRouter: "We pass through the pricing of the underlying providers; there is no markup on inference pricing (however we do charge a fee… when purchasing credits)". The exact fee percentage renders as a template variable in the markdown docs, so I couldn't capture it. — [OpenRouter FAQ](https://openrouter.ai/docs/faq.md)
- OpenRouter BYOK: the fee is "5% of what the same model/provider would cost normally on OpenRouter". Pay-as-you-go includes a \$25,000/month list-price allowance with no BYOK fee. — [OpenRouter BYOK](https://openrouter.ai/docs/guides/overview/auth/byok.md); [OpenRouter FAQ](https://openrouter.ai/docs/faq.md)
- OpenRouter logs metadata only by default ("Prompt and completion are not logged by default"). An opt-in prompt-logging setting gives a 1% discount. Providers that log or train are excluded unless the user opts in. Three endpoint data tiers: ZDR / Safety Retention / Retention and Training. — [OpenRouter FAQ](https://openrouter.ai/docs/faq.md); [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr.md)
- OpenRouter planned update (Oct 27, 2026): it "will screen all inference requests, including ZDR traffic, for child sexual abuse material (CSAM) in flight", and flagged content may be retained. — [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr.md)
- OpenRouter is joining Stripe (announced Aug 19, 2026; reported \$7B+, mostly equity, per HN discussion). — [HN: OpenRouter is joining Stripe](https://news.ycombinator.com/item?id=49364559) → [OpenRouter blog](https://openrouter.ai/blog/announcements/openrouter-is-joining-stripe/)
- Vercel AI Gateway: "charges no markup and no platform fee on tokens… including when you bring your own key." Payment processing fees apply. The free tier covers a subset of models. — [Vercel AI Gateway Pricing](https://vercel.com/docs/ai-gateway/pricing.md)
- Requesty BYOK covers OpenAI, Anthropic, Google AI Studio, Vertex AI, Mistral, and xAI (one key per provider). It has EU/US/AP regional endpoints. Its Auto Routing sends the first user message to the chosen classifier (which may be Typesafe, Cloudflare, Sference, or Azure hosted). — [Requesty BYOK](https://docs.requesty.ai/features/bring-your-own-keys.md); [Requesty llms.txt](https://docs.requesty.ai/llms.txt); [Requesty Auto Routing](https://docs.requesty.ai/features/auto-routing.md)
- Kilo `kilo-auto/free` "may route your requests to providers that log prompts and outputs and use them to improve their services." — [Kilo Gateway Models & Providers](https://kilo.ai/docs/gateway/models-and-providers)
- Not Diamond: "SOC-2 and ISO27001 compliant", TLS, AES-256 at rest. The `/modelSelect` API sees your messages. — [Not Diamond Security](https://docs.notdiamond.ai/docs/privacy-security-and-local-deployments.md); [Not Diamond llms.txt](https://docs.notdiamond.ai/llms.txt)
- Azure model router "honor[s] data zone boundaries". — [Azure model router](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-router)
- Third-party "relay"/shadow-API risk: a CISPA paper (Mar 2026, "Real Money, Fake Models") found 45.83% of 17 audited shadow API platforms failed model-fingerprint verification. A May 2026 investigation alleges some routers inject malware into agent tool calls. This concerns gray-market relays, not OpenRouter. — [Peike Li, "Half the 'AI APIs' You're Buying Are Lying to You"](https://gogoduck912.github.io/blog/middlemen/) (secondary source; the underlying paper wasn't fetched)

### Inferences

- "Everything local, no telemetry, prompts never go to a classifier" is a clear privacy position versus every hosted auto-router.
- Hosted routers' economics (credit fees, BYOK %, acquisition by a payments company) depend on token flow through them. A local proxy has no such incentive and nothing in it can rewrite tool calls.

### Gaps

- The OpenRouter credit-purchase fee percentage couldn't be extracted (the template wasn't rendered). Cloudflare and Kilo pricing/markup weren't fetched.

## Can they use the user's own subscriptions (Claude Max, ChatGPT/Codex, Copilot) or only API keys?

### Takeaway

Effectively **API keys only**. Hosted routers bill via their own credits or BYOK API keys. Anthropic has banned using Pro/Max subscription OAuth outside its own apps, enforced from Jan 2026 and written into its terms in Feb 2026. OpenRouter's "Ori Codex" runs the Codex _harness_ on OpenRouter models, not on a ChatGPT subscription.

### Cited Findings

- Anthropic "says OAuth tokens from Free, Pro, and Max plans are not allowed in non-official products or in the Agent SDK". Enforcement began in Jan 2026, and teams "need API key authentication and must accept usage-based billing". — [WinBuzzer, Feb 19 2026](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/); discussion: [HN "Anthropic blocks third-party use of Claude Code subscriptions"](https://news.ycombinator.com/item?id=46549823)
- A secondary blog dates a further step to April 4, 2026: "Anthropic stopped letting third-party tools run on Claude Pro or Max subscription limits." — [vincentvandeth.nl](https://vincentvandeth.nl/blog/best-openclaw-alternative-cli-subprocess-oauth-ban) (search snippet only, not verified)
- OpenRouter Ori Codex: `ori harness setup codex` routes Codex CLI/Desktop to OpenRouter models. "OpenAI-hosted plugins… need a ChatGPT login and don't work through OpenRouter." — [OpenRouter Ori Codex](https://openrouter.ai/docs/guides/ori/codex.md)
- Requesty BYOK supports only provider API keys (OpenAI, Anthropic, Google, Vertex, Mistral, xAI). — [Requesty BYOK](https://docs.requesty.ai/features/bring-your-own-keys.md)
- Copilot Auto picks only from models in your Copilot plan, and excludes local/BYOK models the user added. — [GitHub Copilot auto model selection](https://docs.github.com/en/copilot/concepts/auto-model-selection)

### Inferences

- A _local_ proxy is the only place where subscription-backed harnesses (Claude Code on Max, Codex on ChatGPT, Copilot) could coexist with API-key providers. But routing subscription OAuth traffic through a third-party proxy likely runs into Anthropic's terms. Adaptive as an OpenCode plugin inherits whatever auth OpenCode's providers use, whereas a standalone proxy re-presenting subscription credentials carries ToS risk. This needs legal/ToS review before productizing.

### Gaps

- I didn't verify the current OpenAI policy on ChatGPT-plan (Codex) OAuth use in third-party proxies, or GitHub's policy on Copilot token use outside official clients.

## Known criticisms

### Takeaway

The main complaints are (1) **provider variance** for the "same" model (quantization, broken tool parsers, ignored params), which hurts agents most; (2) **prompt-cache loss** when routers switch models, which vendors now openly acknowledge and mitigate with stickiness; (3) opaque or changing auto pools; and (4) trust in middlemen.

### Cited Findings

- Same model, different provider: OpenRouter's per-provider board for DeepSeek V4 Flash (2026-09-07) shows first-party at TAU-Bench (tool calling) 81.3% vs DigitalOcean at 58.4%. "Most hosts cluster 5 to 7 points below first-party on tool calling". In July, Fireworks scored 46% on TAU. Some "vision" providers silently ignore images ("pretend everything is 200 OK"), and `reasoning.effort` is accepted but a no-op on some providers. — [Mo Moustafa, "So you want to use OpenRouter?" (Sep 2026)](https://mmoustafa.com/blog/so-you-want-to-use-openrouter/); [HN thread](https://news.ycombinator.com/item?id=49621546)
- HN comments: "Extreme variance in quality and feature support per provider"; "I would not run it in production… Go to the first party provider directly"; a user who blamed their agent until learning provider differences caused "inconsistent… results over the same prompt"; OpenRouter credits expire after a year. One user prefers Requesty because it "let's you pin down providers and build your own routing policy". One user wrote their own gateway after "the most popular one had just had a massive supply chain attack". — [HN: So you want to use OpenRouter?](https://news.ycombinator.com/item?id=49621546)
- A YouTube summary claims OpenRouter's own Auto Exacto numbers showed the default route "failing about 8% of GLM-5 tool calls before March". — [YouTube search result](https://www.youtube.com/watch?v=ZsnFX5mEJ4s) (snippet only, unverified)
- Prompt-cache breakage from switching is acknowledged by the vendors themselves: OpenRouter ("Switching models costs extra while the new model rebuilds the prompt cache"), Cloudflare (without a session ID "Requests in the same conversation may go to different models, so they cannot reuse the prompt cache"), Copilot ("avoid additional cache related costs"). — [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md); [Cloudflare Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/index.md); [GitHub Copilot auto model selection](https://docs.github.com/en/copilot/concepts/auto-model-selection)
- Opaque/changing pools: Kilo "the model it routes to may change over time"; Cloudflare "The pool may change over time"; Azure version updated in place "could affect the overall performance of the model and costs"; Switchyard's default pair changes hourly with spend rankings. — [Kilo Auto Model](https://kilo.ai/docs/code-with-ai/agents/auto-model); [Cloudflare Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/index.md); [Azure model router](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-router); [OpenRouter Switchyard](https://openrouter.ai/docs/guides/routing/routers/switchyard-router.md)
- Auto-router slug pitfalls: on OpenRouter, settings sent under the wrong plugin id "are accepted but silently ignored". — [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router.md)
- Bedrock routing is English-only and can't learn from app-specific data. — [Bedrock prompt routing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html)
- Cross-model tool-call quirks: "Every single model, provider, and agent, has its own weirdness… Tool calls change by model. Effort changes by model". — [HN: OpenRouter is joining Stripe](https://news.ycombinator.com/item?id=49364559). Kilo Gateway advertises "automatic repair for deduplication and orphan cleanup" of tool calls. — [Kilo Gateway](https://kilo.ai/docs/gateway)
- OpenRouter warns that Claude Code through OpenRouter "is only guaranteed to work with the Anthropic first-party provider". — [OpenRouter Claude Code guide](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration.md)

### Inferences

- Adaptive's "compatibility gates before preference" and "only user-configured providers" directly address the provider-variance complaint. Users pick known providers, and the proxy never routes to unknown hosts.
- Restricting model switching to safe boundaries also sidesteps the tool-call-format mismatch that arises when a conversation's tool history was produced by a different model family mid-task.

### Gaps

- I couldn't access Reddit threads (network block), so Reddit criticism of auto-routing (e.g. r/LocalLLM "Model Auto Routing - OpenRouter alternative") is missing.

## Compatibility with coding harnesses (Claude Code, Codex CLI, Cline, Aider, OpenCode)

### Takeaway

Every major hosted gateway now exposes both OpenAI-compatible and Anthropic Messages-compatible endpoints and publishes per-harness guides. Claude Code works via `ANTHROPIC_BASE_URL`, and OpenCode is explicitly supported by Cloudflare (with auto session headers) and Martian. Compatibility is table stakes, not a differentiator.

### Cited Findings

- Requesty: `ANTHROPIC_BASE_URL=https://router.requesty.ai` + `ANTHROPIC_AUTH_TOKEN`. OpenAI base `https://router.requesty.ai/v1`, EU variants, and a `policy/<name>` model id usable as `ANTHROPIC_MODEL`. MCP gateway for Claude Code/Cursor/Roo. — [Requesty llms.txt](https://docs.requesty.ai/llms.txt); [Requesty Auto Routing](https://docs.requesty.ai/features/auto-routing.md)
- OpenRouter: Claude Code guide (recommends pinning Anthropic 1P), Anthropic Messages endpoint `/api/v1/messages` with `fallbacks`, "Ori" harness launcher for Codex CLI/Desktop. — [OpenRouter Claude Code guide](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration.md); [OpenRouter Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md); [OpenRouter Ori Codex](https://openrouter.ai/docs/guides/ori/codex.md)
- Cloudflare AI Gateway has coding-agent guides for Claude Code, Claude Desktop, Cursor, GitHub Copilot CLI, OpenAI Codex, OpenCode, Pi, VS Code, Xcode, Android Studio, and Gemini CLI, plus an "AI Gateway plugin" for OpenCode. Auto Router supports Chat Completions and Responses, not WebSockets. — [Cloudflare Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/index.md)
- Martian Gateway has integration docs for Claude Code Desktop/CLI, Cline, Codex, Cursor, LiteLLM, and OpenCode. — [Martian docs](https://docs.withmartian.com)
- Vercel AI Gateway: Chat Completions, Messages, OpenAI Responses, and OpenResponses formats; coding-agent docs (e.g. Hermes). — [Vercel model fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/model-fallbacks.md); [Vercel provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.md)
- Kilo Gateway: OpenAI-compatible endpoint `https://ai-gateway.kilo.ai/api/v1`, with a mode header for `kilo-auto/frontier`. — [Kilo Gateway](https://kilo.ai/docs/gateway); [Kilo Gateway Models & Providers](https://kilo.ai/docs/gateway/models-and-providers)
- RouteLLM ships a local OpenAI-compatible server. — [RouteLLM README](https://raw.githubusercontent.com/lm-sys/RouteLLM/main/README.md)

### Inferences

- A local Adaptive proxy would need both OpenAI (Chat + Responses) and Anthropic Messages surfaces to match these gateways. The session/turn identification problem the gateways solve with headers (`x-session-id`, `cf-aig-session-id`, `trace_id`) is exactly what a proxy needs to find "safe boundaries". Inside OpenCode, Adaptive gets that natively from the host.
- Outside the plugin, a proxy loses visibility into work-unit boundaries, tool side effects, and subagents. It must infer turns from message history, as Cloudflare does, which weakens guarantees like "never switch mid-unit" and "partial work is durable".

### Gaps

- I didn't verify Aider-specific guides for these gateways, or which harnesses send session identifiers automatically (only Cloudflare's OpenCode claim was confirmed).
