import { afterEach, describe, expect, it } from "vitest"
import { createFakeProvider, type FakeProvider } from "./server.js"
import {
  FAKE_MODEL_ID,
  FAKE_SCENARIO_NAMES,
  FAKE_SCENARIOS,
  RECOVERY_AFTER_FAILURES,
  RETRY_AFTER_SECONDS,
  STREAM_CHUNK_DELAY_MS,
  TIMEOUT_DELAY_MS,
  sseContentChunk,
  sseToolCallChunk,
  type FakeScenarioName,
} from "./scenarios.js"

const CHAT_PATH = "/v1/chat/completions"

const started: FakeProvider[] = []

afterEach(async () => {
  while (started.length > 0) {
    const provider = started.pop()
    if (provider !== undefined) {
      await provider.close()
    }
  }
})

const start = async (name: FakeScenarioName): Promise<FakeProvider> => {
  const provider = await createFakeProvider(FAKE_SCENARIOS[name])
  started.push(provider)
  return provider
}

const post = async (
  url: string,
  init?: { signal?: AbortSignal; body?: string },
): Promise<Response> => {
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body:
      init?.body ??
      JSON.stringify({ model: FAKE_MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
  }
  if (init?.signal !== undefined) {
    requestInit.signal = init.signal
  }
  const response = await fetch(`${url}${CHAT_PATH}`, requestInit)
  return response
}

const readStreamText = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return ""
  }
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    try {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      text += decoder.decode(value)
    } catch {
      break
    }
  }
  return text
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

describe("fake provider scenarios", () => {
  it("pins the scenario vocabulary and script shape", () => {
    expect(FAKE_SCENARIO_NAMES).toHaveLength(13)
    expect(Object.keys(FAKE_SCENARIOS).sort()).toEqual([...FAKE_SCENARIO_NAMES].sort())
    for (const name of FAKE_SCENARIO_NAMES) {
      expect(FAKE_SCENARIOS[name].behaviors.length).toBeGreaterThan(0)
    }
    expect(RECOVERY_AFTER_FAILURES).toBe(2)
    expect(RETRY_AFTER_SECONDS).toBe("5")
    expect(STREAM_CHUNK_DELAY_MS).toBe(10)
    expect(TIMEOUT_DELAY_MS).toBe(5_000)
  })

  it("serves a model list and rejects unknown routes", async () => {
    const provider = await start("success")
    const models = await fetch(`${provider.url}/v1/models`)
    expect(models.status).toBe(200)
    const payload = (await models.json()) as { object: string; data: { id: string }[] }
    expect(payload.object).toBe("list")
    expect(payload.data.some((model) => model.id === FAKE_MODEL_ID)).toBe(true)

    const missing = await fetch(`${provider.url}/v1/other`)
    expect(missing.status).toBe(404)
  })

  it("scenario success: returns a completion for the requested model", async () => {
    const provider = await start("success")
    const response = await post(provider.url)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      model: string
      choices: { message: { role: string; content: string }; finish_reason: string }[]
    }
    expect(payload.model).toBe(FAKE_MODEL_ID)
    expect(payload.choices[0]?.message).toEqual({ role: "assistant", content: "done" })
    expect(payload.choices[0]?.finish_reason).toBe("stop")

    const call = provider.calls[provider.calls.length - 1]
    expect(call?.path).toBe(CHAT_PATH)
    expect(call?.method).toBe("POST")
    const request = JSON.parse(call?.body ?? "{}") as { model: string }
    expect(request.model).toBe(FAKE_MODEL_ID)
  })

  it("scenario streaming: sends SSE chunks and a DONE terminator", async () => {
    const provider = await start("streaming")
    const response = await post(provider.url)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const text = await response.text()
    expect(text).toContain(`data: ${sseContentChunk(FAKE_MODEL_ID, "Hello")}`)
    expect(text).toContain(`data: ${sseContentChunk(FAKE_MODEL_ID, " world")}`)
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  it("scenario tool-calls: returns a function tool call", async () => {
    const provider = await start("tool-calls")
    const response = await post(provider.url)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      choices: {
        message: { tool_calls: { function: { name: string; arguments: string } }[] }
        finish_reason: string
      }[]
    }
    expect(payload.choices[0]?.finish_reason).toBe("tool_calls")
    expect(payload.choices[0]?.message.tool_calls[0]?.function).toEqual({
      name: "get_weather",
      arguments: '{"city":"paris"}',
    })
  })

  it("scenario streaming-tool-calls: streams tool call deltas", async () => {
    const provider = await start("streaming-tool-calls")
    const response = await post(provider.url)
    const text = await response.text()
    expect(text).toContain(`data: ${sseToolCallChunk(FAKE_MODEL_ID, "get_weather")}`)
    expect(text).toContain('"arguments":"{\\"city\\":\\"paris\\"}"')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  })

  it("scenario partial-execution: stream ends mid-answer without DONE", async () => {
    const provider = await start("partial-execution")
    const response = await post(provider.url)
    const text = await readStreamText(response)
    expect(text).toContain("partial answer so far")
    expect(text.includes("data: [DONE]")).toBe(false)
    expect(provider.requestCount()).toBe(1)
  })

  it("scenario rate-limited: 429 with Retry-After", async () => {
    const provider = await start("rate-limited")
    const response = await post(provider.url)
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe(RETRY_AFTER_SECONDS)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain("rate limit")
  })

  it("scenario quota-exhausted: 429 with zero remaining quota headers", async () => {
    const provider = await start("quota-exhausted")
    const response = await post(provider.url)
    expect(response.status).toBe(429)
    expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("0")
    expect(response.headers.get("x-ratelimit-remaining-tokens")).toBe("0")
    expect(response.headers.get("x-ratelimit-reset-requests")).toBe("1m")
    expect(response.headers.get("retry-after")).toBe("60")
  })

  it("scenario outage: 503", async () => {
    const provider = await start("outage")
    const response = await post(provider.url)
    expect(response.status).toBe(503)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain("unavailable")
  })

  it("scenario timeout: delays beyond any client patience", async () => {
    const provider = await start("timeout")
    const controller = new AbortController()
    const abort = setTimeout(() => {
      controller.abort()
    }, 150)
    let failure: unknown
    try {
      await post(provider.url, { signal: controller.signal })
    } catch (error) {
      failure = error
    }
    clearTimeout(abort)
    expect(failure).toBeDefined()
    expect(provider.requestCount()).toBe(1)
  })

  it("scenario disconnect: closes the connection without a response", async () => {
    const provider = await start("disconnect")
    let failure: unknown
    try {
      await post(provider.url)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(errorText(failure).length).toBeGreaterThan(0)
    expect(provider.requestCount()).toBe(1)
  })

  it("scenario malformed: 200 with an unparseable body", async () => {
    const provider = await start("malformed")
    const response = await post(provider.url)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toBe("<not json>")
    expect(() => {
      JSON.parse(text)
    }).toThrow()
  })

  it("scenario context-rejection: 400 with a context-length message", async () => {
    const provider = await start("context-rejection")
    const response = await post(provider.url)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain("maximum context length")
  })

  it("scenario recovery-after-n: fails twice then succeeds", async () => {
    const provider = await start("recovery-after-n")
    const first = await post(provider.url)
    expect(first.status).toBe(429)
    const second = await post(provider.url)
    expect(second.status).toBe(429)
    const third = await post(provider.url)
    expect(third.status).toBe(200)
    const payload = (await third.json()) as { choices: { message: { content: string } }[] }
    expect(payload.choices[0]?.message.content).toBe("done")
    expect(provider.requestCount()).toBe(RECOVERY_AFTER_FAILURES + 1)
  })

  it("repeats the last behavior once the script is exhausted", async () => {
    const provider = await start("rate-limited")
    await post(provider.url)
    const second = await post(provider.url)
    const third = await post(provider.url)
    expect(second.status).toBe(429)
    expect(third.status).toBe(429)
    expect(provider.requestCount()).toBe(3)
  })

  it("captures request headers in lower-case", async () => {
    const provider = await start("success")
    await fetch(`${provider.url}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-marker": "yes" },
      body: JSON.stringify({ model: FAKE_MODEL_ID, messages: [] }),
    })
    const call = provider.calls[provider.calls.length - 1]
    expect(call?.headers["x-fake-marker"]).toBe("yes")
  })
})
