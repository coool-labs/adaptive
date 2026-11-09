import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { jsonFile } from "../src/store.js"

it("awaits asynchronous work under the lock and releases it after rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adaptive-transaction-"))
  try {
    const file = jsonFile(join(directory, "state.json"))
    await expect(
      file.transaction(async () => {
        await Promise.resolve()
        throw new Error("transaction failed")
      }),
    ).rejects.toThrow("transaction failed")
    expect(await readdir(directory)).toEqual([])
    await expect(
      file.transaction(async (current) => {
        await Promise.resolve()
        expect(current).toBeUndefined()
        return { next: 7, result: "saved" }
      }),
    ).resolves.toBe("saved")
    expect(await file.read()).toBe(7)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
