# Feasibility and limits of an execution supervisor as a local HTTP proxy vs. an in-harness plugin (as of Nov 2026)

Scope note: research was capped at about 18 tool calls. Claude Code is covered in depth because Anthropic now publishes a gateway protocol spec for it. Codex CLI, Gemini CLI, Cursor, Cline, Aider and OpenCode are covered thinly, and the gaps are listed under each question. Dates are given where a fact may have changed.

---

## 1. What a proxy can see at the HTTP request level, and whether it can detect work-unit boundaries

### Takeaway

For **Claude Code**, a proxy now gets almost all the work-unit signals that opencode-adaptive uses. Session ID, subagent ID, parent agent ID, request class (`main`, `subagent`, `workflow`, `compaction`, `auxiliary`), agent type, and a per-user-prompt ID all come as documented headers. The hint headers are **off by default behind a custom base URL** and need `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. For the other harnesses, no comparable published header contract turned up. There a proxy has to infer boundaries from the request body: the last message is new user text (a new turn) or a `tool_result` (a continuation). That is a structural heuristic, not a contract.

### Cited Findings

- Claude Code sends `x-claude-code-session-id` on API requests, "a unique identifier for the current Claude Code session. Use it to aggregate all requests from one session without parsing request bodies." — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- The header was added in v2.1.86 (about March 2026). It is a locally generated UUID, and users asked for an opt-out on privacy grounds. — [anthropics/claude-code#40431](https://github.com/anthropics/claude-code/issues/40431)
- `x-claude-code-agent-id` identifies the subagent that issued a request and is "present only on requests from an agent Claude Code spawned inside the session". `x-claude-code-parent-agent-id` is present for nested agents. Subagent IDs are generated fresh each time a subagent is spawned. Teammate agents reuse a stable name-based ID. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- "Gateway hint headers" (v2.1.273+) are sent by default on a direct Anthropic connection. Behind a **custom base URL they are off by default** "because a proxy that rejects unknown headers would fail the request", and need `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`. They are:
  - `x-claude-code-request-class`: `main`, `subagent`, `workflow`, `compaction`, or `auxiliary` (titles, classifiers, summaries).
  - `x-claude-code-agent-type`: `Explore`, `Plan`, `general-purpose`, `custom`, `teammate`, or `fork`.
  - `x-claude-code-compaction` and `x-claude-code-context-compacted`.
  - `x-claude-code-prev-tool-durations`: "the first request of a new prompt never carry it".
  - `x-claude-code-prompt-id`: a "Random UUID that identifies the user prompt a request serves. Requests serving one prompt share the value, including the turns of subagents that prompt started" (v2.1.283+).

  — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)

- Model aliases: `ANTHROPIC_DEFAULT_HAIKU_MODEL` sets what the `haiku` alias resolves to "also used for background functionality". `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL` set the other aliases, and `opusplan` uses Opus in Plan Mode. `CLAUDE_CODE_SUBAGENT_MODEL` sets the subagent default. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- Behind an `ANTHROPIC_BASE_URL` gateway, background tasks use "the main model, or the default Haiku model when `ANTHROPIC_API_KEY` or `apiKeyHelper` supplies an Anthropic Console key". So the model name alone is not a reliable background vs. main signal behind a gateway. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Claude Code prepends a system-prompt "attribution block" with the client version and a conversation fingerprint. It has been stable per conversation on custom base URLs since v2.1.181. Before that it carried a per-request token. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- In the Anthropic Messages API, "A tool-use loop is one assistant turn": `[thinking]+[tool_use]` → user `[tool_result]` → assistant text is a single turn. This is the structural basis for telling a continuation (the last user message holds `tool_result` blocks) from a new turn. — [Anthropic: Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- Some people already route all Claude Code traffic through a local proxy for per-session cost visibility (anecdotal Reddit report, snippet only). — [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/comments/1sb8fb3/i_routed_all_my_claude_code_traffic_through_a/)
- Teams that needed session IDs for MCP traffic, not model traffic, injected their own header with a proxy. Claude Code sends no session ID to MCP servers. — [anthropics/claude-code#41836](https://github.com/anthropics/claude-code/issues/41836)

### Inferences

- With hint headers on, a proxy can key a "work unit" on (`session-id`, `agent-id` or main, `prompt-id`). Under the default Anthropic-side preserved-thinking rules, a model switch is safe only when `prompt-id` changes (a new user prompt) or when a new `agent-id` appears (a new subagent). This roughly matches opencode-adaptive's safe-boundary definition. It also depends on the user opting in to a Claude Code env var, which an installer can set in `~/.claude/settings.json` under `env`.
- `request-class=compaction|auxiliary` maps directly onto a "quick tier" decision a proxy could make deterministically.
- The proxy **cannot see**:
  - the user's manual `/model` intent as distinct from config (it only sees the model string on each request);
  - user cancellation (to the proxy, a cancel is just a closed client socket, indistinguishable from a client-side timeout);
  - the explicit escalation tool, unless it's exposed as an MCP tool that the proxy also serves;
  - the harness's own retry state.
- For non-Claude-Code harnesses the boundary heuristic is: last user message contains only `tool_result` / `function_call_output` → continuation; otherwise → new turn. Subagent detection would need body fingerprinting (different system prompt or tool set), which is fragile.

### Gaps

- No primary documentation found for request headers or session identifiers sent by **Codex CLI, Gemini CLI, Cursor, Cline, Aider, or OpenCode**, or for their user-agent strings. The research budget didn't cover them. Treat them as unknown; check by capturing traffic.
- Cursor routes model traffic through its own backend for most features. Whether a local base-URL override sees agent traffic at all was not verified.
- Whether `metadata.user_id` is still sent in the Claude Code body (older versions encoded a session in it) was not re-verified for 2026 builds.

---

## 2. Switching models mid-conversation at the proxy: caching, thinking signatures, tool IDs, format translation

### Takeaway

A mid-episode switch is the most dangerous thing a proxy can do.

- **Thinking blocks are signed and model/conversation-bound.** Within a tool-use turn they must be returned unmodified. Real routers have shipped "Invalid signature in thinking block" bugs and fixed them by hard-pinning the model while signed thinking is in history.
- Changing the thinking configuration (or the model) invalidates the prompt cache.
- Gemini 3 needs `thought_signature` on function-call parts, which breaks naive translation.

A proxy therefore needs hard model affinity per conversation and work unit. That is the same rule opencode-adaptive already enforces, but here the proxy has to reconstruct it from bodies and headers.

### Cited Findings

- Each thinking block has a `signature` field, "an encrypted copy of the full reasoning that you pass back unchanged in multi-turn and tool-use conversations". With `display: "omitted"` (the default on Claude 5-family models) the `thinking` text is empty and only the signature carries the reasoning. — [Anthropic: Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- "Required: within a tool-use turn, pass thinking blocks back." "Within the latest assistant message, the sequence of consecutive thinking blocks must match what the model generated… you can't rearrange, edit, or partially drop them." — [Anthropic: Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- "You can't toggle thinking in the middle of a turn, including during the tool-use loop." When a mid-turn toggle happens, the API silently disables thinking for that request and may strip thinking blocks. "Toggling thinking modes also invalidates prompt caching." — [Anthropic: Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- Changing `budget_tokens` (or effort, in adaptive mode) invalidates cache breakpoints, because the value is rendered into the prompt. The doc shows a measured cache miss after a budget change. — [Anthropic: Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- A "preserved thinking" check rejects requests with "bound to a different conversation" when `system`, `tools`, or earlier `messages` differ from the request that produced the thinking. "A gateway that rewrites any of that content can cause the rejection itself." — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- **Claude Code partially self-heals.** When the upstream rejects a thinking signature, Claude Code "removes earlier thinking blocks from the request, retries, and keeps them out of every later request". Much of its other recovery matches on upstream error wording, so gateways must forward error bodies unmodified. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- UncommonRoute (an auto-routing proxy, April–May 2026): switching models between turns under Claude Code caused `400 … Invalid signature in thinking block`. A first fix used "affinity as a score" and still failed. The final fix "hard-lock[s] the route pool to the previous successful model for that session". If that model is unavailable, routing "fails closed with an `anthropic-thinking-model-affinity` constraint". — [CommonstackAI/UncommonRoute#20](https://github.com/CommonstackAI/UncommonRoute/issues/20)
- CLIProxyAPI: switching from Gemini CLI to a real Claude model fails because history contains "fake-signed thinking blocks" synthesized during translation. — [router-for-me/CLIProxyAPI#1584](https://github.com/router-for-me/CLIProxyAPI/issues/1584) (search snippet)
- Gemini 3 needs a `thought_signature` on function-call parts. When Claude Code sends a tool call through claude-code-router, the translation lacks it. — [trapdoor.cloud on CCR](https://trapdoor.cloud/using-alternate-models-with-claude-code-via-claude-code-router/) (search snippet). A Google forum thread reports "Thought signature is not valid" errors in multi-turn tool calling through OpenRouter, and the user's workaround was falling back to Claude. — [Google AI dev forum](https://discuss.ai.google.dev/t/gemini-3-thought-signature-is-not-valid-cant-do-multi-turn-tool-calling/119360)
- Another aggregator's FAQ (Sept 2026) advises: "start a new conversation, and use one model and one key per conversation". — [APIYI docs](https://docs.apiyi.com/en/live/2026-09/claude-thinking-signature-invalid) (search snippet)
- Gateways must forward `cache_control` unchanged and must not convert block-form `system` or message content into strings. Otherwise "the conversation bills as uncached input on every turn". — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Anthropic ITPM rate limits count only uncached input tokens (`cache_read_input_tokens` don't count). Losing the cache on a switch therefore costs money and also eats rate-limit headroom. — [Anthropic: Rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- Behind an `ANTHROPIC_BASE_URL` gateway, Claude Code sends the full Anthropic beta and field set (`context_management`, `output_config`, adaptive thinking, mid-conversation `role:"system"` messages, beta tool fields). Forwarding those to Bedrock or Vertex or other upstreams produces `400 Extra inputs are not permitted` and similar errors. Anthropic tells gateways to forward `anthropic-*` headers and body fields "as open lists" rather than allowlisting them. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)

### Inferences

- Model switches are safe only at points where no signed reasoning from the old model must be replayed, which means the start of a new user turn. Even there, Claude 4.6+/5.x keep prior-turn thinking in context, so a cross-model switch at a turn boundary still sends foreign signatures. The proxy would have to strip prior thinking blocks; that's allowed outside tool use, per "Allowed: outside tool use, omit prior turns' thinking". Claude Code's own fallback does exactly this.
- Cross-provider switches (Anthropic ↔ OpenAI ↔ Gemini) need full format translation:
  - tool-call ID formats (`toolu_…` vs `call_…`);
  - reasoning artifacts (Anthropic signatures, OpenAI encrypted reasoning items, Gemini thought signatures);
  - system-message placement, `cache_control`, and beta-paired fields.

  Each is a known source of bugs. A same-provider, same-format failover (for example Anthropic direct → Bedrock or Vertex Claude, or another Anthropic key) is much safer than cross-provider failover.

- Every switch resets the prompt cache, so a proxy should treat "switch" as a costly event and switch only at safe boundaries. This matches opencode-adaptive's "never mid-unit" invariant.

### Gaps

- OpenAI Responses API encrypted reasoning items (`reasoning.encrypted_content`) were not fetched. Whether they can be replayed across OpenAI models or accounts was not verified from primary docs in this session.
- No primary LiteLLM issue was fetched on Anthropic↔OpenAI translation bugs. Translation evidence here comes from UncommonRoute, CLIProxyAPI, and CCR reports.

---

## 3. Mid-stream failures: can a proxy retry transparently after SSE starts?

### Takeaway

Not transparently, once content bytes have reached the client. A proxy can't un-send partial tokens, and splicing a second model's stream onto the first produces invalid event sequences (indexes, signatures). The practical patterns are:

- retry freely **before the first byte**, or before the first content block if you buffer `message_start`;
- after that, fail the stream so the harness's own retry re-issues the request.

Claude Code explicitly treats a stream that ends without the final `message_delta` as a dropped connection and retries.

### Cited Findings

- Claude Code reads streams event by event. A gateway that buffers whole responses makes Claude Code stall. Claude Code "expects each response's full event sequence, in order, through the final `message_delta` and `message_stop` events. If the body ends cleanly after a content block has started but before that final `message_delta`, Claude Code treats the response as a dropped connection" and may retry automatically. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Upstream SSE `ping` events may be the only bytes during long thinking. A gateway that strips or buffers them can trip Claude Code's streaming idle timeout. Translating gateways must emit their own pings. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1` "disable[s] the non-streaming fallback when a streaming request fails mid-stream… Useful when a proxy or gateway causes the fallback to produce duplicate tool execution." This is direct evidence that proxy-induced mid-stream retries can duplicate side effects. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- Claude Code stream watchdogs:
  - `CLAUDE_STREAM_IDLE_TIMEOUT_MS`: minimum 5 minutes when set; byte watchdog capped at 30 minutes.
  - `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`.
  - `API_TIMEOUT_MS`: default 10 minutes to receive response headers.
  - `API_FORCE_IDLE_TIMEOUT`: 5-minute body idle timeout on non-Anthropic providers.

  — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)

- Thinking signatures arrive as a single `signature_delta` just before `content_block_stop`. A partially streamed thinking block therefore has no valid signature to replay. — [Anthropic: Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)

### Inferences

- A "commit point" strategy works. The proxy holds back the response until the upstream's first content event (or until HTTP status and headers arrive). During that window it can transparently fail over to another endpoint **of the same model**. After the commit, an upstream error should end the stream without `message_delta`, so the harness retries the whole request. That is safe because tools run only after the harness has a complete assistant message.
- Holding back (or keeping alive with synthetic pings) also lets the proxy wait out short 429s without the client seeing an error.
- Never re-route a retried request to a different model during a tool-use turn (see Q2).

### Gaps

- Codex CLI and Gemini CLI mid-stream reconnect semantics weren't checked. Codex has a separate `stream_max_retries`; see Q4.
- No published "resumable stream" API from Anthropic or OpenAI for SSE turned up in this session.

---

## 4. Parking and resume: what a proxy can do without re-invoking the harness

### Takeaway

A proxy can't wake a harness. It can only (a) hold the HTTP request open, (b) answer with an error the harness will retry later, or (c) answer with a terminal error. With Claude Code, holding requests or returning `retry-after` works only up to tight limits **unless the user enables `CLAUDE_CODE_RETRY_WATCHDOG`**. Without the watchdog, a `retry-after` above 60 seconds makes Claude Code show the error at once. Durable parking of a whole session plus a later "wake" therefore needs a harness-side component (hook or plugin); opencode-adaptive gets that from `session.wait`, synthetic messages, and similar host APIs.

### Cited Findings

- Claude Code reads `retry-after` and "waits at least that long before the next automatic retry, and **outside `CLAUDE_CODE_RETRY_WATCHDOG` sessions a value above 60 stops the retries and shows the error at once**". Gateways should return integer seconds, not HTTP dates. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Claude Code also honors `x-should-retry: true|false`. It reads `anthropic-ratelimit-unified-*` to tell a plan limit or spend cap from a temporary throttle and to show usage. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- `CLAUDE_CODE_MAX_RETRIES` defaults to 10 and has been capped at 15 since v2.1.186. It "can stop earlier on 529 overloaded errors", for example "with an API key on an Opus model, it stops at the third 529". A configured `fallbackModel` makes Claude Code switch models itself rather than error. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- `CLAUDE_CODE_RETRY_WATCHDOG=1` (v2.1.186+):
  - "Retries 429 and 529 capacity errors indefinitely".
  - "backs off up to 5 minutes between attempts, or until the limit resets when the response carries a rate-limit reset time, so a session that hits a usage limit waits out the remaining window".
  - Raises other transient retries to 300 (about 3 hours).
  - "fails at once when a standard-speed request gets a 429 that reports a spend limit or exhausted usage credits".

  `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` caps the wait. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)

- Anthropic's spend-cap 429 has **no `retry-after`** and carries `error.details.error_code: "enforced_spend_limit_reached"`. Its message gives the reset time (00:00 UTC on the 1st of the month). A user-set spend limit returns **HTTP 400** `invalid_request_error`. — [Anthropic: Rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- Anthropic rate limiting is a token bucket. Response headers include `retry-after` and `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (reset in RFC 3339), plus Priority Tier variants. — [Anthropic: Rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- Codex CLI defaults: `request_max_retries` 4 (HTTP) and `stream_max_retries` 5 (streaming), as provider fields. — [Alex Dunlop: Codex config.toml](https://www.alexdunlop.com/writing/codex-cli-config-toml) (secondary). `request_max_retries` "cannot be overridden for the built-in model provider `openai`… by design"; it's honored for custom providers. — [openai/codex#3026](https://github.com/openai/codex/issues/3026) (search snippet). Pointing the built-in provider at a proxy uses `openai_base_url`. — [Morph: Codex config.toml](https://www.morphllm.com/codex-provider-configuration) (search snippet)
- OpenAI's ChatGPT-plan help page: "Signing in again or repeatedly retrying does not restore your usage", and an error "does not automatically move the request to another paid option". — [OpenAI Help: Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)

### Inferences

- **Holding the request open** works only for waits shorter than the harness's header or first-byte timeouts. For Claude Code that is `API_TIMEOUT_MS`, default 10 minutes, which the user can raise. Synthetic SSE pings can keep a held _streaming_ response alive past idle watchdogs only after headers are sent. Holding for hours (a quota reset) is fragile: laptop sleep, client restarts, and the 30-minute byte-watchdog cap all break it.
- **Returning 429 + `retry-after` ≤ 60s repeatedly** gives at most about 10–15 attempts × 60 s with Claude Code's default settings. That's roughly 10–15 minutes, not hours. To park for hours, the installer must set `CLAUDE_CODE_RETRY_WATCHDOG=1`. The proxy should also emit a real reset time (`anthropic-ratelimit-unified-*` or `retry-after`) so Claude Code sleeps until then. Don't emit a spend-limit-shaped error, which Claude Code treats as terminal.
- Neither holding nor 429-looping is "durable": if the harness exits, the work is lost from the proxy's view. Durable parking with later resume from session state needs the harness to persist the session (Claude Code `--resume`, OpenCode sessions) and something harness-side to re-trigger it. A proxy alone can't do this.
- Codex's lower retry counts (4 + 5), and the fact that the built-in `openai` provider's retries can't be overridden, make proxy-side parking even weaker there. Defining a custom provider is required.

### Gaps

- Gemini CLI, Cline, Aider, Cursor and OpenCode client retry and timeout limits were not researched.
- Codex's handling of `retry-after` values was not verified from primary source.

---

## 5. Subscription credentials through a third-party proxy (ToS and enforcement, 2025–2026)

### Takeaway

- **Anthropic:** routing Claude Free, Pro or Max OAuth tokens through anything other than Claude Code or Claude.ai is explicitly prohibited (Feb 2026 terms clarification) and technically enforced (Jan 2026 anti-spoofing; April 4, 2026 cut-off for third-party harnesses). OpenCode removed Claude Pro/Max support after "anthropic legal requests".
  - Grey zone: a proxy that sits behind **genuine Claude Code** and forwards its own OAuth traffic unchanged is not a different harness. Anthropic's docs even note that `ANTHROPIC_BASE_URL` plus a claude.ai login is possible. But any proxy that _rewrites_ or _re-routes_ that traffic, or reuses the token for another client, is in prohibited territory.
- **OpenAI:** openly permissive. Staff publicly endorsed Codex subscriptions in third-party harnesses, and OpenAI now runs a formal "Sign in with ChatGPT" program with per-app usage caps for partners and supported open-source tools.
- Copilot and Gemini subscriptions were not verified.

### Cited Findings

- Anthropic's updated legal compliance page (Feb 2026): "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service." The underlying Consumer Terms §3.7 has barred unendorsed automated access "since at least February 2024". — [The Register, 20 Feb 2026](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)
- In January 2026, Anthropic engineer Thariq Shihipar said the company had taken steps to prevent third-party tools from "spoofing the Claude Code harness", citing "unusual traffic patterns without any of the usual telemetry". — [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)
- OpenCode pushed a commit removing support for Claude Pro/Max account keys, citing "anthropic legal requests". — [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)
- OpenAI's Thibault Sottiaux "pointedly endorsed the use of Codex subscriptions in third-party harnesses". — [The Register](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access)
- Enforcement timeline (secondary blog, citing The Verge, TNW and OpenClaw docs):
  - Jan 9, 2026: an initial block, partly reversed.
  - Feb 2026: terms revision.
  - **April 4, 2026, 12:00 PT**: Claude Pro/Max subscription access blocked for third-party agentic tools (OpenClaw, OpenCode), with "extra usage" pay-as-you-go offered as the alternative.
  - Anthropic's stated rationale: third-party harnesses bypass Claude Code's prompt-cache optimizations.

  — [dev.to (McRolly Nwangwu), Apr 2026](https://dev.to/mcrolly/anthropic-kills-claude-subscription-access-for-third-party-tools-like-openclaw-what-it-means-for-3ipc); related HN discussion: [HN 46549823](https://news.ycombinator.com/item?id=46549823)

- Ars Technica commenters summarize that Anthropic "did not ban custom harnesses outright", but stopped most from drawing on Pro/Max limits. A YouTube snippet mentions "programmatic credits", a monthly allowance for the Agent SDK, `claude -p` and third-party tools. — [Ars Technica forum](https://arstechnica.com/civis/threads/claude-code%E2%80%99s-product-lead-talks-usage-limits-transparency-and-the-%E2%80%9Clean-harness%E2%80%9D.1513047/); [YouTube](https://www.youtube.com/watch?v=Fl6QT86n1P4) (snippet only, unverified)
- The Claude Code gateway doc acknowledges that a claude.ai login is possible when `ANTHROPIC_BASE_URL` is set without a gateway credential. The `anthropic-beta` header then carries an OAuth capability, and stripping it causes 401s. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Setting `ANTHROPIC_BASE_URL` to a non-`api.anthropic.com` host disables Claude Code Remote Control (v2.1.196+). — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- OpenAI "Sign in with ChatGPT":
  - Go, Plus and Pro users can let participating apps draw on their "ChatGPT Work and Codex usage", with per-app weekly caps.
  - "Supported open-source tools remain available to all ChatGPT users".
  - Commercial partners apply via a form; open-source developers have developer docs.

  — [OpenAI Help](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)

- Earlier community posts asked about Codex OAuth client-ID practice for integrations such as Roo Code. — [OpenAI community](https://community.openai.com/t/best-practice-for-clientid-when-using-codex-oauth/1371778) (snippet)

### Inferences

- **Recommended stance for a proxy product:**
  - Support API keys and cloud providers (Bedrock, Vertex, Foundry) as the default.
  - For Claude subscriptions, at most pass traffic from genuine Claude Code through **unmodified to the same Anthropic endpoint**: no rerouting, rewriting, or token extraction. Anthropic detects spoofing by telemetry and traffic patterns, and the proxy would be the obvious thing that alters them.
  - For ChatGPT plans, integrate through the official "Sign in with ChatGPT" program rather than lifting Codex CLI tokens.
- For opencode-adaptive's own ecosystem: OpenCode removed Claude subscription support, so the subscription question for that plugin mainly concerns OpenAI, Copilot, and others.

### Gaps

- No primary source was fetched for **GitHub Copilot** (using Copilot tokens outside sanctioned clients) or **Google Gemini / Antigravity** subscription terms.
- The exact current text of Anthropic's legal compliance page and the "programmatic credits" details were not fetched directly.

---

## 6. Running as an OS service (launchd, systemd, Windows service), auth, multi-harness concurrency

### Takeaway

Little direct primary evidence turned up in this session. The relevant hard facts come from harness docs: Claude Code reads `ANTHROPIC_BASE_URL` and headers from `settings.json` `env`, applies changes to running sessions, supports mTLS client certificates, and warns that gateways must not redirect `/v1/models`. Service packaging precedents (LiteLLM, claude-code-router) exist, but their service-mode details weren't verified.

### Cited Findings

- `settings.json` `env` values are applied by Claude Code "no matter how `claude` was launched", and "A running session applies new and changed values… when you save the file". An installer can therefore point Claude Code at a local proxy, and at `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` / `CLAUDE_CODE_RETRY_WATCHDOG=1`, with one file write. Project and local settings cannot set some variables. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- Claude Code supports `ANTHROPIC_AUTH_TOKEN` (Bearer), `ANTHROPIC_CUSTOM_HEADERS`, `apiKeyHelper` (with `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`), and mTLS via `CLAUDE_CODE_CLIENT_CERT` / `CLAUDE_CODE_CLIENT_KEY`. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- Startup traffic includes a `HEAD /api/hello` warm-up probe, which can be rejected. Model discovery `GET /v1/models?limit=1000` has a 3-second timeout and treats any redirect, even http→https, as failure. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Some features bypass the gateway and call `api.anthropic.com` directly: the fast-mode availability check and the WebFetch domain safety check. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Anthropic ships its own self-hosted "Claude apps gateway" with a `GET /protocol` endpoint reference. This is a first-party precedent for a local or org gateway. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)

### Inferences

- **localhost TLS:**
  - Plain `http://127.0.0.1` is enough. Every harness checked accepts an http base URL.
  - Serve directly on the configured base path with no redirects.
  - Require a per-install bearer token so other local processes or browsers can't use the proxy's upstream credentials (DNS-rebinding and CSRF-style risks for localhost services).
- **Multi-harness concurrency:** the proxy must keep per-session affinity state (Q2) across many concurrent harness sessions. Shared circuit breakers and quota state are an advantage over per-harness plugins.

### Gaps

- No verified examples of LLM proxies shipped as launchd, systemd or Windows services, and no documentation for LiteLLM or claude-code-router service modes, were fetched.
- Windows-specific issues (service account vs. user-profile credential stores, firewall prompts) were not researched.

---

## 7. Hybrid architectures: a proxy core plus thin per-harness plugins or hooks for boundary signals

### Takeaway

Claude Code already supplies the boundary signals through its documented gateway headers. A hybrid only needs an installer that sets env vars, plus optionally hooks for things the proxy can't see: manual model changes, cancellation, an escalation tool, and session wake. For OpenCode, the existing plugin keeps the host-only capabilities: `session.wait`, `switchModel`, synthetic resume, and the retry-hook veto. The best design is probably a shared core (scheduler, health, quota) used by both a proxy front-end and per-harness adapters, not a proxy that replaces the plugin.

### Cited Findings

- The Claude Code gateway contract is versioned and open-ended: "Treat the headers and body fields as open lists… Claude Code gains capabilities over releases." Gateways should test against new releases. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- Claude Code has its own model-fallback machinery (`fallbackModel`, "fallback model chains", automatic fallback on refusal flags) that runs client-side. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- `CLAUDE_CODE_BRIDGE_SESSION_ID` and `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` are exposed to hook and subprocess environments, so hooks can correlate with session state. — [Claude Code env vars](https://code.claude.com/docs/en/env-vars)
- UncommonRoute's experience shows a pure proxy must "fail closed" when the pinned model is unavailable, because it can't move the harness to a safe boundary itself. — [UncommonRoute#20](https://github.com/CommonstackAI/UncommonRoute/issues/20)

### Inferences

- **What only a plugin or hook can do:**
  - Detect and respect **manual** model changes (the proxy can't tell a `/model` change from a config default).
  - Distinguish **user cancellation** from a network drop.
  - Expose an **escalation tool** (possible from the proxy via MCP, but tool-call attribution to a session needs a session header).
  - **Wake** a parked session.
  - Switch the harness's model so its own UI and state stay consistent. A proxy that silently rewrites `model` leaves the harness showing a model it isn't using, and harness features keyed on model ID (context window, adaptive thinking, effort) can mis-fire.
- **What a proxy does better:**
  - Cross-harness shared health and quota.
  - One install across many tools.
  - Same-model endpoint failover before the first byte.
  - Header-based quota tracking.

### Gaps

- No specific precedent found of a product shipping "proxy core + Claude Code hooks + Codex profile + OpenCode plugin" together. Hooks event names were not re-verified in this session.

---

## 8. Emerging standards that help

### Takeaway

The most useful "standard" for a proxy is the de facto header set: `retry-after` in integer seconds, `x-should-retry`, `anthropic-ratelimit-*` / `anthropic-ratelimit-unified-*`, and Claude Code's `x-claude-code-*` hints. Anthropic has published a gateway protocol and a `capability_rejected:` error-token convention, which makes a Claude Code proxy much more tractable than a year earlier. Nothing comparable was verified for other harnesses. Agent Client Protocol and MCP were not researched in depth.

### Cited Findings

- Anthropic rate-limit headers: `retry-after`; `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` (RFC 3339); Priority Tier headers; `anthropic-workspace-id`. Not every 429 carries `retry-after`, and the spend-cap 429 never does. Fast mode has `anthropic-fast-*` headers. — [Anthropic: Rate limits](https://platform.claude.com/docs/en/api/rate-limits)
- Claude Code consumes `anthropic-ratelimit-unified-*` (plan limits), `x-should-retry`, and `retry-after`. Gateways that wrap errors should include a stable `capability_rejected:` token (for example `capability_rejected: prompt_too_long`, or `capability_rejected: beta_header:<value>`) so client recovery still works. — [Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol.md)
- 529 "overloaded" is distinct from quota. Claude Code's error reference says it "is not your usage limit". — [Developers Digest summary of Claude Code error reference](https://www.developersdigest.tech/blog/claude-code-retry-watchdog-unattended-runs) (secondary snippet)

### Inferences

- A proxy can classify upstream failures well for Anthropic:
  - `rate_limit_error` with `retry-after` → transient throttle.
  - `enforced_spend_limit_reached` → quota exhausted until a known reset.
  - 529 → capacity.
  - 400 `invalid_request_error` "specified API usage limits" → a user-set cap.

  This maps directly onto opencode-adaptive's "capability vs. availability" separation.

### Gaps

- OpenAI `x-ratelimit-reset-*` header semantics and Gemini quota error shapes were not fetched.
- Agent Client Protocol (ACP) and MCP were not researched in this session. Whether ACP exposes turn, session or cancel boundaries that a supervisor could subscribe to is an open question.
