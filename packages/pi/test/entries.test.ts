// covers: ["ADP-052", "ADP-058"]
import { expect, it } from "vitest"
import { SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { appendNote, fitLine, NOTE_ENTRY, registerEntries } from "../src/host/entries.js"

it("writes actual custom session entries that the SDK excludes from model context", () => {
  const manager = SessionManager.inMemory()
  appendNote(
    {
      appendEntry: (type, data) => {
        manager.appendCustomEntry(type, data)
      },
    },
    { version: 1, text: "NOTE_NEVER_IN_CONTEXT", receiptID: 1 },
  )
  const entry = manager.getEntries()[0]
  expect(entry).toMatchObject({
    type: "custom",
    customType: NOTE_ENTRY,
    data: { text: "NOTE_NEVER_IN_CONTEXT" },
  })
  if (entry === undefined) throw new Error("missing custom entry")
  expect(sessionEntryToContextMessages(entry)).toEqual([])
})

it("renders dim, sanitized, cell-width-safe notes at 60, 80 and 120 columns", () => {
  let renderer:
    Parameters<Parameters<typeof registerEntries>[0]["registerEntryRenderer"]>[1] | undefined
  registerEntries({
    registerEntryRenderer: (type, render) => {
      expect(type).toBe(NOTE_ENTRY)
      renderer = render
    },
  })
  if (renderer === undefined) throw new Error("renderer missing")
  const manager = SessionManager.inMemory()
  const id = manager.appendCustomEntry(NOTE_ENTRY, {
    version: 1,
    text: `\u001b[31m界é${" long".repeat(50)}`,
    receiptID: 1,
  })
  const entry = manager.getEntry(id)
  if (entry?.type !== "custom") throw new Error("entry missing")
  const theme = { fg: (_color: string, text: string) => text }
  const options = { expanded: false }
  for (const width of [60, 80, 120]) {
    const component = renderer(entry, options, theme)
    expect(component?.render(width).every((line) => visibleWidth(line) <= width)).toBe(true)
    component?.invalidate()
  }
  expect(
    renderer({ data: { version: 1, text: "ok", receiptID: 4 } }, { expanded: true }, theme)?.render(
      80,
    )[0],
  ).toContain("receipt #4")
  expect(
    renderer({ data: { version: 1, text: "ok" } }, { expanded: true }, theme)?.render(80)[0],
  ).not.toContain("receipt #")
  for (const data of [null, { version: 2, text: "bad" }, { version: 1, text: 4 }])
    expect(renderer({ data }, options, theme)).toBeUndefined()
  expect(fitLine("abc", 0)).toBe("")
  expect(fitLine("x\ny", 80)).toBe("x y")
})
