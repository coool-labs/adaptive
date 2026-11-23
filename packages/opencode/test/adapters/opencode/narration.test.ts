// covers: ["ADP-031", "ADP-052"]
import { describe, expect, it } from "vitest"
import {
  SUBAGENT_NOTE,
  SUBAGENT_NOTE_KEY,
  modelLabel,
  parentNarration,
} from "../../../src/adapters/opencode/narration.js"

interface Put {
  sessionID: string
  key: string
  value: string
}

interface Said {
  sessionID: string
  text: string
  description: string
  resume: boolean
}

function fakeSession(): {
  puts: Put[]
  said: Said[]
  session: Parameters<typeof parentNarration>[0]
} {
  const puts: Put[] = []
  const said: Said[] = []
  return {
    puts,
    said,
    session: {
      instructions: {
        entry: {
          put: (input: Put) => {
            puts.push(input)
            return Promise.resolve()
          },
        },
      },
      synthetic: (input: Said) => {
        said.push(input)
        return Promise.resolve({})
      },
    },
  }
}

describe("modelLabel", () => {
  it("renders the provider, model and variant", () => {
    expect(modelLabel({ providerID: "prov", id: "a", variant: "high" })).toBe("prov/a#high")
  })

  it("omits the variant when the model has none", () => {
    expect(modelLabel({ providerID: "prov", id: "a" })).toBe("prov/a")
  })
})

describe("parentNarration", () => {
  it("installs one keyed instruction in the parent", async () => {
    const fake = fakeSession()
    await parentNarration(fake.session).instruct("p1")
    expect(fake.puts).toEqual([{ sessionID: "p1", key: SUBAGENT_NOTE_KEY, value: SUBAGENT_NOTE }])
    expect(fake.said).toEqual([])
  })

  it("announces a resumed child without waking the parent", async () => {
    const fake = fakeSession()
    await parentNarration(fake.session).resumed("p1", {
      providerID: "prov",
      id: "b",
      variant: "high",
    })
    expect(fake.said).toEqual([
      {
        sessionID: "p1",
        text: "A subagent hit an availability limit and was resumed on prov/b#high. It is still working; its report will arrive when it finishes.",
        description: "Subagent resumed",
        resume: false,
      },
    ])
    expect(fake.puts).toEqual([])
  })
})
