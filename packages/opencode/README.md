# @coool/opencode-adaptive

[![npm downloads](https://img.shields.io/npm/dm/@coool/opencode-adaptive)](https://www.npmjs.com/package/@coool/opencode-adaptive)

Automatic model fallback and routing for [OpenCode](https://opencode.ai).

You list your models in order of preference. Adaptive runs each task on the first one that works. When a model hits a quota, rate limit or outage, work moves to the next one. When the preferred model is back, it is used again.

It is set up entirely from the `/adaptive` menu in OpenCode. There are no config files to edit and no model IDs to type.

## What you can do with it

**Use subscriptions first, pay-as-you-go second.** Put your subscription models at the top of the list and an API provider such as OpenRouter at the bottom. You get the most out of what you already pay for. The API only takes over when the subscriptions are out of quota, and the subscriptions are used again as soon as they reset.

**Use cheap models for small work.** Keep separate lists for quick, standard and advanced work. Typo fixes don't need your strongest model.

**Leave long runs unattended.** If a model fails mid-task, work continues on the next ready model in the tier, and the preferred model is used again at the next task — finished tool calls are not repeated, even across an OpenCode restart. A `/goal` run is a series of tasks, so it carries on by itself.

## Features

- **Menu setup.** Models, order and mode are set in `/adaptive` with model search. No config files.
- **Tiers.** Quick, standard and advanced work each get their own list, and a failure stays inside the tier the work needs. The agent can ask for a tier with the `adaptive_tier` tool. Routing follows fixed rules, not a prompt the model may or may not obey.
- **Quota awareness.** It reads usage from provider response headers. When a subscription is nearly used up (about 10% left), new tasks go to the next ready model in the tier, and it is used again after the reset time when the provider reports one.
- **Recovery that survives a restart.** If work is interrupted and cannot continue right away because no model in its tier is ready, it is saved and resumes by itself when the first one returns (for example when a quota resets), without a new prompt and without repeating finished tool calls — even after an OpenCode restart. Meanwhile the footer shows `Adaptive · waiting · resumes 18:42`.
- **Dry run.** In `observe` mode it records what it would have done, with the reason, before it changes anything. A session can have its own mode.
- **Escalation on evidence only.** An outage never sends work to a more expensive tier. Moving up needs a context overflow, a policy rejection, or an explicit request from the agent.

## Install

```sh
opencode plugin add @coool/opencode-adaptive
```

Needs OpenCode 2.2.1 or newer.

## Set up

1. Start OpenCode and run `/adaptive`.
2. Open **Models**, pick a tier, and choose **Add model…**. Search for a model and select it. Repeat, best first. If the tier a task needs is empty, OpenCode's own model runs it.
3. Open **Mode** and choose `active`.

New installs start in `observe` mode: Adaptive records what it would do but changes nothing. Look at **Receipts** to check its decisions, then switch to `active`.

| Mode      | What happens                                                           |
| --------- | ---------------------------------------------------------------------- |
| `off`     | Nothing.                                                               |
| `observe` | Decisions are recorded, not applied. This is the default.              |
| `active`  | Decisions are applied. A task changes model only when its model fails. |

Any session can override the global mode: open `/adaptive` inside the session and choose **This session…**.

To reorder or remove a model, select it in the tier list. **Status** shows each model's state, including subscription usage (`used 72%, resets 18:42`) when the provider reports it.

## Tiers

A tier is an ordered list of models. The order is your policy, and Adaptive never changes it.

- **Quick** for small, mechanical work.
- **Standard** for everything else. This is the default.
- **Advanced** for hard work.

A model can be in more than one tier.

The tier for a task is the first of these that applies:

1. A pinned model (`/adaptive` → **Pin**).
2. A tier request for the session: the agent can declare one with the `adaptive_tier` tool, or you set it inside a session with `/adaptive` → **Tier**.
3. A per-agent tier from the `agentTiers` setting (RPC only).
4. `standard`.

Background requests such as titles and summaries are observed but not routed separately in v1 — they keep OpenCode's own model.

No language model or keyword matching is involved. A model is skipped if it is unknown or can't fit the context, and the receipt says why. Adaptive only uses models you added.

## When a model fails

- **Rate limit, quota, timeout, outage:** if the error is clear-cut and another model in the same tier is ready, the task switches to it and carries on from the current session. Your prompt is not resent and finished tool calls are not repeated. If the error is unclear or no other model is ready, OpenCode's normal retry continues.
- **A model fails repeatedly:** it is paused for a cooldown, then tried once. If that works, it is back.
- **Every model in the tier is blocked as a task starts:** OpenCode's own model runs it, and the decision is recorded as a receipt with the reason. A task that fails to recover is saved and resumes when a model returns.
- **Every model in the tier runs out of quota mid-task:** the task waits, and continues on whichever model resets first. The footer chip (and the GUI composer pill) says when. Sending your own prompt or picking a model yourself ends the wait.
- **You cancel:** nothing is retried or switched.
- **Auth error or unknown model:** the model is marked unavailable and skipped.

An outage never moves work to a stronger tier. Work only moves up on real evidence: a context overflow, a content-policy rejection, or the agent calling `adaptive_escalate` with a reason and evidence. This happens at most twice per task.

## Limits

- No borrowing between tiers. If a tier is exhausted, the task runs on OpenCode's own model rather than another tier's models. To let a model serve two tiers, add it to both.
- A task that moved up a tier stays there. The next task is routed again from scratch.
- Usage figures come from response headers and are best effort. Providers that use WebSockets don't expose them.
- The browser/desktop settings page is experimental. No released OpenCode loads it yet, so use `/adaptive`.
- In the web UI (including on mobile) type `/web-adaptive` for the mode and model status, or `/web-adaptive on`, `off`, `observe`, `active` to switch the mode. It is a server command, which the web app lists in the composer's slash menu.

## Troubleshooting

- **Nothing changes.** You are in `observe` mode. Switch to `active` in `/adaptive` → **Mode**.
- **A model is never picked.** Its provider must be connected in OpenCode.
- **Receipts show `park` on a new task.** Every model in its tier was blocked when the task started, so it ran on OpenCode's own model. The receipt says why; check `/adaptive` → **Status** for cooldowns.
- **Why did it pick that model?** `/adaptive` → **Receipts**.
- **"Plugin failed" toast.** The plugin didn't load. Update it with `opencode plugin update`, or remove and add it again.

## Privacy

Nothing leaves your machine. No telemetry, no network calls of its own, no secrets in settings, receipts or logs. Receipts keep the newest 200 entries and are never added to prompts.
