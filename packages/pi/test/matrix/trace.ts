import assert from "node:assert/strict"
import { existsSync, readFileSync, watch } from "node:fs"
import { dirname } from "node:path"

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function traceEvents(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      assert.ok(object(value), "invalid matrix trace entry")
      return value
    })
}

/** Observe actual host completion without sleeps or racing the assistant's streamed text. */
export function waitForTrace(
  path: string,
  predicate: (events: readonly Record<string, unknown>[]) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const observer = watch(dirname(path), () => {
      check()
    })
    const timeout = setTimeout(() => {
      observer.close()
      reject(
        new Error(
          `Host trace did not reach the expected state: ${JSON.stringify(traceEvents(path))}`,
        ),
      )
    }, 15_000)
    function check() {
      try {
        if (!predicate(traceEvents(path))) return
        clearTimeout(timeout)
        observer.close()
        resolve()
      } catch (error) {
        clearTimeout(timeout)
        observer.close()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    check()
  })
}

export function dispatchedModels(path: string): string[] {
  return traceEvents(path)
    .filter((event) => event["kind"] === "dispatch")
    .map((event) => {
      assert.equal(typeof event["model"], "string")
      return String(event["model"])
    })
}
