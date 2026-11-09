// covers: ["ADP-030", "ADP-051", "ADP-059"]
import { isDeepStrictEqual } from "node:util"
import { ReceiptStore, type ReceiptRef } from "@coool/adaptive-core/state/receipts/store"
import { parseReceiptsPayload } from "@coool/adaptive-core/state/receipts/parse"
import type {
  Receipt,
  ReceiptInput,
  ReceiptOutcome,
} from "@coool/adaptive-core/state/receipts/types"
import type { JsonTransactionFile } from "./store.js"

function parse(raw: unknown): readonly Receipt[] {
  if (raw === undefined) return []
  const receipts = parseReceiptsPayload(raw)
  if (!isDeepStrictEqual(raw, { version: 1, receipts }))
    throw new Error("Adaptive receipts: invalid receipts.json payload")
  return receipts
}

async function transaction<R>(
  file: JsonTransactionFile,
  change: (store: ReceiptStore) => Promise<R>,
): Promise<R> {
  return file.transaction(async (current) => {
    const receipts = parse(current)
    let next: unknown
    const store = new ReceiptStore({
      read: () => Promise.resolve({ version: 1, receipts }),
      write: (payload) => {
        next = payload
        return Promise.resolve()
      },
    })
    await store.load()
    return { result: await change(store), next }
  })
}

export function recordReceipt(file: JsonTransactionFile, input: ReceiptInput): Promise<Receipt> {
  return transaction(file, (store) => store.record(input))
}

export function attachReceiptOutcome(
  file: JsonTransactionFile,
  ref: ReceiptRef,
  outcome: ReceiptOutcome,
): Promise<number> {
  return transaction(file, (store) => store.attachOutcome(ref, outcome))
}

/** Shared flow expects newest first; the durable ring remains oldest first. */
export async function readReceipts(file: Pick<JsonTransactionFile, "read">): Promise<Receipt[]> {
  return [...parse(await file.read())].reverse()
}
