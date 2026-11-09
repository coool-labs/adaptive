import type { ImageContent } from "@earendil-works/pi-ai"
import { MAX_WAKES, PARK_ENTRY, type Parked } from "../parking.js"
import { parseTaskState, type TaskState } from "../task.js"
import type { RouteContext } from "./routing.js"

export interface ParkedInput {
  readonly text: string
  readonly images?: ImageContent[]
}
export interface ParkPayload {
  readonly token: string
  readonly state: TaskState
  readonly input?: ParkedInput
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined
}

/** Only the host session, not the global parked index, holds user input. */
export function parkedPayload(ctx: RouteContext, token: string): ParkPayload | undefined {
  const data = ctx.sessionManager
    .getBranch()
    .findLast(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === PARK_ENTRY &&
        field(entry.data, "token") === token,
    )?.data
  if (data === undefined) return undefined
  const state = parseTaskState(field(data, "state"))
  if (state === undefined) throw new Error("Adaptive parked: state missing")
  const input = field(data, "input")
  if (input === undefined) return { token, state }
  const text = field(input, "text")
  if (typeof text !== "string") throw new Error("Adaptive parked: input.text must be a string")
  const images = field(input, "images")
  if (images === undefined) return { token, state, input: { text } }
  if (!Array.isArray(images)) throw new Error("Adaptive parked: input.images must be an array")
  const parsed: ImageContent[] = images.map((image: unknown) => {
    const data = field(image, "data")
    const mimeType = field(image, "mimeType")
    if (
      field(image, "type") !== "image" ||
      typeof data !== "string" ||
      typeof mimeType !== "string"
    )
      throw new Error("Adaptive parked: input.images entry must be an image")
    return { type: "image", data, mimeType }
  })
  return { token, state, input: { text, images: parsed } }
}

export function clearParked(ctx: RouteContext): void {
  ctx.ui?.setStatus("adaptive", undefined)
  ctx.ui?.setWidget("adaptive", undefined)
  ctx.ui?.setWorkingMessage()
}

export function showParked(ctx: RouteContext, record: Parked): void {
  if (!ctx.hasUI) return
  const when = new Date(record.due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const resume =
    record.wakes >= MAX_WAKES
      ? "Automatic wake limit reached. Send a new message or pick a model."
      : `Resumes ${when}. Send a new message or pick a model to cancel.`
  ctx.ui?.setStatus(
    "adaptive",
    `⏸ ${record.tier} parked · ${record.wakes >= MAX_WAKES ? "needs your input" : `resumes ${when}`}`,
  )
  ctx.ui?.setWidget("adaptive", [`⏸ Parked: no available ${record.tier} model`, resume])
}
