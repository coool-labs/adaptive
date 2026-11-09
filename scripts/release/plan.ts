// covers: ["ADP-050"]
export type Bump = "patch" | "minor" | "major"
export type Plugin = "opencode" | "pi"
export type ReleaseMode = "release" | "dry-run" | "resume" | "status"

export const PLUGINS: readonly Plugin[] = ["opencode", "pi"]
const BUMPS: readonly Bump[] = ["patch", "minor", "major"]
const BUMP_POSITION: Readonly<Record<Bump, number>> = { major: 0, minor: 1, patch: 2 }
const MODE_FLAGS = new Map<string, ReleaseMode>([
  ["--dry-run", "dry-run"],
  ["--resume", "resume"],
  ["--status", "status"],
])
const SHARED_DIRECTORIES = ["packages/core/", "packages/testkit/"]

export interface LoggedCommit {
  hash: string
  subject: string
  paths: readonly string[]
}

export interface ReleaseCommit {
  hash: string
  subject: string
  shared: boolean
}

export interface ReleasePackage {
  id: Plugin
  name: string
  version: string
  private: boolean
  commits: readonly ReleaseCommit[]
}

export interface PlannedRelease {
  id: Plugin
  name: string
  previous: string
  version: string
  tag: string
  commits: readonly ReleaseCommit[]
}

export interface ReleaseOptions {
  mode: ReleaseMode
  bumps: Partial<Record<Plugin, Bump>>
  skip: readonly Plugin[]
  notes: Partial<Record<Plugin, string>>
  yes: boolean
}

function isPlugin(value: string): value is Plugin {
  return PLUGINS.some((plugin) => plugin === value)
}

function isBump(value: string): value is Bump {
  return BUMPS.some((bump) => bump === value)
}

export function parseReleaseArgs(args: readonly string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    mode: "release",
    bumps: {},
    skip: [],
    notes: {},
    yes: false,
  }
  const skip = new Set<Plugin>()
  const modes = new Set<ReleaseMode>()
  // Flags that take a value pull it from the same iterator the loop consumes.
  const iterator = args[Symbol.iterator]()
  for (const arg of iterator) {
    const mode = MODE_FLAGS.get(arg)
    const plugin = arg.startsWith("--") ? arg.slice(2) : ""
    if (arg === "--yes") {
      options.yes = true
    } else if (mode !== undefined) {
      modes.add(mode)
    } else if (arg === "--notes") {
      const value = iterator.next().value ?? ""
      const separator = value.indexOf("=")
      const target = value.slice(0, separator)
      const file = value.slice(separator + 1)
      if (separator < 0 || !isPlugin(target) || file.length === 0) {
        throw new Error(`--notes: expected <opencode|pi>=<file>, received ${value || "nothing"}`)
      }
      options.notes[target] = file
    } else if (isPlugin(plugin)) {
      const value = iterator.next().value ?? ""
      if (value === "skip") skip.add(plugin)
      else if (isBump(value)) options.bumps[plugin] = value
      else
        throw new Error(
          `${arg}: expected patch, minor, major or skip, received ${value || "nothing"}`,
        )
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (modes.size > 1) throw new Error("Use only one of --dry-run, --resume, --status")
  const [selected] = modes
  if (selected !== undefined) options.mode = selected
  options.skip = [...skip]
  for (const plugin of skip) {
    if (options.bumps[plugin] !== undefined)
      throw new Error(`--${plugin}: given both a bump and skip`)
  }
  return options
}

export function nextVersion(version: string, bump: Bump): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`version: expected stable semver, received ${version}`)
  }
  const parts = version.split(".").map(Number)
  if (!parts.every((part) => Number.isSafeInteger(part + 1))) {
    throw new Error(`version: exceeds safe integer range: ${version}`)
  }
  const target = BUMP_POSITION[bump]
  return parts
    .map((part, position) => {
      if (position < target) return part
      if (position === target) return part + 1
      return 0
    })
    .join(".")
}

/** Parses `git log --format=%x1e%H%x1f%s --name-only` output. */
export function parseGitLog(output: string): LoggedCommit[] {
  return output
    .split("\u001e")
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [header = "", ...paths] = record.split("\n")
      const [hash = "", subject = ""] = header.split("\u001f")
      if (!/^[0-9a-f]{7,64}$/.test(hash))
        throw new Error(`git log: malformed commit record: ${header}`)
      return { hash, subject, paths: paths.filter((path) => path.length > 0) }
    })
}

/** Commits that change what a plugin publishes: its own directory or the bundled workspaces. */
export function releaseCommits(commits: readonly LoggedCommit[], id: Plugin): ReleaseCommit[] {
  const own = `packages/${id}/`
  return commits.flatMap((commit) => {
    const shared = commit.paths.some((path) =>
      SHARED_DIRECTORIES.some((dir) => path.startsWith(dir)),
    )
    if (!(shared || commit.paths.some((path) => path.startsWith(own)))) return []
    return [{ hash: commit.hash, subject: commit.subject, shared }]
  })
}

/** A never-released package counts commits back to (and including) the one that created it. */
export function commitsSinceCreation(
  commits: readonly LoggedCommit[],
  creation: string,
): LoggedCommit[] {
  const index = commits.findIndex((commit) => commit.hash === creation)
  if (index < 0) throw new Error(`git log: creation commit ${creation} is not in the history`)
  return commits.slice(0, index + 1)
}

/** Bumps for every changed, publishable, unskipped package; `undefined` means ask. */
export function pendingBumps(
  packages: readonly ReleasePackage[],
  options: Pick<ReleaseOptions, "bumps" | "skip" | "yes">,
): Map<Plugin, Bump | undefined> {
  const pending = new Map<Plugin, Bump | undefined>()
  for (const pkg of packages) {
    if (pkg.private || pkg.commits.length === 0 || options.skip.includes(pkg.id)) continue
    pending.set(pkg.id, options.bumps[pkg.id] ?? (options.yes ? "patch" : undefined))
  }
  return pending
}

export function parseBumpAnswer(answer: string): Bump | "skip" {
  const value = answer.trim().toLowerCase()
  if (value === "") return "patch"
  if (value === "skip" || isBump(value)) return value
  throw new Error(`expected patch, minor, major or skip, received ${value}`)
}

export function releaseTagPatterns(id: Plugin): readonly string[] {
  // Publish tags (`opencode-vX.Y.Z`, `pi-vX.Y.Z`) are created by the publish
  // scripts after npm publish succeeds. The unprefixed v* tags are the
  // pre-monorepo OpenCode releases and still anchor older history.
  return id === "opencode" ? ["opencode-v*", "v*"] : ["pi-v*"]
}

/** Post-publication tag: `<package-id>-v<version>`, full semver from the manifest. */
export function tagName(id: Plugin, version: string): string {
  return `${id}-v${version}`
}

export function planReleases(
  packages: readonly ReleasePackage[],
  bumps: Readonly<Partial<Record<Plugin, Bump>>>,
): PlannedRelease[] {
  for (const id of Object.keys(bumps)) {
    if (!packages.some((pkg) => pkg.id === id && !pkg.private)) {
      throw new Error(`release: ${id} is not a publishable package`)
    }
  }
  return packages.flatMap((pkg) => {
    const bump = bumps[pkg.id]
    if (bump !== undefined && pkg.commits.length === 0) {
      throw new Error(`release: ${pkg.id} has no changes since its last release`)
    }
    if (pkg.private || bump === undefined) return []
    const version = nextVersion(pkg.version, bump)
    return [
      {
        id: pkg.id,
        name: pkg.name,
        previous: pkg.version,
        version,
        tag: tagName(pkg.id, version),
        commits: pkg.commits,
      },
    ]
  })
}

export function releaseSummary(pkg: ReleasePackage): string {
  const shared = pkg.commits.filter((commit) => commit.shared).length
  const name = pkg.name.slice(pkg.name.lastIndexOf("/") + 1).padEnd(20)
  if (pkg.commits.length === 0) return `${name}${pkg.version}  unchanged`
  const count = pkg.commits.length === 1 ? "1 commit" : `${String(pkg.commits.length)} commits`
  return `${name}${pkg.version} → ?  ${count} (${String(shared)} in shared core)`
}

export function notesTemplate(release: PlannedRelease): string {
  const commits = release.commits.map((commit) => `  ${commit.hash.slice(0, 7)} ${commit.subject}`)
  return [
    `<!-- Release notes for ${release.tag}. Write what changed for users; lines in this`,
    "comment are removed. Use ### Added / ### Changed / ### Fixed sections as needed.",
    "",
    ...commits,
    "-->",
    "",
  ].join("\n")
}

export function stripNotes(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim()
}

export function changelogEntry(release: PlannedRelease, date: string, notes: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date: expected YYYY-MM-DD")
  if (notes.trim().length === 0) throw new Error(`notes: summary required for ${release.tag}`)
  const shared = release.commits.filter((commit) => commit.shared)
  const details =
    shared.length === 0
      ? ""
      : `\n\n### Shared core\n\n${shared.map((commit) => `- ${commit.subject} (${commit.hash.slice(0, 7)})`).join("\n")}`
  return `## [${release.version}] — ${date}\n\n${notes.trim()}${details}`
}

export function updateChangelog(previous: string, release: PlannedRelease, entry: string): string {
  const heading = /^## /m.exec(previous)
  const offset = heading?.index ?? previous.length
  const before = previous.slice(0, offset).trimEnd()
  const after = previous
    .slice(offset)
    .replace(/^## \[Unreleased\]\s*/, "")
    .trim()
  const link = `[${release.version}]: https://github.com/coool-labs/adaptive/releases/tag/${release.tag}`
  const links = /^\[[^\]]+\]: /m.exec(after)
  const body =
    links === null
      ? `${after}\n\n${link}`
      : `${after.slice(0, links.index)}${link}\n${after.slice(links.index)}`
  return `${before}\n\n## [Unreleased]\n\n${entry}\n\n${body.trim()}\n`
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function property(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function readObject(text: string, file: string): object {
  const value: unknown = JSON.parse(text)
  if (!isObject(value)) throw new Error(`${file}: expected a JSON object`)
  return value
}

export function setManifestVersion(text: string, version: string): string {
  const manifest = readObject(text, "package.json")
  if (typeof property(manifest, "version") !== "string") {
    throw new Error("package.json: version is missing")
  }
  return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`
}

export function setLockVersion(text: string, directory: string, version: string): string {
  const lock = readObject(text, "package-lock.json")
  const packages = property(lock, "packages")
  const entry = isObject(packages) ? property(packages, directory) : undefined
  if (!isObject(entry)) throw new Error(`package-lock.json: packages.${directory} is missing`)
  Object.assign(entry, { version })
  return `${JSON.stringify(lock, null, 2)}\n`
}

export function releaseCommitMessage(plan: readonly PlannedRelease[]): string {
  return `release: ${plan.map((release) => release.tag).join(" ")}`
}

/** Maps the tags named on a release commit back to the packages they publish. */
export function taggedReleases(
  tags: readonly string[],
  packages: readonly Pick<ReleasePackage, "id" | "name">[],
): { id: Plugin; name: string; version: string; tag: string }[] {
  return tags.flatMap((tag) => {
    // Subjects written before post-publication tagging used <name>@<version>;
    // both families name the same release, so resume understands either.
    const pkg = packages.find((candidate) => {
      const legacy = `${candidate.name.slice(candidate.name.lastIndexOf("/") + 1)}@`
      return tag.startsWith(tagName(candidate.id, "")) || tag.startsWith(legacy)
    })
    if (pkg === undefined) return []
    const prefix = tagName(pkg.id, "")
    const version = tag.startsWith(prefix)
      ? tag.slice(prefix.length)
      : tag.slice(tag.lastIndexOf("@") + 1)
    return [{ id: pkg.id, name: pkg.name, version, tag }]
  })
}

/** Reads `npm view <name>@<version> version`: published, missing (E404), or a hard error. */
export function publishState(result: {
  status: number | null
  stderr: string
}): "published" | "missing" {
  if (result.status === 0) return "published"
  if (/\bE404\b/.test(result.stderr)) return "missing"
  throw new Error(`npm view failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`)
}
