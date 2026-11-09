// covers: ["ADP-024", "ADP-045", "ADP-059", "ADP-060"]
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { savePark } from "../../src/parking.js"
import { jsonFile } from "../../src/store.js"

it("claims one durable wake across independent Pi worker processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adaptive-wake-"))
  try {
    const path = join(directory, "parked.json")
    await savePark(jsonFile(path), {
      session: "shared",
      token: "one-wake",
      tier: "standard",
      due: 1_000,
      wakes: 0,
      claimed: false,
    })
    const fixture = fileURLToPath(new URL("../fixtures/claim-park.ts", import.meta.url))
    const cli = createRequire(import.meta.url).resolve("vite-node/cli")
    const results = await Promise.all(
      Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [cli, fixture, path])),
    )
    expect(results.map((result) => result.stdout.trim()).sort()).toEqual([
      "false",
      "false",
      "false",
      "true",
    ])
    expect(await jsonFile(path).read()).toMatchObject({ records: [{ claimed: true, wakes: 0 }] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)
