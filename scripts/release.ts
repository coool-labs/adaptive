// covers: ["ADP-050"]
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { executeRelease } from "./release/execute.js"
import {
  PLUGINS,
  changelogEntry,
  commitsSinceCreation,
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
  requireNotes,
  tagName,
  setLockVersion,
  setManifestVersion,
  stripNotes,
  taggedReleases,
  updateChangelog,
  type Bump,
  type Plugin,
  type ReleasePackage,
} from "./release/plan.js"

function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: failed`)
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function packages(): ReleasePackage[] {
  return PLUGINS.flatMap((id) => {
    const file = `packages/${id}/package.json`
    if (!existsSync(file)) return []
    const manifest: unknown = JSON.parse(readFileSync(file, "utf8"))
    const name = property(manifest, "name")
    const version = property(manifest, "version")
    if (typeof name !== "string" || typeof version !== "string") {
      throw new Error(`${file}: name and version must be strings`)
    }
    if (property(manifest, "private") === true)
      return [{ id, name, version, private: true, commits: [] }]
    const patterns = releaseTagPatterns(id).flatMap((pattern) => ["--match", pattern])
    const tag = spawnSync("git", ["describe", "--tags", "--abbrev=0", ...patterns], {
      encoding: "utf8",
    })
    if (tag.error !== undefined) throw tag.error
    if (tag.status !== 0 && !/No names found|No tags can describe/.test(tag.stderr)) {
      throw new Error(`git describe: ${tag.stderr.trim()}`)
    }
    let commits = parseGitLog(
      capture("git", [
        "log",
        "--format=%x1e%H%x1f%s",
        "--name-only",
        ...(tag.status === 0 ? [`${tag.stdout.trim()}..HEAD`] : []),
      ]),
    )
    if (tag.status !== 0) {
      const creation = capture("git", ["log", "--diff-filter=A", "--format=%H", "--", file])
        .split("\n")
        .at(-1)
      if (!creation)
        throw new Error(`${file}: no creation commit; commit the package before releasing`)
      commits = commitsSinceCreation(commits, creation)
    }
    return [
      {
        id,
        name,
        version,
        private: property(manifest, "private") === true,
        commits: releaseCommits(commits, id),
      },
    ]
  })
}

function requireReleaseEnvironment(publish: boolean): void {
  if (capture("git", ["status", "--porcelain"]).length !== 0)
    throw new Error("release: working tree must be clean")
  if (capture("git", ["branch", "--show-current"]) !== "main")
    throw new Error("release: switch to main first")
  // Registry auth is only needed by the publication leg (resume, publish
  // scripts); the release itself stops before the registry, so an agent shell
  // without npm credentials still works.
  if (publish) {
    capture("npm", ["whoami"])
  }
}

function verify(ids: readonly Plugin[]): void {
  run("npm", ["run", "verify", "--", ...ids.flatMap((id) => ["--pkg", id])])
}

function publishPackages(ids: readonly Plugin[]): void {
  for (const id of ids)
    run("npm", ["publish", "--workspace", `packages/${id}`, "--access", "public"])
}

async function main(): Promise<void> {
  const root = capture("git", ["rev-parse", "--show-toplevel"])
  process.chdir(root)
  const options = parseReleaseArgs(process.argv.slice(2))
  const inventory = packages()
  for (const pkg of inventory.filter((pkg) => !pkg.private)) console.log(releaseSummary(pkg))
  if (options.mode === "status") return

  if (options.mode === "resume") {
    requireReleaseEnvironment(true)
    const subject = capture("git", ["log", "-1", "--format=%s"])
    if (!subject.startsWith("release: ")) throw new Error("release: HEAD is not a release commit")
    const expected = subject.slice("release: ".length).split(" ")
    const tagged = taggedReleases(expected, inventory)
    if (tagged.length === 0 || tagged.length !== expected.length)
      throw new Error("release: HEAD has invalid package release tags")
    for (const release of tagged) {
      const pkg = inventory.find((pkg) => pkg.id === release.id)
      if (pkg?.version !== release.version || pkg.private)
        throw new Error(
          `release: ${release.name}@${release.version} does not match a publishable manifest`,
        )
    }
    // Rebuild and certify the exact release tree, never publish stale local dist files.
    verify(tagged.map((release) => release.id))
    const missing = tagged.filter((release) => {
      const result = spawnSync("npm", ["view", `${release.name}@${release.version}`, "version"], {
        encoding: "utf8",
      })
      if (result.error !== undefined) throw result.error
      return publishState(result) === "missing"
    })
    publishPackages(missing.map((release) => release.id))
    // Certify each release with its post-publication tag, then push it.
    for (const release of tagged) {
      const tag = tagName(release.id, release.version)
      const existingTags = capture("git", ["tag", "--list"]).split("\n")
      if (existingTags.includes(tag)) {
        if (
          capture("git", ["rev-parse", `${tag}^{commit}`]) !== capture("git", ["rev-parse", "HEAD"])
        ) {
          throw new Error(`release: ${tag} points to a different commit`)
        }
      } else run("git", ["tag", "-a", tag, "-m", tag])
      run("git", ["push", "origin", tag])
    }
    return
  }

  const dry = options.mode === "dry-run"
  if (!dry) requireReleaseEnvironment(false)
  const bumps: Partial<Record<Plugin, Bump>> = { ...options.bumps }
  const pending = pendingBumps(inventory, { ...options, yes: dry || options.yes })
  for (const [id, bump] of pending) {
    if (bump !== undefined) bumps[id] = bump
    else {
      if (!process.stdin.isTTY)
        throw new Error("release: pass explicit bumps or --yes in non-interactive mode")
      const input = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = parseBumpAnswer(
          await input.question(`${id}: patch / minor / major / skip [patch]: `),
        )
        if (answer !== "skip") bumps[id] = answer
      } finally {
        input.close()
      }
    }
  }
  const plan = planReleases(inventory, bumps)
  if (plan.length === 0) {
    console.log("release: nothing to release")
    return
  }
  if (!dry) {
    const terminal = process.stdin.isTTY && process.stdout.isTTY
    requireNotes(plan, options.notes, terminal && !options.yes)
  }
  const generated = new Map<string, string>()
  let lock = readFileSync("package-lock.json", "utf8")
  for (const release of plan) {
    const supplied = options.notes[release.id]
    const saved = `test-artifacts/release/notes-${release.id}.md`
    let notes: string
    if (supplied !== undefined) notes = stripNotes(readFileSync(resolve(supplied), "utf8"))
    else if (dry) notes = "### Changed\n\nRelease summary will be supplied before publishing."
    else {
      mkdirSync("test-artifacts/release", { recursive: true })
      if (!existsSync(saved)) writeFileSync(saved, notesTemplate(release))
      const result = spawnSync("nano", [resolve(saved)], { stdio: "inherit" })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0) throw new Error(`release: nano failed; draft: ${saved}`)
      notes = stripNotes(readFileSync(saved, "utf8"))
    }
    const entry = changelogEntry(release, new Date().toISOString().slice(0, 10), notes)
    console.log(`\n${release.name}: ${release.previous} → ${release.version}\n${entry}`)
    const directory = `packages/${release.id}`
    const manifest = `${directory}/package.json`
    const changelog = `${directory}/CHANGELOG.md`
    generated.set(manifest, setManifestVersion(readFileSync(manifest, "utf8"), release.version))
    generated.set(changelog, updateChangelog(readFileSync(changelog, "utf8"), release, entry))
    lock = setLockVersion(lock, directory, release.version)
    if (!dry) {
      mkdirSync("test-artifacts/release", { recursive: true })
      writeFileSync(saved, `${notes}\n`)
    }
  }
  if (dry) {
    console.log("release: dry-run complete; no files, tags or registry changes")
    return
  }
  generated.set("package-lock.json", lock)
  const originals = new Map([...generated.keys()].map((file) => [file, readFileSync(file, "utf8")]))
  requireReleaseEnvironment(false)
  executeRelease(plan, {
    prepare() {
      for (const [file, text] of generated) writeFileSync(file, text)
      run("npm", ["exec", "--", "prettier", "--write", ...generated.keys()])
    },
    verify,
    restore() {
      for (const [file, text] of originals) writeFileSync(file, text)
    },
    commit() {
      run("git", ["add", "--", ...generated.keys()])
      run("git", ["commit", "-m", releaseCommitMessage(plan)])
    },
    discardCommit() {
      const subject = capture("git", ["log", "-1", "--format=%s"])
      if (subject !== releaseCommitMessage(plan))
        throw new Error("release: HEAD is not the release commit; refusing to discard")
      run("git", ["reset", "--hard", "HEAD~1"])
    },
    push() {
      run("git", ["push"])
    },
  })
  console.log("release: committed and pushed; publish and tag with:")
  for (const release of plan) console.log(`  npm run publish:${release.id}`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
