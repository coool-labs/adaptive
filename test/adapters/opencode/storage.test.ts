import { describe, expect, it } from "vitest"
import { storageSeam } from "../../../src/adapters/opencode/storage.js"
import { FakeStorage } from "./helpers.js"

describe("storageSeam", () => {
  it("reads through to the bound key", async () => {
    const fake = new FakeStorage()
    fake.data.set("coool.adaptive/settings", { version: 1 })
    const seam = storageSeam("coool.adaptive/settings", fake.source)
    await expect(seam.read()).resolves.toEqual({ version: 1 })
  })

  it("returns undefined for absent keys", async () => {
    const seam = storageSeam("coool.adaptive/settings", new FakeStorage().source)
    await expect(seam.read()).resolves.toBeUndefined()
  })

  it("writes through to the bound key", async () => {
    const fake = new FakeStorage()
    const seam = storageSeam("coool.adaptive/receipts", fake.source)
    await seam.write({ version: 1, receipts: [] })
    expect(fake.writes).toEqual(["coool.adaptive/receipts"])
    await expect(seam.read()).resolves.toEqual({ version: 1, receipts: [] })
  })

  it("keys are independent between seams", async () => {
    const fake = new FakeStorage()
    const settings = storageSeam("coool.adaptive/settings", fake.source)
    const parked = storageSeam("coool.adaptive/parked", fake.source)
    await settings.write({ a: 1 })
    await parked.write({ b: 2 })
    await expect(settings.read()).resolves.toEqual({ a: 1 })
    await expect(parked.read()).resolves.toEqual({ b: 2 })
  })
})
