import { expect } from "vitest"
import { Command, SettingsPage } from "@opencode/plugin/gui"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "solid-js/web"
import type { JSX } from "solid-js"

import { REPO_ROOT } from "../runtime-e2e/helpers.js"
import type { StartedHost } from "../runtime-e2e/helpers.js"

/** What a GUI bundle default-exports: `Plugin.define({ setup })`. */
export interface GuiPlugin {
  setup?: (context: never) => void
}

/** One option of a host select, as the user sees it. */
interface ShownOption {
  title: string
  description?: string
  value: unknown
}

type Kind = "select" | "confirm" | "alert" | "custom"

/** A dialog the flow put on screen, with the ways a user can answer it. */
export interface Shown {
  readonly kind: Kind
  readonly title: string
  readonly description: string | undefined
  readonly placeholder: string | undefined
  readonly current: unknown
  readonly options: readonly ShownOption[]
  /** Rendered text of a custom dialog (the status table). */
  text(): string
  /** Pick a select row by its exact title. */
  choose(label: string): void
  /** Escape on a select (resolves `undefined`) or Cancel on a confirm. */
  dismiss(): void
  /** Confirm / Cancel on a confirm dialog. */
  answer(yes: boolean): void
  /** OK on an alert. */
  ok(): void
  /** Press a footer button of a custom dialog. */
  press(label: string): void
  /** Escape on a custom dialog: it unmounts without any button. */
  escape(): void
}

interface Model {
  providerID: string
  modelID: string
  name: string
  variants: readonly { id: string }[]
}

export interface StandInOptions {
  /** The session the user is looking at; undefined is the Home screen. */
  session?: { id: string; builtin?: boolean; located?: boolean } | undefined
  /** Make the model catalog refuse to load (offline picker). */
  catalogFails?: boolean
  /** Leave the plugin's own server out of the server list. */
  noServer?: boolean
  /** Override the RPC client (a host that has gone away). */
  client?: StartedHost["client"]
}

/**
 * A minimal GUI host: the real OpenCode client for RPC and the model catalog,
 * and in-memory dialogs, toasts and a session slot the test drives like a
 * user. Dialog answers are explicit (`next()` waits for the flow's next
 * dialog), so the journeys need no sleeps.
 */
export class StandIn {
  readonly toasts: { title: string; variant: string | undefined }[] = []
  readonly added: { registry: unknown; item: unknown }[] = []
  private readonly queue: Shown[] = []
  private readonly waiting: ((dialog: Shown) => void)[] = []
  private catalog: readonly Model[] = []
  private flow: Promise<void> | undefined
  private flowEnded: Promise<never> | undefined
  private session: StandInOptions["session"]

  constructor(
    private readonly host: StartedHost,
    private readonly options: StandInOptions = {},
  ) {
    this.session = options.session
  }

  /** Switch the session slot (undefined = Home). */
  show(session: StandInOptions["session"]): void {
    this.session = session
  }

  /** Register the plugin against this host. */
  install(plugin: GuiPlugin): { command: CommandItem; page: PageItem } {
    if (plugin.setup === undefined) throw new Error("the GUI plugin defines no setup")
    plugin.setup(this.context() as never)
    const find = (registry: unknown): unknown => {
      const entry = this.added.find((candidate) => candidate.registry === registry)
      if (entry === undefined) throw new Error("the plugin did not register the expected item")
      return entry.item
    }
    return { command: find(Command) as CommandItem, page: find(SettingsPage) as PageItem }
  }

  /** Start the command like the palette would; dialogs arrive through `next()`. */
  open(command: CommandItem): void {
    this.queue.length = 0
    this.waiting.length = 0
    const flow = command.run()
    this.flow = flow
    this.flowEnded = flow.then(() => {
      throw new Error("the flow ended while another dialog was expected")
    })
    // The rejection is consumed by whichever next() races it; unhandled otherwise.
    this.flowEnded.catch(() => undefined)
  }

  /** The flow's next dialog, asserted by title. */
  async next(title: string | RegExp): Promise<Shown> {
    const queued = this.queue.shift()
    const dialog =
      queued ??
      (await Promise.race([
        new Promise<Shown>((resolve) => this.waiting.push(resolve)),
        this.flowEnded ?? new Promise<never>(() => undefined),
      ]))
    if (typeof title === "string") expect(dialog.title).toBe(title)
    else expect(dialog.title).toMatch(title)
    return dialog
  }

  /** Wait for the flow to finish; no dialog may be left on screen. */
  async finished(): Promise<void> {
    await this.flow
    expect(this.queue.map((dialog) => dialog.title)).toEqual([])
  }

  /** Run `answer` on the next select titled `title`, picking `label`. */
  async pick(title: string | RegExp, label: string): Promise<Shown> {
    const dialog = await this.next(title)
    dialog.choose(label)
    return dialog
  }

  private push(dialog: Shown): void {
    const waiter = this.waiting.shift()
    if (waiter === undefined) this.queue.push(dialog)
    else waiter(dialog)
  }

  private shown(
    kind: Kind,
    input: {
      title: string
      description?: string | undefined
      placeholder?: string | undefined
      current?: unknown
      options?: readonly ShownOption[]
    },
    answer: (value: unknown) => void,
    custom: { text: () => string; buttons: Map<string, () => void>; escape: () => void },
  ): void {
    const options = input.options ?? []
    this.push({
      kind,
      title: input.title,
      description: input.description,
      placeholder: input.placeholder,
      current: input.current,
      options,
      text: custom.text,
      choose: (label) => {
        const option = options.find((candidate) => candidate.title === label)
        if (option === undefined) {
          throw new Error(
            `no option "${label}" in "${input.title}": ${options.map((entry) => entry.title).join(" | ")}`,
          )
        }
        answer(option.value)
      },
      dismiss: () => {
        answer(kind === "confirm" ? false : undefined)
      },
      answer: (yes) => {
        answer(yes)
      },
      ok: () => {
        answer(undefined)
      },
      press: (label) => {
        const button = custom.buttons.get(label)
        if (button === undefined) throw new Error(`no button "${label}" in "${input.title}"`)
        button()
      },
      escape: custom.escape,
    })
  }

  private context(): unknown {
    const none = {
      text: () => "",
      buttons: new Map<string, () => void>(),
      escape: () => undefined,
    }
    const dialogs = {
      select: (input: {
        title: string
        placeholder?: string
        current?: unknown
        options: readonly ShownOption[]
      }) =>
        new Promise<unknown>((resolve) => {
          this.shown("select", input, resolve, none)
        }),
      confirm: (input: { title: string; description?: string }) =>
        new Promise<boolean>((resolve) => {
          this.shown(
            "confirm",
            input,
            (value) => {
              resolve(value === true)
            },
            none,
          )
        }),
      alert: (input: { title: string; description?: string }) =>
        new Promise<void>((resolve) => {
          this.shown(
            "alert",
            input,
            () => {
              resolve()
            },
            none,
          )
        }),
      open: (view: (dialog: { close: () => void }) => JSX.Element) => {
        const container = document.createElement("div")
        document.body.appendChild(container)
        const dispose = render(
          () =>
            view({
              close: () => {
                dispose()
              },
            }),
          container,
        )
        this.shown(
          "custom",
          { title: container.querySelector("h2")?.textContent ?? "" },
          () => undefined,
          {
            text: () => container.querySelector("pre")?.textContent ?? "",
            buttons: new Map(
              [...container.querySelectorAll("button")].map((button) => [
                button.textContent,
                () => {
                  button.click()
                },
              ]),
            ),
            escape: dispose,
          },
        )
      },
    }
    const ui = {
      Dialog: (props: {
        title: string
        size?: string
        footer?: JSX.Element
        children: JSX.Element
      }) => {
        const section = document.createElement("section")
        const heading = document.createElement("h2")
        heading.textContent = props.title
        section.append(heading, props.children as Node, props.footer as Node)
        return section
      },
      Button: (props: { onClick: () => void; children: JSX.Element }) => {
        const button = document.createElement("button")
        button.append(props.children as Node)
        button.addEventListener("click", props.onClick)
        return button
      },
    }
    const server = {
      builtin: true,
      data: {
        location: {
          model: {
            sync: async (ref?: unknown) => {
              if (this.options.catalogFails === true) throw new Error("catalog offline")
              const listed = await this.host.client.model.list(
                ref === undefined ? {} : { location: ref as { directory: string } },
              )
              this.catalog = listed.data
            },
            list: () => this.catalog,
          },
        },
      },
    }
    return {
      client: this.options.client ?? this.host.client,
      add: (registry: unknown, item: unknown) => {
        this.added.push({ registry, item })
      },
      toast: {
        show: (toast: { title: string; variant?: string }) => {
          this.toasts.push({ title: toast.title, variant: toast.variant })
        },
      },
      sessions: {
        current: () =>
          this.session === undefined
            ? undefined
            : {
                id: this.session.id,
                server: { builtin: this.session.builtin ?? true },
                location:
                  this.session.located === false ? undefined : { directory: this.host.project },
              },
      },
      servers: {
        list: () => (this.options.noServer === true ? [] : ["local"]),
        get: () => server,
      },
      dialogs,
      ui,
    }
  }
}

/**
 * The real client with a fault injected at the RPC seam: `intercept` sees each
 * Adaptive RPC call by method name and may answer for it or call through. The
 * server and the wire stay real for every call that is let through.
 */
export function interceptRpc(
  client: StartedHost["client"],
  intercept: (method: string, call: () => Promise<unknown>) => Promise<unknown>,
): StartedHost["client"] {
  return new Proxy(client, {
    get(target, property) {
      if (property !== "rpc") return Reflect.get(target, property) as unknown
      return (definition: never) => {
        const real = target.rpc(definition)
        return new Proxy(real, {
          get(rpcTarget, method) {
            const value: unknown = Reflect.get(rpcTarget, method)
            if (typeof method !== "string" || typeof value !== "function") return value
            return (...args: unknown[]) =>
              intercept(method, () => value.apply(rpcTarget, args) as Promise<unknown>)
          },
        })
      }
    },
  })
}

export interface CommandItem {
  id: string
  title: string
  slash?: { name: string }
  suggested?: boolean
  run: () => Promise<void>
}

export interface PageItem {
  id: string
  title: string
  entries: readonly { id: string; title: string; description?: string }[]
  render: () => JSX.Element
}

/** Mount a settings page body into the DOM; call `dispose` to unmount. */
export function mountPage(page: PageItem): { container: HTMLElement; dispose: () => void } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => page.render(), container)
  return { container, dispose }
}

/**
 * The built `dist/gui-experimental.cjs`, evaluated the way the app loads a
 * plugin GUI bundle: a CommonJS module whose shared dependencies the host
 * provides. They resolve to this process's own modules, so the bundle and the
 * test share one solid runtime.
 */
export async function loadBuiltBundle(): Promise<GuiPlugin> {
  const file = join(REPO_ROOT, "dist", "gui-experimental.cjs")
  if (!existsSync(file)) {
    throw new Error("dist/gui-experimental.cjs is missing - run `npm run build` first")
  }
  const shared: Record<string, unknown> = {
    "solid-js": await import("solid-js"),
    "solid-js/web": await import("solid-js/web"),
    "@opencode/plugin/gui": await import("@opencode/plugin/gui"),
    "@opencode/schema/rpc": await import("@opencode/schema/rpc"),
  }
  const load = (name: string): unknown => {
    const module = shared[name]
    if (module === undefined) throw new Error(`the bundle requires an unshared module: ${name}`)
    return module
  }
  const module = { exports: {} as { default?: GuiPlugin } }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- evaluating the CommonJS bundle is the test
  const evaluate = new Function("require", "module", "exports", readFileSync(file, "utf8")) as (
    ...args: unknown[]
  ) => void
  evaluate(load, module, module.exports)
  const plugin = module.exports.default
  if (plugin === undefined) throw new Error("the bundle has no default export")
  return plugin
}
