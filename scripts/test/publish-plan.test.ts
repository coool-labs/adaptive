// covers: ["ADP-050"]
import { describe, expect, it } from "vitest"
import { planPublish, publishActions } from "../publish/plan.js"

describe("planPublish", () => {
  it("derives the certification tag from the published manifest version", () => {
    expect(
      planPublish({ id: "pi", name: "@coool/pi-adaptive", version: "1.0.0", private: false }),
    ).toEqual({ id: "pi", name: "@coool/pi-adaptive", version: "1.0.0", tag: "pi-v1.0.0" })
    expect(
      planPublish({
        id: "opencode",
        name: "@coool/opencode-adaptive",
        version: "1.6.0",
        private: false,
      }),
    ).toEqual({
      id: "opencode",
      name: "@coool/opencode-adaptive",
      version: "1.6.0",
      tag: "opencode-v1.6.0",
    })
  })

  it("refuses to publish a private package", () => {
    expect(() =>
      planPublish({ id: "pi", name: "@coool/pi-adaptive", version: "0.0.0", private: true }),
    ).toThrow("publish: pi is private")
  })
})

describe("publishActions", () => {
  it("publishes, tags and pushes when nothing exists yet", () => {
    expect(publishActions({ published: false, localTag: "absent" }, "pi-v1.0.0")).toEqual([
      "publish",
      "tag",
      "pushTag",
    ])
  })

  it("only pushes when the release is already published and certified on HEAD", () => {
    expect(publishActions({ published: true, localTag: "on-head" }, "pi-v1.0.0")).toEqual([
      "pushTag",
    ])
  })

  it("certifies an already-published release that has no tag yet", () => {
    expect(publishActions({ published: true, localTag: "absent" }, "pi-v1.0.0")).toEqual([
      "tag",
      "pushTag",
    ])
  })

  it("republishes under an existing on-head tag so the tag survives the retry", () => {
    expect(publishActions({ published: false, localTag: "on-head" }, "pi-v1.0.0")).toEqual([
      "publish",
      "pushTag",
    ])
  })

  it("refuses to move a tag that points at a different commit", () => {
    expect(() => publishActions({ published: false, localTag: "detached" }, "pi-v1.0.0")).toThrow(
      "publish: pi-v1.0.0 points at a different commit",
    )
  })
})
