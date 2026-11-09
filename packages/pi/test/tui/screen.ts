import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { visibleWidth } from "@earendil-works/pi-tui"
import type { PiTerminal, PiTerminalOptions } from "./harness.js"

export interface ScreenSize {
  readonly columns: number
  readonly rows: number
}
/** The three reviewed geometries: narrow, classic and roomy. */
export const SIZES: readonly ScreenSize[] = [
  { columns: 60, rows: 24 },
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
]

export function lines(terminal: PiTerminal): string[] {
  return terminal.screen().text().split("\n")
}

/** Wrapped remedies and long labels are compared without regard to where they broke. */
export function squash(text: string): string {
  return text.replace(/\s+/g, "")
}

/** Wait for content, then for the frame to finish drawing: Pi paints in several writes. */
export async function settle(terminal: PiTerminal, text: string | RegExp): Promise<void> {
  await terminal.waitForText(text, { timeout: 15_000 })
  await terminal.waitForQuiet({ quietMs: 150, timeout: 15_000 })
}

/**
 * The grid cannot show an over-wide line (Pi refuses to draw one, which the waits above would
 * report); component widths are asserted directly in the unit suite. This pins the geometry.
 */
export function assertFits(terminal: PiTerminal, size: ScreenSize, label: string): void {
  const screen = lines(terminal)
  assert.ok(
    screen.length <= size.rows,
    `${label}: ${String(screen.length)} rows > ${String(size.rows)}`,
  )
  for (const line of screen)
    assert.ok(
      visibleWidth(line) <= size.columns,
      `${label}: line over ${String(size.columns)} columns: ${JSON.stringify(line)}`,
    )
}

/** An action footer is shown whole: present, and not cut off with an ellipsis. */
export function assertFooter(terminal: PiTerminal, footer: string, label: string): void {
  const line = lines(terminal).find((candidate) => candidate.includes(footer))
  assert.ok(line !== undefined, `${label}: footer ${JSON.stringify(footer)} missing`)
  assert.ok(!line.endsWith("…"), `${label}: footer truncated: ${JSON.stringify(line)}`)
}

/** Dialogs wrap rather than truncate, so no line of theirs may end in an ellipsis. */
export function assertWhole(
  terminal: PiTerminal,
  from: string,
  label: string,
  /** Menu titles that end in an ellipsis by design ("opens another dialog"). */
  titles: readonly string[] = ["Edit suggested tiers…"],
): void {
  const screen = lines(terminal)
  const start = screen.findIndex((line) => line.startsWith(from))
  assert.ok(start >= 0, `${label}: ${JSON.stringify(from)} missing`)
  for (const line of screen.slice(start))
    assert.ok(
      !line.endsWith("…") || titles.some((title) => line.trim().endsWith(title)),
      `${label}: truncated line ${JSON.stringify(line)}`,
    )
}

/**
 * Retains the frame next to the matrix evidence; with ADAPTIVE_PI_SCREENSHOTS set it is also
 * written to that directory, which is how docs/screenshots is produced.
 */
export function capture(
  terminal: PiTerminal,
  options: PiTerminalOptions,
  size: ScreenSize,
  name: string,
): void {
  const file = `${name}-${String(size.columns)}x${String(size.rows)}.txt`
  const text = `${terminal.screen().text()}\n`
  const retained = join(options.cwd, "screens")
  mkdirSync(retained, { recursive: true })
  writeFileSync(join(retained, file), text)
  const published = process.env["ADAPTIVE_PI_SCREENSHOTS"]
  if (published !== undefined && size.columns === 80) {
    mkdirSync(published, { recursive: true })
    writeFileSync(join(published, file), text)
  }
}

/** `/adaptive <sub>` as a person types it: the completion menu takes the first Enter. */
export async function slash(
  terminal: PiTerminal,
  sub: string,
  ready: string | RegExp,
): Promise<void> {
  await terminal.type(`/adaptive ${sub}`)
  await terminal.waitForText(`→ ${sub}`, { timeout: 10_000 })
  await terminal.press("Enter")
  await terminal.waitForQuiet({ quietMs: 150, timeout: 10_000 })
  await terminal.press("Enter")
  await settle(terminal, ready)
}

/** The same menu as the shortcut a person presses. */
export async function openMenu(terminal: PiTerminal): Promise<void> {
  await terminal.press("Control+Alt+a")
  await settle(terminal, "Enter select · Esc back")
}

/** Typing narrows the picker; Enter takes the first match. */
export async function choose(
  terminal: PiTerminal,
  entry: string,
  ready: string | RegExp,
): Promise<void> {
  await terminal.type(entry)
  await terminal.waitForQuiet({ quietMs: 150, timeout: 10_000 })
  await terminal.press("Enter")
  await settle(terminal, ready)
}
