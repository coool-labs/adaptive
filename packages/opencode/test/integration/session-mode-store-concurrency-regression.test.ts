// covers: ["ADP-054"]
import { expect, it } from "vitest"
import { activeStorage, FakeSupervisorSession, makeSupervisor } from "./helpers.js"

it("retains concurrent supervisor session-mode changes through restart", async () => {
  const storage = activeStorage()
  const supervisor = makeSupervisor({ storage, session: new FakeSupervisorSession() })
  await supervisor.settings()
  await Promise.all([
    supervisor.setSessionMode("ses_a", "active"),
    supervisor.setSessionMode("ses_b", "off"),
  ])
  expect(await supervisor.getSessionMode("ses_a")).toBe("active")
  expect(await supervisor.getSessionMode("ses_b")).toBe("off")

  await Promise.all([
    supervisor.setSessionMode("ses_a", null),
    supervisor.setSessionMode("ses_c", "observe"),
  ])
  const restarted = makeSupervisor({ storage, session: new FakeSupervisorSession() })
  expect(await restarted.getSessionMode("ses_a")).toBeNull()
  expect(await restarted.getSessionMode("ses_b")).toBe("off")
  expect(await restarted.getSessionMode("ses_c")).toBe("observe")
})
