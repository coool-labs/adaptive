// covers: ["ADP-010", "ADP-018", "ADP-023", "ADP-024", "ADP-060"]
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { dispatchedModels, object, traceEvents, waitForTrace } from "../matrix/trace.js"
import {
  launchPi,
  limitStandard,
  selectModel,
  settings,
  submit,
  turn,
  writeJson,
  type PiTerminalOptions,
} from "./harness.js"

function index(options: PiTerminalOptions): string {
  return join(options.env["PI_CODING_AGENT_DIR"] ?? "", "adaptive/parked.json")
}

function rows(path: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  assert.ok(object(value) && Array.isArray(value["records"]))
  return value["records"].map((row: unknown) => {
    assert.ok(object(row))
    return row
  })
}

function sessionFile(trace: string): string {
  const session = traceEvents(trace).findLast((event) => event["kind"] === "session")
  assert.ok(session && typeof session["file"] === "string")
  assert.ok(existsSync(session["file"]), "pre-dispatch parking did not persist the Pi session file")
  return session["file"]
}

/** Advance only persisted fixture deadlines while every host owning them is closed. */
function resetSoon(options: PiTerminalOptions, due: number): void {
  limitStandard(options, due)
  const records = rows(index(options))
  assert.equal(records.length, 1)
  writeJson(index(options), { version: 1, records: records.map((record) => ({ ...record, due })) })
}

function userCopies(file: string, prompt: string): number {
  return traceEvents(file).filter(
    (entry) =>
      entry["type"] === "message" &&
      object(entry["message"]) &&
      entry["message"]["role"] === "user" &&
      JSON.stringify(entry["message"]).includes(prompt),
  ).length
}

/**
 * Mid-run parks are the restart-durable ones: Pi writes a session file only once it holds a
 * conversation, so a park before any message cannot survive closing the process.
 */
async function durablePark(
  options: PiTerminalOptions,
  trace: string,
  prompt: string,
): Promise<{ file: string; dispatched: number }> {
  const terminal = await launchPi({
    ...options,
    tools: "matrix_probe",
    env: { ...options.env, PI_MATRIX_SCENARIO: "durable-park" },
  })
  try {
    await terminal.waitForText("(adaptive) auto", { timeout: 20_000 })
    await submit(terminal, prompt)
    await terminal.waitForText("Parked: no available standard model", { timeout: 10_000 })
    assert.deepEqual(dispatchedModels(trace), ["standard", "standard"])
    assert.equal(rows(index(options)).length, 1)
    assert.ok(
      !readFileSync(index(options), "utf8").includes(prompt),
      "global parked index leaked message content",
    )
    return { file: sessionFile(trace), dispatched: dispatchedModels(trace).length }
  } finally {
    writeFileSync(join(options.cwd, `${prompt}.parked.txt`), terminal.screen().text())
    await terminal.close()
  }
}

export async function exerciseParking(options: PiTerminalOptions): Promise<void> {
  const trace = options.env["PI_MATRIX_TRACE"]
  const agentDir = options.env["PI_CODING_AGENT_DIR"]
  assert.ok(trace && agentDir)
  const original = readFileSync(join(agentDir, "adaptive/settings.json"), "utf8")
  const clean = () => {
    writeFileSync(trace, "")
    writeJson(index(options), { version: 1, records: [] })
    writeJson(join(agentDir, "adaptive/health.json"), { version: 1, records: [] })
  }
  const saved = {
    ...options,
    model: "adaptive/auto",
    sessionDirectory: join(options.cwd, "parking-sessions"),
  }
  settings(options, { mode: "active" })
  try {
    clean()
    let terminal = await launchPi(saved)
    try {
      await terminal.waitForText("(adaptive) auto", { timeout: 20_000 })
      const until = Date.now() + 3_000
      limitStandard(saved, until)
      await turn(terminal, trace, "MATRIX_SHORT_RESET")
      assert.ok(Date.now() >= until, "dispatch preceded the actual provider reset")
      assert.deepEqual(
        dispatchedModels(trace),
        ["standard"],
        "preferred model did not return at the next safe boundary",
      )
    } finally {
      await terminal.close()
    }

    clean()
    terminal = await launchPi(saved)
    try {
      await terminal.waitForText("(adaptive) auto", { timeout: 20_000 })
      limitStandard(saved, Date.now() + 60_000)
      await submit(terminal, "MATRIX_SHORT_ESCAPE")
      await terminal.waitForText("Waiting for a model", { timeout: 10_000 })
      await terminal.waitForText("Esc cancels", { timeout: 10_000 })
      await terminal.press("Escape")
      await waitForTrace(trace, (events) =>
        events.some((event) => event["kind"] === "settled" && event["aborted"] === true),
      )
      assert.deepEqual(dispatchedModels(trace), [], "Esc dispatched or retried a cancelled wait")
      await selectModel(terminal, "adaptive-faux/manual-physical")
      await turn(terminal, trace, "MATRIX_MANUAL_AFTER_ESCAPE")
      assert.deepEqual(dispatchedModels(trace), ["manual-physical"])
    } finally {
      await terminal.close()
    }

    const exhausted = {
      tiers: {
        quick: [{ providerID: "adaptive-faux", id: "quick" }],
        standard: [{ providerID: "adaptive-faux", id: "standard" }],
        advanced: [{ providerID: "adaptive-faux", id: "advanced" }],
      },
    }
    settings(options, exhausted)
    clean()
    const prompt = "MATRIX_MID_RUN_PARK_ONCE"
    const parked = await durablePark(saved, trace, prompt)
    terminal = await launchPi({ ...saved, tools: "matrix_probe", session: parked.file })
    try {
      await terminal.waitForText("Parked: no available standard model", { timeout: 20_000 })
      await terminal.waitForText("Send a message or pick a model to cancel.", { timeout: 10_000 })
      assert.equal(
        dispatchedModels(trace).length,
        parked.dispatched,
        "reopening before reset dispatched parked work",
      )
    } finally {
      await terminal.close()
    }

    clean()
    const duePrompt = "MATRIX_REOPEN_DUE"
    const due = await durablePark(saved, trace, duePrompt)
    const settledBefore = traceEvents(trace).filter((event) => event["kind"] === "settled").length
    resetSoon(saved, Date.now() - 1_000)
    terminal = await launchPi({ ...saved, tools: "matrix_probe", session: due.file })
    try {
      await terminal.waitForText("Resume the parked task now?", { timeout: 20_000 })
      assert.equal(
        dispatchedModels(trace).length,
        due.dispatched,
        "overdue reopen resumed without consent",
      )
      await terminal.press("Enter")
      await waitForTrace(
        trace,
        (events) => events.filter((event) => event["kind"] === "settled").length > settledBefore,
      )
      assert.equal(dispatchedModels(trace).length, due.dispatched + 1)
      assert.equal(userCopies(due.file, duePrompt), 1)
      assert.equal(
        traceEvents(trace).filter((event) => event["kind"] === "probe").length,
        1,
        "consenting repeated a durable tool side effect",
      )
    } finally {
      await terminal.close()
    }

    clean()
    limitStandard(saved, Date.now() + 300_000)
    terminal = await launchPi(saved)
    try {
      await terminal.waitForText("(adaptive) auto", { timeout: 20_000 })
      await submit(terminal, "MATRIX_DROPPED_INPUT")
      await terminal.waitForText("Parked: no available standard model", { timeout: 10_000 })
      const token = rows(index(options))[0]?.["token"]
      await submit(terminal, "MATRIX_REPLACEMENT_INPUT")
      await terminal.waitForQuiet({ quietMs: 100, timeout: 10_000 })
      assert.notEqual(
        rows(index(options))[0]?.["token"],
        token,
        "new input did not replace parked work",
      )
      await selectModel(terminal, "adaptive-faux/manual-physical")
      await turn(terminal, trace, "MATRIX_MANUAL_TAKEOVER")
      assert.deepEqual(rows(index(options)), [], "manual takeover left a wake armed")
      assert.deepEqual(dispatchedModels(trace), ["manual-physical"])
      const cancellationFile = sessionFile(trace)
      assert.equal(userCopies(cancellationFile, "MATRIX_DROPPED_INPUT"), 0)
      assert.equal(userCopies(cancellationFile, "MATRIX_REPLACEMENT_INPUT"), 0)
    } finally {
      await terminal.close()
    }

    clean()
    settings(options, {
      tiers: {
        quick: [{ providerID: "adaptive-faux", id: "quick" }],
        standard: [{ providerID: "adaptive-faux", id: "standard" }],
        advanced: [{ providerID: "adaptive-faux", id: "advanced" }],
      },
    })
    terminal = await launchPi({
      ...saved,
      tools: "matrix_probe",
      env: { ...saved.env, PI_MATRIX_SCENARIO: "durable-park" },
    })
    let durableFile: string
    let continuations: number
    try {
      await terminal.waitForText("(adaptive) auto", { timeout: 20_000 })
      await submit(terminal, "MATRIX_DURABLE_TOOL_ONCE")
      await terminal.waitForText("Parked: no available standard model", { timeout: 10_000 })
      assert.deepEqual(dispatchedModels(trace), ["standard", "standard"])
      assert.equal(traceEvents(trace).filter((event) => event["kind"] === "probe").length, 1)
      durableFile = sessionFile(trace)
      continuations = traceEvents(durableFile).filter(
        (entry) =>
          entry["type"] === "custom_message" && entry["customType"] === "adaptive.continuation",
      ).length
    } finally {
      await terminal.close()
    }
    const previousSettles = traceEvents(trace).filter((event) => event["kind"] === "settled").length
    resetSoon(saved, Date.now() + 1_500)
    terminal = await launchPi({ ...saved, session: durableFile, tools: "matrix_probe" })
    try {
      await waitForTrace(
        trace,
        (events) => events.filter((event) => event["kind"] === "settled").length > previousSettles,
      )
      assert.deepEqual(dispatchedModels(trace), ["standard", "standard", "standard"])
      assert.equal(
        traceEvents(trace).filter((event) => event["kind"] === "probe").length,
        1,
        "wake repeated a durable tool side effect",
      )
      assert.equal(userCopies(durableFile, "MATRIX_DURABLE_TOOL_ONCE"), 1)
      const resumed = traceEvents(durableFile).filter(
        (entry) =>
          entry["type"] === "custom_message" && entry["customType"] === "adaptive.continuation",
      )
      assert.equal(
        resumed.length,
        continuations + 1,
        "wake did not add exactly one owned continuation",
      )
      assert.equal(resumed.at(-1)?.["display"], false)
    } finally {
      await terminal.close()
    }
    console.log(
      JSON.stringify({
        surface: "tui",
        journey: "parking-reset-reopen-Esc-cancel-durable-continuation",
        result: "PASS",
      }),
    )
  } finally {
    writeFileSync(join(agentDir, "adaptive/settings.json"), original)
    clean()
  }
}
