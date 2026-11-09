// covers: ["ADP-032", "ADP-063"]
import { expect, it } from "vitest"
import { defaultSettings } from "@coool/adaptive-core/state/settings/parse"
import { runOnboarding, editTierProposal, type OnboardingOptions } from "../src/host/onboarding.js"
import { PI_COPY } from "../src/ui/copy.js"
import { fakeView } from "./support/view.js"
import { fakeApi } from "./support/api.js"

const models = () =>
  [1, 2, 3].map((id) => ({
    ref: { providerID: "p", id: String(id) },
    inputCost: id,
    outputCost: id,
    reasoning: false,
    contextWindow: 1000,
    thinkingLevels: ["off"],
  }))
function setup(choices: (string | number | undefined)[] = [], confirms: boolean[] = []) {
  const state = fakeApi(defaultSettings())
  const view = fakeView(choices, confirms)
  const activations: string[] = []
  const options: OnboardingOptions = {
    hasUI: true,
    api: state.api,
    view: view.view,
    models,
    edit: (draft) => Promise.resolve(draft),
    activate: () => {
      activations.push("active")
      return Promise.resolve(true)
    },
  }
  return { ...state, ...view, options, activations }
}

it("dismisses once without saving tiers, changing models, or prompting headless", async () => {
  const state = setup()
  await runOnboarding(state.options)
  await runOnboarding(state.options)
  expect(state.selects).toHaveLength(1)
  expect(state.patches).toEqual([{ inviteDismissed: true }])
  expect(state.activations).toEqual([])
  const headless = setup()
  await runOnboarding({ ...headless.options, hasUI: false })
  expect(headless.selects).toEqual([])
  expect(headless.patches).toEqual([])
})

it("keeps proposal edits local until a positive confirmation", async () => {
  const state = setup([2, 1, 1], [false, true])
  await runOnboarding({
    ...state.options,
    edit: (draft) => {
      expect(state.patches).toEqual([])
      return Promise.resolve({ ...draft, tiers: { ...draft.tiers, quick: [] } })
    },
  })
  expect(state.patches).toHaveLength(1)
  expect(state.patches[0]).toMatchObject({
    mode: "observe",
    inviteDismissed: true,
    tiers: { quick: [] },
  })
  expect(state.activations).toEqual([])
})

it("only activates after a confirmed successful save, and reports failures", async () => {
  const use = setup([0], [true])
  await runOnboarding(use.options)
  expect(use.activations).toEqual(["active"])
  const failed = setup([0], [true])
  await runOnboarding({ ...failed.options, activate: () => Promise.resolve(false) })
  expect(failed.toasts.at(-1)?.variant).toBe("error")
  const invalid = setup([1], [true])
  await runOnboarding({
    ...invalid.options,
    api: {
      ...invalid.api,
      setSettings: () => Promise.resolve({ ok: false, errors: ["invalid tiers"] }),
    },
  })
  expect(invalid.alerts[0]?.message).toBe("invalid tiers")
})

it("preserves existing tiers and handles empty available inventory honestly", async () => {
  const state = setup([1], [true])
  await state.api.setSettings({
    tiers: { quick: [], standard: [{ providerID: "existing", id: "m" }], advanced: [] },
  })
  await runOnboarding(state.options)
  expect((await state.api.settings()).tiers.standard[0]?.providerID).toBe("existing")
  const empty = setup()
  await runOnboarding({ ...empty.options, models: () => [] })
  expect(empty.selects[0]?.title).toContain("no models available")
})

it("reuses the shared tier editor with a draft-only settings API", async () => {
  const state = fakeApi()
  // Tier -> Add -> model -> default variant -> escape tier, tier list and menu.
  const editor = fakeView(["quick", 0, 0, 0, undefined, undefined, undefined])
  const initial = { ...defaultSettings(), inviteDismissed: true }
  const draft = await editTierProposal(
    {
      copy: PI_COPY,
      api: state.api,
      view: editor.view,
      models: () => [{ providerID: "p", modelID: "m", name: "Model", variants: ["high"] }],
    },
    initial,
  )
  expect(draft.tiers.quick).toEqual([{ providerID: "p", id: "m" }])
  expect(state.patches).toEqual([])
})
