// covers: ["ADP-030", "ADP-051", "ADP-059"]
import { expect, it } from "vitest"
import { recordReceipt, readReceipts, attachReceiptOutcome } from "../src/receipts.js"
import { memoryFile } from "./support/memory-file.js"

const input = {
  sessionID: "s",
  unitID: "u",
  at: 100,
  tier: "standard" as const,
  decision: { kind: "defer" as const, reason: "routing-defer" as const },
}

it("keeps a shared bounded ring, assigns monotonic ids and reads newest first", async () => {
  const file = memoryFile()
  expect(await readReceipts(file)).toEqual([])
  await Promise.all(Array.from({ length: 205 }, () => recordReceipt(file, input)))
  const receipts = await readReceipts(file)
  expect(receipts).toHaveLength(200)
  expect(receipts[0]?.id).toBe(205)
  expect(receipts.at(-1)?.id).toBe(6)
  expect(
    (
      await recordReceipt(file, {
        ...input,
        decision: { kind: "defer", reason: "routing-defer", detail: "x".repeat(300) },
      })
    ).decision,
  ).toMatchObject({ detail: "x".repeat(128) })
})

it("attaches only the first outcome of a matching unit", async () => {
  const file = memoryFile()
  await recordReceipt(file, input)
  expect(
    await attachReceiptOutcome(file, { sessionID: "s", unitID: "u" }, { status: "succeeded" }),
  ).toBe(1)
  const before = file.value()
  expect(
    await attachReceiptOutcome(
      file,
      { sessionID: "s", unitID: "u" },
      { status: "failed", category: "unknown" },
    ),
  ).toBe(0)
  expect(file.value()).toBe(before)
  expect((await readReceipts(file))[0]?.outcome).toEqual({ status: "succeeded" })
})

it("never repairs or overwrites malformed or newer receipt payloads", async () => {
  for (const raw of [
    null,
    [],
    { version: 2, receipts: [] },
    { version: 1, receipts: [null] },
    { version: 1, receipts: [], secret: true },
  ]) {
    const file = memoryFile(raw)
    await expect(recordReceipt(file, input)).rejects.toThrow("Adaptive receipts")
    await expect(readReceipts(file)).rejects.toThrow("Adaptive receipts")
    expect(file.value()).toBe(raw)
  }
  await expect(recordReceipt(memoryFile(), { ...input, sessionID: " " })).rejects.toThrow(
    "sessionID",
  )
})
