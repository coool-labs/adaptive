// covers: ["ADP-005", "ADP-013", "ADP-029", "ADP-057", "ADP-058", "ADP-059", "ADP-062", "ADP-063"]
import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dispatchedModels, object, traceEvents, waitForTrace } from "../matrix/trace.js"
import {
  adaptiveFile,
  launchPi,
  resetState,
  selectModel,
  settings,
  submit,
  turn,
  writeJson,
  type PiTerminal,
  type PiTerminalOptions,
} from "./harness.js"
import {
  SIZES,
  assertFits,
  assertFooter,
  assertWhole,
  capture,
  choose,
  lines,
  openMenu,
  settle,
  slash,
  squash,
  type ScreenSize,
} from "./screen.js"

function savedTiers(options: PiTerminalOptions): Record<string, string[]> {
  const raw: unknown = JSON.parse(readFileSync(adaptiveFile(options, "settings.json"), "utf8"))
  assert.ok(object(raw) && object(raw["tiers"]), "settings.json has no tiers")
  return Object.fromEntries(
    Object.entries(raw["tiers"]).map(([tier, refs]) => {
      assert.ok(Array.isArray(refs))
      return [
        tier,
        refs.map((ref: unknown) => {
          assert.ok(object(ref) && typeof ref["id"] === "string")
          return ref["id"]
        }),
      ]
    }),
  )
}

function savedField(options: PiTerminalOptions, field: string): unknown {
  const raw: unknown = JSON.parse(readFileSync(adaptiveFile(options, "settings.json"), "utf8"))
  assert.ok(object(raw))
  return raw[field]
}

/** Esc is "back" everywhere; each press is awaited on the screen it should reveal. */
async function back(terminal: PiTerminal, revealed: string | RegExp): Promise<void> {
  await terminal.press("Escape")
  await settle(terminal, revealed)
}

async function firstRun(options: PiTerminalOptions, size: ScreenSize): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  resetState(options)
  rmSync(adaptiveFile(options, "settings.json"), { force: true })
  const terminal = await launchPi({ ...options, ...size })
  const label = `first-run ${String(size.columns)}x${String(size.rows)}`
  try {
    await settle(terminal, "Enter select · Esc back")
    assertFits(terminal, size, label)
    assertFooter(terminal, "Enter select · Esc back", label)
    assertWhole(terminal, "Adaptive is installed", label)
    capture(terminal, options, size, "first-run-proposal")
    assert.ok(
      !existsSync(adaptiveFile(options, "settings.json")),
      "the proposal saved before consent",
    )

    await terminal.press("Enter")
    await settle(terminal, "Save these tiers?")
    await settle(terminal, "enter select")
    assertFits(terminal, size, `${label} confirm`)
    capture(terminal, options, size, "first-run-confirm")
    assert.ok(!existsSync(adaptiveFile(options, "settings.json")), "nothing may save before Yes")

    await terminal.press("Enter")
    await settle(terminal, "Tiers saved")
    assert.equal(savedField(options, "mode"), "observe", "first run must default to observe")
    assert.equal(savedField(options, "inviteDismissed"), true)
    const tiers = savedTiers(options)
    const standard = tiers["standard"]?.[0]
    assert.ok(standard !== undefined, "the proposal left the standard tier empty")

    await turn(terminal, trace, "First routed turn")
    assert.deepEqual(dispatchedModels(trace), [standard])
    await settle(terminal, `Adaptive · standard → adaptive-faux/${standard}`)
    assertFits(terminal, size, `${label} note`)
    capture(terminal, options, size, "routed-note")
  } finally {
    await terminal.close()
  }
}

/** Parked card, picker, status and doctor at one geometry, then a routed turn's note. */
async function screens(options: PiTerminalOptions, size: ScreenSize): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  const label = `${String(size.columns)}x${String(size.rows)}`
  resetState(options)
  const health = JSON.parse(readFileSync(adaptiveFile(options, "health.json"), "utf8")) as unknown
  const terminal = await launchPi({ ...options, ...size, model: "adaptive/auto" })
  try {
    await settle(terminal, "(adaptive) auto")
    writeJson(adaptiveFile(options, "health.json"), {
      version: 1,
      records: ["standard", "standard-b"].map((id) => ({
        key: { providerID: "adaptive-faux", modelID: id },
        health: "quota_exhausted",
        breaker: { state: "closed", failures: 0, openCount: 0 },
        window: { kind: "quota", until: Date.now() + 600_000 },
        updatedAt: Date.now(),
      })),
    })
    await submit(terminal, "Park this")
    await settle(terminal, "Send a message or pick a model to cancel.")
    assertFits(terminal, size, `parked ${label}`)
    assertFooter(terminal, "/adaptive resume tries now", `parked ${label}`)
    assert.ok(
      lines(terminal).some((line) => line.includes("Parked: no available standard model")),
      `parked ${label}: card title missing`,
    )
    assert.ok(
      lines(terminal).some((line) => /standard parked · resumes \d\d:\d\d/.test(line)),
      `parked ${label}: status chip missing`,
    )
    capture(terminal, options, size, "parked-card")
    writeJson(adaptiveFile(options, "health.json"), health)

    await openMenu(terminal)
    assertFits(terminal, size, `menu ${label}`)
    assertFooter(terminal, "Enter select · Esc back", `menu ${label}`)
    capture(terminal, options, size, "menu-picker")

    await terminal.press("Enter")
    await settle(terminal, "Enter or Esc back")
    assertFits(terminal, size, `status ${label}`)
    assertFooter(terminal, "↑/↓ scroll · Enter or Esc back", `status ${label}`)
    assertWhole(terminal, "Status", `status ${label}`)
    capture(terminal, options, size, "status")
    await back(terminal, "Enter select · Esc back")

    await choose(terminal, "Doctor", "Enter or Esc back")
    assertFits(terminal, size, `doctor ${label}`)
    assertFooter(terminal, "↑/↓ scroll · Enter or Esc back", `doctor ${label}`)
    assertWhole(terminal, "Adaptive doctor", `doctor ${label}`)
    capture(terminal, options, size, "doctor")
    await back(terminal, "Enter select · Esc back")
    await terminal.press("Escape")
    await settle(terminal, "(adaptive) auto")

    await turn(terminal, trace, "Routed after the park")
    await settle(terminal, "Adaptive · standard → adaptive-faux/standard")
    assertFits(terminal, size, `note ${label}`)
    capture(terminal, options, size, "routed-note-after-park")
  } finally {
    await terminal.close()
  }
}

/** A 429 redirects within the tier; the note says it was a fallback. */
async function recovery(options: PiTerminalOptions): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  resetState(options)
  const terminal = await launchPi({
    ...options,
    env: { ...options.env, PI_MATRIX_SCENARIO: "429" },
  })
  try {
    await settle(terminal, "(adaptive) auto")
    await turn(terminal, trace, "Hit the rate limit")
    assert.deepEqual(dispatchedModels(trace), ["standard", "standard-b"])
    await settle(terminal, "MATRIX_OK standard-b")
    await settle(terminal, "Adaptive · standard → adaptive-faux/standard-b · retry")
    assert.ok(
      readFileSync(adaptiveFile(options, "health.json"), "utf8").includes("rate_limited"),
      "the 429 was not shared as health",
    )
    capture(terminal, options, { columns: 80, rows: 40 }, "recovery-note")
  } finally {
    await terminal.close()
  }
}

/** Picking a physical model hands control back at once and says so. */
async function manualPick(options: PiTerminalOptions): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  resetState(options)
  const terminal = await launchPi(options)
  try {
    await settle(terminal, "(adaptive) auto")
    await turn(terminal, trace, "Routed first")
    await selectModel(terminal, "adaptive-faux/manual-physical")
    await settle(terminal, "Adaptive · Paused · you picked adaptive-faux/manual-physical")
    await turn(terminal, trace, "Manual now")
    assert.deepEqual(dispatchedModels(trace), ["standard", "manual-physical"])
    capture(terminal, options, { columns: 80, rows: 40 }, "paused-note")
  } finally {
    await terminal.close()
  }
}

/** Tier order is user configuration: a reorder survives a restart and steers the next turn. */
async function reorder(options: PiTerminalOptions): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  resetState(options)
  let terminal = await launchPi(options)
  try {
    await settle(terminal, "(adaptive) auto")
    await openMenu(terminal)
    await choose(terminal, "Models", "3 choices")
    await terminal.press("ArrowDown")
    await terminal.press("Enter")
    await settle(terminal, "Tier: standard")
    await terminal.press("ArrowDown")
    await terminal.press("ArrowDown")
    await terminal.press("Enter")
    await settle(terminal, "Resource: adaptive-faux/standard-b")
    await terminal.press("Enter")
    await settle(
      terminal,
      /adaptive-faux\/standard-b — Move or remove\s+adaptive-faux\/standard — Move or remove/,
    )
    assert.deepEqual(savedTiers(options)["standard"], ["standard-b", "standard"])
    await back(terminal, "3 choices")
    await back(terminal, "Enter select · Esc back")
    await terminal.press("Escape")
    await settle(terminal, "(adaptive) auto")
  } finally {
    await terminal.close()
  }
  terminal = await launchPi(options)
  try {
    await settle(terminal, "(adaptive) auto")
    await openMenu(terminal)
    await choose(terminal, "Models", "3 choices")
    await settle(terminal, "standard (2) — adaptive-faux/standard-b · adaptive-faux/standard")
    await back(terminal, "Enter select · Esc back")
    await terminal.press("Escape")
    await settle(terminal, "(adaptive) auto")
    await turn(terminal, trace, "After the restart")
    assert.deepEqual(dispatchedModels(trace), ["standard-b"])
  } finally {
    await terminal.close()
  }
}

/** A tier entry without credentials is the first thing doctor says, with its remedy. */
async function doctor(options: PiTerminalOptions): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  const size = { columns: 80, rows: 24 }
  resetState(options)
  const terminal = await launchPi({ ...options, ...size })
  try {
    await settle(terminal, "(adaptive) auto")
    await waitForTrace(trace, (events) => events.some((event) => event["kind"] === "keyless"))
    const keyless = traceEvents(trace).find((event) => event["kind"] === "keyless")
    const provider = keyless?.["provider"]
    const model = keyless?.["model"]
    assert.ok(typeof provider === "string" && typeof model === "string", "no keyless catalog model")
    const original: unknown = JSON.parse(
      readFileSync(adaptiveFile(options, "settings.json"), "utf8"),
    )
    assert.ok(object(original) && object(original["tiers"]))
    const quick: unknown = original["tiers"]["quick"]
    assert.ok(Array.isArray(quick))
    const entries: unknown[] = quick
    settings(options, {
      tiers: { ...original["tiers"], quick: [...entries, { providerID: provider, id: model }] },
    })
    try {
      await slash(terminal, "doctor", "Enter or Esc back")
      assertFits(terminal, size, "doctor missing credential")
      assertFooter(terminal, "↑/↓ scroll · Enter or Esc back", "doctor missing credential")
      const screen = squash(lines(terminal).join("\n"))
      assert.ok(screen.includes("1tofix"), "the summary does not lead with the problem")
      assert.ok(
        screen.includes(squash(`FIX ${provider}/${model} (quick): no credentials configured`)),
        "the missing credential is not reported on the first screen",
      )
      assert.ok(screen.includes(squash(`Run /login ${provider}`)), "the remedy is missing")
      const rows = lines(terminal)
      assert.ok(
        rows.findIndex((line) => line.startsWith("FIX ")) <
          rows.findIndex((line) => line.startsWith("OK ")),
        "problems must precede passing checks",
      )
      capture(terminal, options, size, "doctor-missing-credential")
      await back(terminal, "(adaptive) auto")
    } finally {
      writeFileSync(adaptiveFile(options, "settings.json"), `${JSON.stringify(original)}\n`)
    }
  } finally {
    await terminal.close()
  }
}

/** A second live Pi sees the first one's 429 on its very first turn. */
async function sharedHealth(options: PiTerminalOptions): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"] ?? ""
  const other = `${trace}.second`
  resetState(options)
  writeFileSync(other, "")
  const first = await launchPi({ ...options, env: { ...options.env, PI_MATRIX_SCENARIO: "429" } })
  try {
    await settle(first, "(adaptive) auto")
    await turn(first, trace, "Rate limited here")
    assert.deepEqual(dispatchedModels(trace), ["standard", "standard-b"])
    const second = await launchPi({
      ...options,
      env: { ...options.env, PI_MATRIX_TRACE: other, PI_MATRIX_SCENARIO: "success" },
    })
    try {
      await settle(second, "(adaptive) auto")
      await turn(second, other, "Never touch the limited model")
      assert.deepEqual(dispatchedModels(other), ["standard-b"])
      await settle(second, "Adaptive · standard → adaptive-faux/standard-b · fallback")
      await settle(second, "MATRIX_OK standard-b")
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
    rmSync(other, { force: true })
  }
}

export async function exerciseJourneys(options: PiTerminalOptions): Promise<void> {
  const original = readFileSync(adaptiveFile(options, "settings.json"), "utf8")
  const restore = () => {
    writeFileSync(adaptiveFile(options, "settings.json"), original)
    resetState(options)
  }
  try {
    for (const size of SIZES) {
      await firstRun(options, size)
      restore()
      await screens(options, size)
      restore()
    }
    await recovery(options)
    restore()
    await manualPick(options)
    restore()
    await reorder(options)
    restore()
    await doctor(options)
    restore()
    await sharedHealth(options)
    console.log(
      JSON.stringify({
        surface: "tui",
        journey: "first-run-recovery-pause-reorder-doctor-shared-health-layouts",
        sizes: SIZES.map((size) => `${String(size.columns)}x${String(size.rows)}`),
        result: "PASS",
      }),
    )
  } finally {
    restore()
  }
}
