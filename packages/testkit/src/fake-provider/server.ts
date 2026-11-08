import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { FAKE_MODELS, type FakeProviderBehavior, type FakeProviderScript } from "./scenarios.js"

export interface CapturedCall {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
  at: number
}

export interface FakeProvider {
  url: string
  calls: readonly CapturedCall[]
  requestCount(): number
  setScript(next: FakeProviderScript): void
  /** Installs per-model behavior queues (model-keyed scenario control). */
  setModelScripts(next: Record<string, FakeProviderScript>): void
  close(): Promise<void>
}

export interface FakeProviderOptions {
  host?: string
  /** Fixed port; 0 (default) picks a free one. The sidecar entry point needs a fixed port. */
  port?: number
}

const sleep = (ms: number, timers: Set<NodeJS.Timeout>): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      resolve()
    }, ms)
    timers.add(timer)
  })

const modelsBody = (models: unknown): string => JSON.stringify({ object: "list", data: models })

const behaviorAt = (script: FakeProviderScript, index: number): FakeProviderBehavior =>
  script.behaviors.reduce((selected, behavior, position) =>
    position <= index ? behavior : selected,
  )

/** The requested model id from a chat-completions request body, if parseable. */
const bodyModel = (body: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null && "model" in parsed) {
      const model = (parsed as Record<string, unknown>)["model"]
      if (typeof model === "string") return model
    }
  } catch {
    // unparseable bodies have no model
  }
  return undefined
}

const wantsStream = (body: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(body)
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { stream?: unknown }).stream === true
    )
  } catch {
    return false
  }
}

// The AI SDK (used by @ai-sdk/openai-compatible providers) requests streaming
// completions; a non-streaming JSON body parsed as a stream reports
// "OpenAI Chat stream ended without finish_reason". Synthesize the chunk form
// the SDK expects from a plain completion body so JSON scenarios work against
// the real host too.
const streamPayloads = (body: string): string[] => {
  let completion: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === "object" && parsed !== null)
      completion = parsed as Record<string, unknown>
  } catch {
    // unparseable bodies fall through as an empty completion
  }
  const choices = Array.isArray(completion["choices"]) ? (completion["choices"] as unknown[]) : []
  const first =
    typeof choices[0] === "object" && choices[0] !== null
      ? (choices[0] as Record<string, unknown>)
      : {}
  const message =
    typeof first["message"] === "object" && first["message"] !== null
      ? (first["message"] as Record<string, unknown>)
      : {}
  const finish = typeof first["finish_reason"] === "string" ? first["finish_reason"] : "stop"
  const chunk = (delta: Record<string, unknown>, reason: string | null): string =>
    JSON.stringify({
      id: typeof completion["id"] === "string" ? completion["id"] : "cmpl-fake",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: reason }],
    })
  const payloads: string[] = []
  const role = typeof message["role"] === "string" ? message["role"] : "assistant"
  if (typeof message["content"] === "string" && message["content"].length > 0) {
    payloads.push(chunk({ role, content: message["content"] }, null))
  }
  if (Array.isArray(message["tool_calls"])) {
    payloads.push(chunk({ tool_calls: message["tool_calls"] }, null))
  }
  payloads.push(chunk({}, finish))
  return payloads
}

export async function createFakeProvider(
  initialScript: FakeProviderScript,
  options?: FakeProviderOptions,
): Promise<FakeProvider> {
  let script = initialScript
  // Per-model behavior queues: a request whose body names a model with an
  // entry here consumes THAT queue instead of the global script. Model-aware
  // scenarios (escalation, failover to a different resource) need different
  // answers per model, which one sequential script cannot express.
  let modelScripts = new Map<string, FakeProviderScript>()
  const modelIndexes = new Map<string, number>()
  const calls: CapturedCall[] = []
  const timers = new Set<NodeJS.Timeout>()
  const sockets = new Set<Socket>()
  let behaviorIndex = 0

  const nextBehavior = (model: string | undefined): FakeProviderBehavior => {
    const queue = model === undefined || model === "" ? undefined : modelScripts.get(model)
    if (queue !== undefined) {
      const index = modelIndexes.get(String(model)) ?? 0
      const behavior = behaviorAt(queue, index)
      modelIndexes.set(String(model), index + 1)
      return behavior
    }
    const behavior = behaviorAt(script, behaviorIndex)
    behaviorIndex += 1
    return behavior
  }

  const setScript = (next: FakeProviderScript): void => {
    script = next
    behaviorIndex = 0
  }

  /** Installs per-model queues and resets every per-model cursor. */
  const setModelScripts = (next: Record<string, FakeProviderScript>): void => {
    modelScripts = new Map(Object.entries(next))
    modelIndexes.clear()
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The connection-level handler below already registers each socket in
    // `sockets` and removes it once; adding another `once("close")` here per
    // request piles listeners onto the same keep-alive socket and eventually
    // trips MaxListenersExceededWarning in long test files.

    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString("utf8")

    calls.push({
      method: String(request.method),
      path: String(request.url),
      headers: request.headers,
      body,
      at: Date.now(),
    })

    if (request.method === "GET" && String(request.url).endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(modelsBody(FAKE_MODELS))
      return
    }

    if (request.method !== "POST" || !String(request.url).endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "not found" } }))
      return
    }

    const behavior = nextBehavior(bodyModel(body))

    if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
      await sleep(behavior.delayMs, timers)
    }

    if (behavior.disconnect === true) {
      response.socket?.destroy()
      return
    }

    if (behavior.sse !== undefined) {
      response.writeHead(behavior.status ?? 200, {
        "content-type": "text/event-stream",
        ...behavior.headers,
      })
      for (const payload of behavior.sse) {
        response.write(`data: ${payload}\n\n`)
        if (behavior.chunkDelayMs !== undefined && behavior.chunkDelayMs > 0) {
          await sleep(behavior.chunkDelayMs, timers)
        }
      }
      if (behavior.sseEnd === "close") {
        response.socket?.destroy()
        return
      }
      response.write("data: [DONE]\n\n")
      response.end()
      return
    }

    const status = behavior.status ?? 200
    const success = status >= 200 && status <= 299
    if (wantsStream(body) && success) {
      response.writeHead(status, {
        "content-type": "text/event-stream",
        ...behavior.headers,
      })
      for (const payload of streamPayloads(behavior.body ?? "")) {
        response.write(`data: ${payload}\n\n`)
        if (behavior.chunkDelayMs !== undefined && behavior.chunkDelayMs > 0) {
          await sleep(behavior.chunkDelayMs, timers)
        }
      }
      response.write("data: [DONE]\n\n")
      response.end()
      return
    }

    response.writeHead(behavior.status ?? 200, {
      "content-type": behavior.contentType ?? "application/json",
      ...behavior.headers,
    })
    response.end(behavior.body ?? "")
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.destroy()
    })
  })

  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => {
      sockets.delete(socket)
    })
  })

  const host = options?.host ?? "127.0.0.1"
  await new Promise<void>((resolve) => {
    server.listen(options?.port ?? 0, host, () => {
      resolve()
    })
  })

  // listen(port, host) above creates a TCP server, never a Unix-domain socket;
  // its completed listening callback guarantees a non-null AddressInfo.
  const { port } = server.address() as AddressInfo

  return {
    url: `http://${host}:${String(port)}`,
    calls,
    requestCount: () => calls.length,
    setScript,
    setModelScripts,
    close: async () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
      for (const socket of sockets) {
        socket.destroy()
      }
      sockets.clear()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
