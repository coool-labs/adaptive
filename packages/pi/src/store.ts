// covers: ["ADP-059"]
/**
 * Shared JSON state for every Pi process on the machine. Pi has no global
 * store and runs subagents as child processes, so health and parking live in
 * files under the agent directory. Each update holds an exclusive lock file
 * across read → change → write and replaces the file atomically, so two
 * processes never interleave a read-modify-write or observe a torn file.
 *
 * Corrupt or unreadable state throws and is never rewritten: callers fail
 * open (route without the state) and leave the file for the user to inspect.
 */
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

// A lock older than this belongs to a crashed process: every holder finishes
// a read-modify-write of a small file in milliseconds.
const STALE_LOCK_MS = 10_000
// Waiting longer than this for a live holder fails the update (fail-open).
const LOCK_TIMEOUT_MS = 1_000
const LOCK_RETRY_MS = 10

export interface JsonFile {
  /** Current value, or `undefined` when the file does not exist. */
  read(): Promise<unknown>
  /**
   * Applies `change` under the lock. A `next` of `undefined` leaves the
   * file untouched (read-only decisions still serialize with writers).
   */
  update<R>(
    change: (current: unknown) => { readonly next: unknown; readonly result: R },
  ): Promise<R>
}

function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), "code")
}

async function parse(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined
    }
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    throw new Error(`Adaptive state: ${path} is not valid JSON`)
  }
}

async function acquire(lock: string, clock: () => number): Promise<void> {
  const deadline = clock() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(lock, "wx")
      await handle.writeFile(String(process.pid))
      await handle.close()
      return
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error
      }
    }
    // The holder usually released between `open` and `stat`; any failure to
    // inspect the lock just means "try again until the deadline".
    const held = await stat(lock).catch(() => undefined)
    if (held !== undefined && clock() - held.mtimeMs > STALE_LOCK_MS) {
      await rm(lock, { force: true })
      continue
    }
    if (clock() >= deadline) {
      throw new Error(`Adaptive state: ${lock} is held by another Pi process`)
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
  }
}

export function jsonFile(path: string, clock: () => number = Date.now): JsonFile {
  const lock = `${path}.lock`
  return {
    read: () => parse(path),
    async update(change) {
      await mkdir(dirname(path), { recursive: true })
      await acquire(lock, clock)
      try {
        const { next, result } = change(await parse(path))
        if (next !== undefined) {
          const temporary = `${path}.${randomUUID()}.tmp`
          await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
          await rename(temporary, path)
        }
        return result
      } finally {
        await rm(lock, { force: true })
      }
    },
  }
}
