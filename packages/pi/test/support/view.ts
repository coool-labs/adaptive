import type { AdaptiveView } from "@coool/adaptive-core/flow/controller"

export function fakeView(
  choices: (string | number | undefined)[] = [],
  confirms: (boolean | undefined)[] = [],
) {
  const selects: { title: string; options: readonly { title: string; value: unknown }[] }[] = []
  const alerts: { title: string; message: string }[] = []
  const tables: { title: string; lines: string[] }[] = []
  const toasts: { message: string; variant: string }[] = []
  const view: AdaptiveView = {
    select(spec) {
      selects.push(spec)
      const next = choices.shift()
      return Promise.resolve(
        typeof next === "number"
          ? spec.options[next]?.value
          : spec.options.find((option) => option.value === next || option.title === next)?.value,
      )
    },
    selectPaged(spec) {
      const next = choices.shift()
      return Promise.resolve({
        picked: typeof next === "number" ? spec.options[next]?.value : undefined,
        action: spec.actions.find((action) => action.value === next)?.value,
      })
    },
    confirm: () => Promise.resolve(confirms.shift()),
    alert: (spec) => {
      alerts.push(spec)
      return Promise.resolve()
    },
    table: (spec) => {
      tables.push(spec)
      return Promise.resolve()
    },
    toast: (message, variant) => {
      toasts.push({ message, variant })
    },
  }
  return { view, selects, alerts, tables, toasts }
}
