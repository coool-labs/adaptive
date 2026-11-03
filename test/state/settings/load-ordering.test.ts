// covers: ["ADP-031", "ADP-036"]
import { expect, it } from "vitest"
import { SettingsStore, defaultSettings } from "../../../src/state/settings/index.js"

function gate() {
  let release: () => void = () => {
    // Replaced by the promise executor below before any caller can run it.
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

it("a reload waits behind a pending settings patch", async () => {
  let data: unknown = defaultSettings()
  let reads = 0
  const started = gate()
  const finish = gate()
  const store = new SettingsStore({
    read: () => {
      reads++
      return Promise.resolve(data)
    },
    write: async (settings) => {
      started.release()
      await finish.promise
      data = settings
    },
  })
  const updating = store.update({ mode: "active" })
  await started.promise
  const loading = store.load()
  try {
    await Promise.resolve()
    expect(reads).toBe(0)
  } finally {
    finish.release()
    await Promise.all([updating, loading])
  }
  expect(store.get().mode).toBe("active")
  expect(await loading).toEqual(data)
})

it("a patch waits for a pending settings load and preserves unpatched fields", async () => {
  const started = gate()
  const finish = gate()
  let data: unknown = { ...defaultSettings(), mode: "off" }
  let writes = 0
  const store = new SettingsStore({
    read: async () => {
      const snapshot = data
      started.release()
      await finish.promise
      return snapshot
    },
    write: (settings) => {
      writes++
      data = settings
      return Promise.resolve()
    },
  })
  const loading = store.load()
  await started.promise
  const updating = store.update({ inviteDismissed: true })
  try {
    await Promise.resolve()
    expect(writes).toBe(0)
  } finally {
    finish.release()
    await Promise.all([loading, updating])
  }
  expect(store.get()).toMatchObject({ mode: "off", inviteDismissed: true })
  expect(data).toEqual(store.get())
})
