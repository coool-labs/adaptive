// covers: ["ADP-034", "ADP-056"]
import { afterAll, describe, expect, it } from "vitest"
import { join } from "node:path"
import { REPO_ROOT, rpc, startHost, type StartedHost } from "./helpers.js"
import { adaptiveRpc } from "../../src/rpc.js"

const STALE_LEDGER = join(REPO_ROOT, "test", "fixtures", "stale-ledger")

// Regression (user-reported): 1.6.1 loaded into a host process that already
// held an older release's process ledger died in setup, so neither
// `/web-adaptive` nor the RPC behind the `/adaptive` dialogs existed — while
// every fresh-host E2E (one plugin copy, one release) stayed green.
describe("runtime e2e: Adaptive beside an older release's process state", () => {
  const hosts: StartedHost[] = []
  afterAll(async () => {
    for (const host of hosts.reverse()) await host.close()
  })

  it("registers /web-adaptive and serves the dialogs' RPC", { timeout: 120_000 }, async () => {
    // startHost only returns once the RPC answers, so a plugin that died in
    // setup fails right here.
    const host = await startHost({ pluginEntries: [STALE_LEDGER, REPO_ROOT] })
    hosts.push(host)

    const commands = await host.client.command.list()
    expect(commands.data.some((command) => command.name === "web-adaptive")).toBe(true)
    const plugins = await host.client.plugin.list()
    expect(plugins.data.some((plugin) => plugin.id === "e2e.stale-ledger")).toBe(true)
    expect(
      await host.client.rpc(adaptiveRpc)["settings.get"](undefined, {
        location: { directory: host.project },
      }),
    ).toMatchObject({ mode: "observe" })

    const session = await host.client.session.create()
    await host.client.session.command({
      sessionID: session.id,
      name: "web-adaptive",
      text: "on",
    })
    await host.client.session.wait({ sessionID: session.id })
    expect(await rpc(host).settings.get()).toMatchObject({ mode: "active" })
  })
})
