// covers: ["ADP-059"]
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import type * as FsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const failures = vi.hoisted((): { stat: Error | undefined } => ({ stat: undefined }))

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>()
  return {
    ...actual,
    stat: (path: string) =>
      failures.stat === undefined ? actual.stat(path) : Promise.reject(failures.stat),
  }
})

const { jsonFile } = await import("../src/store.js")

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "adaptive-store-"))
})

afterEach(async () => {
  failures.stat = undefined
  await chmod(directory, 0o700)
  await rm(directory, { recursive: true, force: true })
})

function counter(current: unknown): number {
  return typeof current === "number" ? current : 0
}

function coded(code: string): Error {
  return Object.assign(new Error(code), { code })
}

it("reads a missing file as undefined and creates it on the first update", async () => {
  const file = jsonFile(join(directory, "nested", "health.json"))
  await expect(file.read()).resolves.toBeUndefined()
  await expect(
    file.update((current) => ({ next: counter(current) + 1, result: "written" })),
  ).resolves.toBe("written")
  await expect(file.read()).resolves.toBe(1)
  expect(await readdir(join(directory, "nested"))).toEqual(["health.json"])
})

it("serializes concurrent read-modify-write updates without losing any", async () => {
  const file = jsonFile(join(directory, "health.json"))
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      file.update((current) => {
        const next = counter(current) + 1
        return { next, result: next }
      }),
    ),
  )
  expect(await file.read()).toBe(25)
  expect([...results].sort((left, right) => left - right)).toEqual(
    Array.from({ length: 25 }, (_, index) => index + 1),
  )
})

it("leaves the file untouched when a change has nothing to write", async () => {
  const path = join(directory, "health.json")
  await writeFile(path, '{"kept":true}\n')
  const file = jsonFile(path)
  await expect(file.update((current) => ({ next: undefined, result: current }))).resolves.toEqual({
    kept: true,
  })
  expect(await readFile(path, "utf8")).toBe('{"kept":true}\n')
})

it("never rewrites corrupt state and names the file", async () => {
  const path = join(directory, "health.json")
  await writeFile(path, "{not json")
  const file = jsonFile(path)
  await expect(file.read()).rejects.toThrow(`Adaptive state: ${path} is not valid JSON`)
  await expect(file.update(() => ({ next: 1, result: undefined }))).rejects.toThrow(
    "is not valid JSON",
  )
  expect(await readFile(path, "utf8")).toBe("{not json")
  expect(await readdir(directory)).toEqual(["health.json"])
})

it("propagates unreadable state", async () => {
  const path = join(directory, "health.json")
  await mkdir(path)
  await expect(jsonFile(path).read()).rejects.toMatchObject({ code: "EISDIR" })
})

it("reclaims a lock left behind by a crashed process", async () => {
  const path = join(directory, "health.json")
  await writeFile(`${path}.lock`, "999999")
  const old = new Date(Date.now() - 60_000)
  await utimes(`${path}.lock`, old, old)
  await expect(jsonFile(path).update(() => ({ next: 7, result: "ok" }))).resolves.toBe("ok")
  expect(await readdir(directory)).toEqual(["health.json"])
})

it("gives up on a live holder after the lock timeout", async () => {
  const path = join(directory, "health.json")
  await writeFile(`${path}.lock`, "1")
  let now = Date.now()
  const clock = () => {
    now += 400
    return now - 400
  }
  await expect(
    jsonFile(path, clock).update(() => ({ next: 1, result: undefined })),
  ).rejects.toThrow(`Adaptive state: ${path}.lock is held by another Pi process`)
  expect(await readFile(`${path}.lock`, "utf8")).toBe("1")
})

it("keeps waiting while the holder's lock cannot be inspected", async () => {
  const path = join(directory, "health.json")
  await writeFile(`${path}.lock`, "1")
  failures.stat = coded("ENOENT")
  let now = Date.now()
  const clock = () => {
    now += 400
    return now - 400
  }
  await expect(
    jsonFile(path, clock).update(() => ({ next: 1, result: undefined })),
  ).rejects.toThrow("is held by another Pi process")
})

it("propagates lock failures other than contention", async () => {
  await chmod(directory, 0o500)
  await expect(
    jsonFile(join(directory, "health.json")).update(() => ({ next: 1, result: undefined })),
  ).rejects.toMatchObject({ code: "EACCES" })
})
