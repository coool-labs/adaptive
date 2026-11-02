export interface FakeProviderBehavior {
  status?: number
  headers?: Record<string, string>
  body?: string
  contentType?: string
  sse?: string[]
  sseEnd?: "done" | "close"
  chunkDelayMs?: number
  delayMs?: number
  disconnect?: boolean
}

export interface FakeProviderScript {
  behaviors: [FakeProviderBehavior, ...FakeProviderBehavior[]]
}

export const FAKE_MODEL_ID = "fake-model"

export interface FakeModelDescriptor {
  id: string
  object: "model"
  created: number
  owned_by: string
}

export const FAKE_MODELS: FakeModelDescriptor[] = [
  { id: FAKE_MODEL_ID, object: "model", created: 1_700_000_000, owned_by: "fake" },
]

export const RECOVERY_AFTER_FAILURES = 2
export const RETRY_AFTER_SECONDS = "5"
export const TIMEOUT_DELAY_MS = 5_000
export const STREAM_CHUNK_DELAY_MS = 10

const errorBody = (message: string): string =>
  JSON.stringify({ error: { message, type: "fake_error", code: null } })

const completionBody = (model: string, content: string): string =>
  JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

const toolCallBody = (model: string): string =>
  JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fake",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"paris"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

const sseData = (payload: Record<string, unknown>): string => JSON.stringify(payload)

const chunkShape = (model: string, delta: Record<string, unknown>, finish: string | null): string =>
  sseData({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

export const sseContentChunk = (model: string, text: string): string =>
  chunkShape(model, { content: text }, null)

export const sseToolCallChunk = (model: string, name: string): string =>
  chunkShape(
    model,
    {
      tool_calls: [
        { index: 0, id: "call_fake", type: "function", function: { name, arguments: "" } },
      ],
    },
    null,
  )

export const sseToolArgsChunk = (model: string, args: string): string =>
  chunkShape(model, { tool_calls: [{ index: 0, function: { arguments: args } }] }, null)

export const sseFinishChunk = (model: string, reason: string): string =>
  chunkShape(model, {}, reason)

export const FAKE_SCENARIO_NAMES = [
  "success",
  "streaming",
  "tool-calls",
  "streaming-tool-calls",
  "partial-execution",
  "rate-limited",
  "quota-exhausted",
  "outage",
  "timeout",
  "disconnect",
  "malformed",
  "context-rejection",
  "recovery-after-n",
] as const

export type FakeScenarioName = (typeof FAKE_SCENARIO_NAMES)[number]

const rateLimitBehavior = (retryAfter: string): FakeProviderBehavior => ({
  status: 429,
  headers: { "retry-after": retryAfter },
  body: errorBody("rate limit exceeded, retry later"),
})

const successBehavior = (): FakeProviderBehavior => ({
  // Codex-shaped subscription telemetry (ADP-020 wire format): the TUI
  // capacity journey reads these through the plugin's passive header sensor,
  // so the success response carries a used percent and a 15-minute reset.
  headers: {
    "x-codex-primary-used-percent": "72",
    "x-codex-primary-reset-after-seconds": "900",
  },
  body: completionBody(FAKE_MODEL_ID, "done"),
})

export const FAKE_SCENARIOS: Record<FakeScenarioName, FakeProviderScript> = {
  success: { behaviors: [successBehavior()] },
  streaming: {
    behaviors: [
      {
        sse: [
          sseContentChunk(FAKE_MODEL_ID, "Hello"),
          sseContentChunk(FAKE_MODEL_ID, " world"),
          sseFinishChunk(FAKE_MODEL_ID, "stop"),
        ],
        sseEnd: "done",
        chunkDelayMs: STREAM_CHUNK_DELAY_MS,
      },
    ],
  },
  "tool-calls": { behaviors: [{ body: toolCallBody(FAKE_MODEL_ID) }] },
  "streaming-tool-calls": {
    behaviors: [
      {
        sse: [
          sseToolCallChunk(FAKE_MODEL_ID, "get_weather"),
          sseToolArgsChunk(FAKE_MODEL_ID, '{"city":"paris"}'),
          sseFinishChunk(FAKE_MODEL_ID, "tool_calls"),
        ],
        sseEnd: "done",
        chunkDelayMs: STREAM_CHUNK_DELAY_MS,
      },
    ],
  },
  "partial-execution": {
    behaviors: [
      {
        sse: [sseContentChunk(FAKE_MODEL_ID, "partial answer so far")],
        sseEnd: "close",
        chunkDelayMs: STREAM_CHUNK_DELAY_MS,
      },
    ],
  },
  "rate-limited": { behaviors: [rateLimitBehavior(RETRY_AFTER_SECONDS)] },
  "quota-exhausted": {
    behaviors: [
      {
        status: 429,
        headers: {
          "retry-after": "60",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-reset-requests": "1m",
          "x-ratelimit-reset-tokens": "1m",
        },
        body: errorBody("quota exceeded for this billing period"),
      },
    ],
  },
  outage: { behaviors: [{ status: 503, body: errorBody("service temporarily unavailable") }] },
  timeout: { behaviors: [{ delayMs: TIMEOUT_DELAY_MS, body: successBehavior().body ?? "" }] },
  disconnect: { behaviors: [{ disconnect: true }] },
  malformed: { behaviors: [{ body: "<not json>" }] },
  "context-rejection": {
    behaviors: [
      {
        status: 400,
        body: errorBody(
          "This model's maximum context length is 4096 tokens, but the prompt is 5000 tokens",
        ),
      },
    ],
  },
  "recovery-after-n": {
    behaviors: [rateLimitBehavior("1"), rateLimitBehavior("1"), successBehavior()],
  },
}
