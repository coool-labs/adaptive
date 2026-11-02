import type { TierName } from "../../core/tier-policy/types.js"

/** Records the agent's tier declaration; false = not accepted. */
export type TierRequestRecorder = (sessionID: string, tier: TierName) => boolean

/**
 * The agent-declared tier tool: a typed sibling of adaptive_escalate. The
 * agent declares the tier of the task it is starting ("this task is quick")
 * and the declaration steers the session's next admissions until cleared —
 * one tier per task, not per unit. Plain JSON Schema: the host converts it,
 * and a Standard Schema vendor is silently dropped on 2.2.5.
 */
export function tierTool(record: TierRequestRecorder) {
  return {
    name: "adaptive_tier",
    description:
      "Declare the capability tier of the task you are starting: quick " +
      "(routine edits, mechanical steps), standard (the default), or " +
      "advanced (multi-step design, broad refactors, hard debugging). " +
      "The declaration stays in force for this session until you declare " +
      "a different tier. Only declare when the task's tier differs from " +
      "the default; never use this to work around unavailability.",
    input: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        tier: {
          description: "The tier the current task needs.",
          enum: ["quick", "standard", "advanced"],
        },
      },
      required: ["tier"],
      additionalProperties: false,
    } as const,
    options: { codemode: false } as const,
    execute: (
      input: unknown,
      context: { sessionID: string },
    ): Promise<{ content: { type: "text"; text: string }[] }> => {
      const tier = readTier(input)
      if (tier === null) {
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: "adaptive_tier rejected: tier must be quick, standard, or advanced.",
            },
          ],
        })
      }
      const accepted = record(context.sessionID, tier)
      if (!accepted) {
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: "adaptive_tier rejected: the tier request was not accepted.",
            },
          ],
        })
      }
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: `Tier request recorded: ${tier}. It steers this session's next admissions until cleared.`,
          },
        ],
      })
    },
  }
}

function readTier(input: unknown): TierName | null {
  if (typeof input !== "object" || input === null) return null
  const tier = (input as { tier?: unknown }).tier
  if (tier !== "quick" && tier !== "standard" && tier !== "advanced") return null
  return tier
}
