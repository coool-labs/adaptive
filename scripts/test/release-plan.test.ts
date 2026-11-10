import { expect, it } from "vitest"
import {
  changelogEntry,
  commitsSinceCreation,
  nextVersion,
  notesTemplate,
  parseBumpAnswer,
  parseGitLog,
  parseReleaseArgs,
  pendingBumps,
  planReleases,
  publishState,
  releaseCommitMessage,
  releaseCommits,
  releaseSummary,
  releaseTagPatterns,
  setLockVersion,
  setManifestVersion,
  stripNotes,
  taggedReleases,
  updateChangelog,
  type PlannedRelease,
  type ReleasePackage,
} from "../release/plan.js"

const OWN = { hash: "aaaaaaa1", subject: "supervisor: fix", shared: false }
const SHARED = { hash: "bbbbbbb2", subject: "health: fix", shared: true }

function pkg(overrides: Partial<ReleasePackage> = {}): ReleasePackage {
  return {
    id: "opencode",
    name: "@coool/opencode-adaptive",
    version: "1.5.0",
    private: false,
    commits: [OWN, SHARED],
    ...overrides,
  }
}

const RELEASE: PlannedRelease = {
  id: "opencode",
  name: "@coool/opencode-adaptive",
  previous: "1.5.0",
  version: "1.5.1",
  tag: "opencode-v1.5.1",
  commits: [OWN, SHARED],
}

it("parses release modes, bumps, skips, notes and confirmation", () => {
  expect(parseReleaseArgs([])).toEqual({
    mode: "release",
    bumps: {},
    skip: [],
    notes: {},
    yes: false,
  })
  expect(
    parseReleaseArgs([
      "--dry-run",
      "--opencode",
      "minor",
      "--pi",
      "skip",
      "--notes",
      "opencode=notes.md",
      "--yes",
    ]),
  ).toEqual({
    mode: "dry-run",
    bumps: { opencode: "minor" },
    skip: ["pi"],
    notes: { opencode: "notes.md" },
    yes: true,
  })
  expect(parseReleaseArgs(["--resume"]).mode).toBe("resume")
  expect(parseReleaseArgs(["--status"]).mode).toBe("status")
})

it("rejects malformed release arguments with the offending flag named", () => {
  expect(() => parseReleaseArgs(["--status", "--resume"])).toThrow(
    "Use only one of --dry-run, --resume, --status",
  )
  expect(() => parseReleaseArgs(["--notes"])).toThrow("received nothing")
  expect(() => parseReleaseArgs(["--notes", "opencode"])).toThrow("received opencode")
  expect(() => parseReleaseArgs(["--notes", "core=x.md"])).toThrow("received core=x.md")
  expect(() => parseReleaseArgs(["--notes", "pi="])).toThrow("received pi=")
  expect(() => parseReleaseArgs(["--pi"])).toThrow(
    "--pi: expected patch, minor, major or skip, received nothing",
  )
  expect(() => parseReleaseArgs(["--pi", "huge"])).toThrow("received huge")
  expect(() => parseReleaseArgs(["--core", "patch"])).toThrow("Unknown argument: --core")
  expect(() => parseReleaseArgs(["publish"])).toThrow("Unknown argument: publish")
  expect(() => parseReleaseArgs(["--pi", "skip", "--pi", "patch"])).toThrow(
    "--pi: given both a bump and skip",
  )
})

it("bumps stable semver and resets lower parts", () => {
  expect(nextVersion("1.5.3", "patch")).toBe("1.5.4")
  expect(nextVersion("1.5.3", "minor")).toBe("1.6.0")
  expect(nextVersion("1.5.3", "major")).toBe("2.0.0")
  expect(nextVersion("0.0.0", "minor")).toBe("0.1.0")
  expect(() => nextVersion("1.5.0-beta.1", "patch")).toThrow("expected stable semver")
  expect(() => nextVersion("01.0.0", "patch")).toThrow("expected stable semver")
  // Even a part the bump resets must be representable: the source version is corrupt.
  expect(() => nextVersion("1.9007199254740991.0", "major")).toThrow("exceeds safe integer range")
})

it("parses git log records and keeps only commits that change what a plugin publishes", () => {
  const log = [
    "",
    "aaaaaaa1\u001fsupervisor: fix\npackages/opencode/src/a.ts\n\n",
    "bbbbbbb2\u001fhealth: fix\npackages/core/src/b.ts\npackages/opencode/src/c.ts\n",
    "ccccccc3\u001fdocs: plan\ndocs/plans/x.md\n",
    "ddddddd4\u001ftestkit: fixture\npackages/testkit/src/d.ts\n",
    "eeeeeee5\u001fpi: start\npackages/pi/src/e.ts\n",
  ].join("\u001e")
  const commits = parseGitLog(log)
  expect(commits[0]).toEqual({
    hash: "aaaaaaa1",
    subject: "supervisor: fix",
    paths: ["packages/opencode/src/a.ts"],
  })
  expect(releaseCommits(commits, "opencode")).toEqual([
    OWN,
    SHARED,
    { hash: "ddddddd4", subject: "testkit: fixture", shared: true },
  ])
  expect(releaseCommits(commits, "pi").map((commit) => commit.hash)).toEqual([
    "bbbbbbb2",
    "ddddddd4",
    "eeeeeee5",
  ])
  expect(() => parseGitLog("\u001enot-a-hash\u001fsubject\n")).toThrow(
    "git log: malformed commit record: not-a-hash\u001fsubject",
  )
  expect(() => parseGitLog("\u001e\n")).not.toThrow()
  expect(() => parseGitLog("\u001e\u001fsubject")).toThrow("malformed")
})

it("counts a never-released package back to the commit that created it", () => {
  const commits = parseGitLog(
    "\u001eaaaaaaa1\u001fnew\n\u001ebbbbbbb2\u001fcreate\n\u001eccccccc3\u001fold\n",
  )
  expect(commitsSinceCreation(commits, "bbbbbbb2").map((commit) => commit.hash)).toEqual([
    "aaaaaaa1",
    "bbbbbbb2",
  ])
  expect(() => commitsSinceCreation(commits, "fffffff9")).toThrow(
    "git log: creation commit fffffff9 is not in the history",
  )
})

it("asks only for changed, publishable, unskipped packages", () => {
  const packages = [pkg(), pkg({ id: "pi", name: "@coool/pi-adaptive", version: "0.0.0" })]
  expect([...pendingBumps(packages, { bumps: {}, skip: [], yes: false })]).toEqual([
    ["opencode", undefined],
    ["pi", undefined],
  ])
  expect([...pendingBumps(packages, { bumps: { pi: "minor" }, skip: [], yes: true })]).toEqual([
    ["opencode", "patch"],
    ["pi", "minor"],
  ])
  expect([
    ...pendingBumps([pkg({ private: true }), pkg({ id: "pi", commits: [] })], {
      bumps: {},
      skip: [],
      yes: true,
    }),
  ]).toEqual([])
  expect([...pendingBumps(packages, { bumps: {}, skip: ["opencode"], yes: true })]).toEqual([
    ["pi", "patch"],
  ])
})

it("reads interactive bump answers, defaulting to patch", () => {
  expect(parseBumpAnswer("")).toBe("patch")
  expect(parseBumpAnswer("  Minor \n")).toBe("minor")
  expect(parseBumpAnswer("skip")).toBe("skip")
  expect(() => parseBumpAnswer("yes")).toThrow("received yes")
})

it("finds publish tags, with the legacy v* family anchoring OpenCode history", () => {
  expect(releaseTagPatterns("opencode")).toEqual(["opencode-v*", "v*"])
  expect(releaseTagPatterns("pi")).toEqual(["pi-v*"])
})

it("plans releases only for selected publishable packages with changes", () => {
  const packages = [
    pkg(),
    pkg({ id: "pi", name: "@coool/pi-adaptive", version: "0.0.0", commits: [SHARED] }),
  ]
  expect(planReleases(packages, { opencode: "patch", pi: "minor" })).toEqual([
    RELEASE,
    {
      id: "pi",
      name: "@coool/pi-adaptive",
      previous: "0.0.0",
      version: "0.1.0",
      tag: "pi-v0.1.0",
      commits: [SHARED],
    },
  ])
  expect(planReleases(packages, {})).toEqual([])
  expect(() => planReleases([pkg({ private: true })], { opencode: "patch" })).toThrow(
    "release: opencode is not a publishable package",
  )
  expect(() => planReleases([pkg()], { pi: "patch" })).toThrow("pi is not a publishable package")
  expect(() => planReleases([pkg({ commits: [] })], { opencode: "patch" })).toThrow(
    "release: opencode has no changes since its last release",
  )
})

it("summarises each package for the release table", () => {
  expect(releaseSummary(pkg())).toBe("opencode-adaptive   1.5.0 → ?  2 commits (1 in shared core)")
  expect(releaseSummary(pkg({ commits: [OWN] }))).toBe(
    "opencode-adaptive   1.5.0 → ?  1 commit (0 in shared core)",
  )
  expect(releaseSummary(pkg({ commits: [] }))).toBe("opencode-adaptive   1.5.0  unchanged")
})

it("offers a notes template whose guidance is stripped before use", () => {
  const template = notesTemplate(RELEASE)
  expect(template).toContain("opencode-v1.5.1")
  expect(template).toContain("  aaaaaaa supervisor: fix")
  expect(template.endsWith("-->\n")).toBe(true)
  expect(stripNotes(template)).toBe("")
  expect(stripNotes(`${template}\n### Fixed\n\n- Parked runs wake once.\n`)).toBe(
    "### Fixed\n\n- Parked runs wake once.",
  )
})

it("refuses notes that still hold an unterminated guidance comment", () => {
  expect(() => stripNotes("### Fixed\n\n<!-- Release notes for pi-v1.0.0.\n- fix")).toThrow(
    "notes: unterminated <!-- comment",
  )
  expect(stripNotes("<!-- a --> kept <!-- b -->")).toBe("kept")
})

it("writes a changelog entry listing shared core changes", () => {
  expect(changelogEntry(RELEASE, "2026-11-08", " ### Fixed\n\n- A fix. \n")).toBe(
    "## [1.5.1] — 2026-11-08\n\n### Fixed\n\n- A fix.\n\n### Shared core\n\n- health: fix (bbbbbbb)",
  )
  expect(changelogEntry({ ...RELEASE, commits: [OWN] }, "2026-11-08", "Notes")).toBe(
    "## [1.5.1] — 2026-11-08\n\nNotes",
  )
  expect(() => changelogEntry(RELEASE, "8 Nov", "Notes")).toThrow("date: expected YYYY-MM-DD")
  expect(() => changelogEntry(RELEASE, "2026-11-08", "  \n")).toThrow(
    "notes: summary required for opencode-v1.5.1",
  )
})

it("inserts the entry under a fresh Unreleased heading and links the tag", () => {
  const link = "[1.5.1]: https://github.com/coool-labs/adaptive/releases/tag/opencode-v1.5.1"
  const existing = [
    "# Changelog",
    "",
    "Notable changes.",
    "",
    "## [Unreleased]",
    "",
    "## [1.5.0] — 2026-11-07",
    "",
    "- Old.",
    "",
    "[1.2.3]: https://example.test/v1.2.3",
    "",
  ].join("\n")
  expect(updateChangelog(existing, RELEASE, "## [1.5.1] — 2026-11-08\n\nNew.")).toBe(
    [
      "# Changelog",
      "",
      "Notable changes.",
      "",
      "## [Unreleased]",
      "",
      "## [1.5.1] — 2026-11-08",
      "",
      "New.",
      "",
      "## [1.5.0] — 2026-11-07",
      "",
      "- Old.",
      "",
      link,
      "[1.2.3]: https://example.test/v1.2.3",
      "",
    ].join("\n"),
  )
  expect(updateChangelog("# Changelog\n", RELEASE, "## [1.5.1] — 2026-11-08\n\nNew.")).toBe(
    `# Changelog\n\n## [Unreleased]\n\n## [1.5.1] — 2026-11-08\n\nNew.\n\n${link}\n`,
  )
})

it("rewrites manifest and lockfile versions without touching other fields", () => {
  expect(setManifestVersion('{"name":"x","version":"1.5.0","private":false}', "1.5.1")).toBe(
    '{\n  "name": "x",\n  "version": "1.5.1",\n  "private": false\n}\n',
  )
  expect(() => setManifestVersion('{"name":"x"}', "1.5.1")).toThrow(
    "package.json: version is missing",
  )
  expect(() => setManifestVersion("[]", "1.5.1")).toThrow("package.json: expected a JSON object")
  expect(() => setManifestVersion("null", "1.5.1")).toThrow("expected a JSON object")

  const lock = JSON.stringify({
    packages: { "": { name: "adaptive" }, "packages/opencode": { version: "1.5.0", x: 1 } },
  })
  expect(JSON.parse(setLockVersion(lock, "packages/opencode", "1.5.1"))).toEqual({
    packages: { "": { name: "adaptive" }, "packages/opencode": { version: "1.5.1", x: 1 } },
  })
  expect(() => setLockVersion(lock, "packages/pi", "0.1.0")).toThrow(
    "package-lock.json: packages.packages/pi is missing",
  )
  expect(() => setLockVersion('{"packages":[]}', "packages/pi", "0.1.0")).toThrow(
    "packages.packages/pi is missing",
  )
})

it("names the release commit after its tags and maps tags back to packages", () => {
  expect(releaseCommitMessage([RELEASE, { ...RELEASE, tag: "pi-v0.1.0" }])).toBe(
    "release: opencode-v1.5.1 pi-v0.1.0",
  )
  const packages = [pkg(), pkg({ id: "pi", name: "@coool/pi-adaptive" })]
  expect(taggedReleases(["v1.5.0", "opencode-v1.5.1", "pi-v0.1.0"], packages)).toEqual([
    {
      id: "opencode",
      name: "@coool/opencode-adaptive",
      version: "1.5.1",
      tag: "opencode-v1.5.1",
    },
    { id: "pi", name: "@coool/pi-adaptive", version: "0.1.0", tag: "pi-v0.1.0" },
  ])
})

it("maps legacy name-at-version tags back to packages during the transition", () => {
  const packages = [pkg(), pkg({ id: "pi", name: "@coool/pi-adaptive" })]
  expect(taggedReleases(["opencode-adaptive@1.5.1", "pi-adaptive@0.1.0"], packages)).toEqual([
    {
      id: "opencode",
      name: "@coool/opencode-adaptive",
      version: "1.5.1",
      tag: "opencode-adaptive@1.5.1",
    },
    { id: "pi", name: "@coool/pi-adaptive", version: "0.1.0", tag: "pi-adaptive@0.1.0" },
  ])
})

it("leaves tokens that belong to no package unmapped", () => {
  expect(taggedReleases(["v1.5.0", "chore"], [pkg()])).toEqual([])
})

it("does not map a release tag without a stable version, so a resume refuses it", () => {
  const packages = [pkg(), pkg({ id: "pi", name: "@coool/pi-adaptive" })]
  expect(
    taggedReleases(["pi-v", "opencode-v1.5", "pi-v1.0.0-rc.1", "opencode-adaptive@"], packages),
  ).toEqual([])
})

it("distinguishes published, missing and failed npm lookups", () => {
  expect(publishState({ status: 0, stderr: "" })).toBe("published")
  expect(publishState({ status: 1, stderr: "npm error code E404\n" })).toBe("missing")
  expect(() => publishState({ status: 1, stderr: "npm error code ENOTFOUND\n" })).toThrow(
    "npm view failed: npm error code ENOTFOUND",
  )
  expect(() => publishState({ status: null, stderr: "" })).toThrow("npm view failed: exit null")
})
