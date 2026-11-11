// covers: ["ADP-062"]
import { expect, it } from "vitest"
import { visibleWidth } from "@earendil-works/pi-tui"
import { picker, piView } from "../src/host/view.js"

it("supports search, arrows, empty matches, cancellation and separate page actions", () => {
  const results: unknown[] = []
  let renders = 0
  const component = picker(
    "Choose",
    [
      { title: "Alpha", value: 1, description: "界" },
      { title: "Beta", value: 2 },
    ],
    [{ title: "Next", value: "next", bind: "ctrl+f" }],
    10,
    (result) => results.push(result),
    () => {
      renders += 1
    },
  )
  expect(component.render(80)).toContain("  Beta")
  component.handleInput("\u001b[B")
  expect(component.render(60).some((line) => line.startsWith("> Beta"))).toBe(true)
  component.handleInput("\u001b[A")
  component.handleInput("\u001b[A")
  component.handleInput("\r")
  expect(results.pop()).toEqual({ picked: 1, action: undefined })
  component.handleInput("z")
  expect(component.render(60)).toContain("No matches")
  component.handleInput("\u001b[B")
  component.handleInput("\r")
  expect(results.pop()).toEqual({ picked: undefined, action: undefined })
  component.handleInput("\u007f")
  component.handleInput("bet")
  component.handleInput("\r")
  expect(results.pop()).toEqual({ picked: 2, action: undefined })
  component.handleInput("\u0006")
  expect(results.pop()).toEqual({ picked: undefined, action: "next" })
  component.handleInput("\u001b")
  expect(results.pop()).toEqual({ picked: undefined, action: undefined })
  component.handleInput("\u0000")
  component.invalidate()
  expect(renders).toBeGreaterThan(0)
  for (const width of [60, 80, 120])
    expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true)
})

function host(mode: string, inputs: string[][] = [], rows = 8) {
  const notices: string[] = []
  const selections: string[][] = []
  const rendered: string[][] = []
  const answers: (string | undefined)[] = []
  const searches: (string | undefined)[] = []
  let refreshes = 0
  const ctx: Parameters<typeof piView>[0] = {
    mode,
    ui: {
      select: (_title, options) => {
        selections.push(options)
        return Promise.resolve(answers.shift())
      },
      input: () => Promise.resolve(searches.shift()),
      confirm: () => Promise.resolve(true),
      notify: (message) => notices.push(message),
      custom: (factory) =>
        new Promise((resolve) => {
          const component = factory(
            {
              terminal: { rows },
              requestRender: () => {
                refreshes += 1
              },
            },
            undefined,
            undefined,
            resolve,
          )
          for (const input of inputs.shift() ?? ["\u001b"]) component.handleInput(input)
          for (const width of [60, 80, 120]) {
            const lines = component.render(width)
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true)
            rendered.push(lines)
          }
          component.invalidate()
        }),
    },
  }
  return { ctx, notices, selections, rendered, answers, searches, refreshes: () => refreshes }
}

it("adapts all shared view operations to TUI components at actual terminal widths", async () => {
  const fake = host("tui", [
    ["\u001b[B", "\r"],
    ["\u0006"],
    ["\u001b[B", "\u001b[A", "x", "\r"],
    ["\u001b"],
  ])
  const view = piView(fake.ctx)
  expect(await view.select({ title: "Pick", options: [{ title: "A", value: 7 }] })).toBe(7)
  expect(
    await view.selectPaged({
      title: "Receipts",
      options: [],
      actions: [{ title: "Next", value: "next", bind: "ctrl+f" }],
    }),
  ).toEqual({ picked: undefined, action: "next" })
  expect(await view.confirm({ title: "Confirm", message: "yes?" })).toBe(true)
  await view.alert({ title: "Detail", message: "界".repeat(100) })
  await view.table({
    title: "Table",
    lines: ["first", "second", "third", "fourth", "fifth", "sixth"],
  })
  view.toast("Saved", "success")
  view.toast("Failed", "error")
  expect(fake.notices).toEqual(["Saved", "Failed"])
  expect(fake.refreshes()).toBeGreaterThan(0)
  await view.table({
    title: "Status",
    lines: ["界".repeat(150)],
    compactLines: ["model", "standard · quota_exhausted", "used 82%", "resets 18:42"],
  })
  expect(fake.rendered.some((lines) => lines.includes("used 82%"))).toBe(true)
  const welcome = picker(
    "Adaptive\nquick: one\nstandard: two\nadvanced: three",
    [],
    [],
    24,
    () => undefined,
    () => undefined,
  )
  expect(welcome.render(60)).toContain("standard: two")
})

it("treats a custom surface the host cannot draw as a dismissed dialog", async () => {
  const fake = host("tui")
  const view = piView({
    ...fake.ctx,
    ui: { ...fake.ctx.ui, custom: () => Promise.resolve(undefined) },
  })
  expect(await view.select({ title: "Pick", options: [{ title: "A", value: 7 }] })).toBeUndefined()
  expect(await view.selectPaged({ title: "Pick", options: [], actions: [] })).toEqual({
    picked: undefined,
    action: undefined,
  })
})

it("uses RPC-native primitives, preserving duplicate labels, search, actions and cancellation", async () => {
  const fake = host("rpc")
  const view = piView(fake.ctx)
  fake.answers.push("2. Same", undefined, "ctrl+b: Previous", "1. M20", "Back", "Back")
  expect(
    await view.select({
      title: "Pick",
      options: [
        { title: "Same", value: 1 },
        { title: "Same", value: 2 },
      ],
    }),
  ).toBe(2)
  expect(await view.select({ title: "Pick", options: [] })).toBeUndefined()
  expect(
    await view.selectPaged({
      title: "Pages",
      options: [{ title: "A", value: 1 }],
      actions: [{ title: "Previous", value: "prev", bind: "ctrl+b" }],
    }),
  ).toEqual({ picked: undefined, action: "prev" })
  const options = Array.from({ length: 21 }, (_, value) => ({
    title: `M${String(value)}`,
    value,
    description: "model",
  }))
  fake.searches.push("M20")
  fake.answers[0] = "1. M20 — model"
  expect(await view.select({ title: "Models", options })).toBe(20)
  fake.searches.push(undefined)
  expect(await view.select({ title: "Models", options })).toBeUndefined()
  await view.table({ title: "Table", lines: ["one"] })
  await view.alert({ title: "Alert", message: "two" })
  expect(fake.rendered).toEqual([])
})

it("keeps every dialog one row shorter than the terminal so Pi never drops its footer", async () => {
  for (const rows of [24, 40]) {
    const fake = host("tui", [["\u001b"], ["\u001b"]], rows)
    const view = piView(fake.ctx)
    await view.table({
      title: "Long",
      lines: Array.from({ length: 80 }, (_, index) => `line ${String(index)}`),
    })
    await view.selectPaged({
      title: "Models\nquick: a",
      options: Array.from({ length: 80 }, (_, index) => ({
        title: `M${String(index)}`,
        value: index,
      })),
      actions: [{ title: "Next", value: "next", bind: "ctrl+f" }],
    })
    expect(fake.rendered).toHaveLength(6)
    for (const lines of fake.rendered) {
      expect(lines.length).toBeLessThanOrEqual(rows - 3)
      expect(lines.some((line) => line.includes("Esc back"))).toBe(true)
    }
  }
})

it("wraps long lines instead of truncating remedies, scrolls the wrapped text, and sanitizes it", async () => {
  const fake = host("tui", [["\u001b[B", "\u001b[B", "\u001b[A", "\r"]], 8)
  const view = piView(fake.ctx)
  const remedy = "Confirm tool support in adaptive/capabilities.json before relying on it"
  await view.table({ title: "Doctor", lines: ["FIX one", `  ${remedy}`, "bell\u0007", "OK last"] })
  const narrow = fake.rendered[0] ?? []
  expect(narrow.every((line) => !line.endsWith("…"))).toBe(true)
  expect(narrow.join(" ")).not.toContain("\u0007")
  const wide = fake.rendered[2] ?? []
  expect(wide.join("\n")).toContain(remedy)
  const welcome = picker(
    `Adaptive is installed\nquick: ${"model-name ".repeat(8)}`,
    [{ title: "Only", value: 1 }],
    [],
    24,
    () => undefined,
    () => undefined,
  )
  const lines = welcome.render(40)
  expect(lines.every((line) => visibleWidth(line) <= 40 && !line.endsWith("…"))).toBe(true)
  expect(lines.join("\n")).toContain("1 choice ·")
})
