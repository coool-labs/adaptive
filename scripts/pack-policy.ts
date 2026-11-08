export function readPackPolicy(value: unknown): { name: string; requiredFiles: string[] } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !("requiredFiles" in value) ||
    !Array.isArray(value.requiredFiles) ||
    value.requiredFiles.length === 0 ||
    !value.requiredFiles.every(
      (file: unknown): file is string =>
        typeof file === "string" &&
        /^package\/[\w./-]+$/.test(file) &&
        !file.split("/").includes(".."),
    )
  ) {
    throw new Error(
      "pack-manifest.json: name must be nonempty and requiredFiles must contain package-relative tarball paths",
    )
  }
  return { name: value.name, requiredFiles: value.requiredFiles }
}

const PRIVATE_WORKSPACES = ["@coool/adaptive-core", "@coool/adaptive-testkit"]

export function privateArtifactProblems(entry: string, text: string): string[] {
  if (!/^package\/dist\/.*\.(?:[cm]?js|d\.[cm]?ts)$/.test(entry)) return []
  return PRIVATE_WORKSPACES.filter((name) => text.includes(name)).map(
    (name) => `${entry} references private workspace ${name}`,
  )
}

export function runtimeDependencyProblems(manifest: Record<string, unknown>): string[] {
  const problems: string[] = []
  for (const field of [
    "devDependencies",
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const value = manifest[field]
    if (value === undefined) continue
    if (typeof value !== "object" || value === null) {
      problems.push(`manifest ${field} must be an object or array`)
      continue
    }
    const names = Array.isArray(value) ? value : Object.keys(value)
    for (const name of PRIVATE_WORKSPACES) {
      if (names.includes(name))
        problems.push(`manifest ${field} includes private workspace ${name}`)
    }
  }
  return problems
}

export function exportTargetProblems(value: unknown, listing: readonly string[]): string[] {
  if (typeof value === "string") {
    return value.startsWith("./") && listing.includes(`package/${value.slice(2)}`)
      ? []
      : [`missing or unsafe export target: ${value}`]
  }
  if (typeof value !== "object" || value === null)
    return ["manifest exports must name file targets"]
  return Object.values(value).flatMap((target: unknown) => exportTargetProblems(target, listing))
}
