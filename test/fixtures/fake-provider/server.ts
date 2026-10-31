import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { Socket } from "node:net"
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
  close(): Promise<void>
}

export interface FakeProviderOptions {
  host?: string
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

export async function createFakeProvider(
  script: FakeProviderScript,
  options?: FakeProviderOptions,
): Promise<FakeProvider> {
  const calls: CapturedCall[] = []
  const timers = new Set<NodeJS.Timeout>()
  const sockets = new Set<Socket>()
  let behaviorIndex = 0

  const nextBehavior = (): FakeProviderBehavior => {
    const behavior = script.behaviors[Math.min(behaviorIndex, script.behaviors.length - 1)]
    behaviorIndex += 1
    if (behavior === undefined) {
      throw new Error("fake provider script is empty")
    }
    return behavior
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const socket = response.socket
    if (socket !== null) {
      sockets.add(socket)
      socket.once("close", () => {
        sockets.delete(socket)
      })
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks).toString("utf8")

    calls.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body,
      at: Date.now(),
    })

    if (request.method === "GET" && (request.url ?? "").endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(modelsBody(FAKE_MODELS))
      return
    }

    if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "not found" } }))
      return
    }

    const behavior = nextBehavior()

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
    server.listen(0, host, () => {
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0

  return {
    url: `http://${host}:${String(port)}`,
    calls,
    requestCount: () => calls.length,
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
