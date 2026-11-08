export type Workspace = "core" | "testkit" | "opencode" | "pi"

/** Shared code and tooling changes invalidate every available consumer. */
export function affectedWorkspaces(
  paths: readonly string[],
  available: readonly Workspace[],
): Workspace[] {
  const selected = new Set<Workspace>()
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/")
    if (normalized.startsWith("packages/core/") || normalized.startsWith("packages/testkit/")) {
      for (const workspace of available) selected.add(workspace)
    } else if (normalized.startsWith("packages/")) {
      for (const workspace of available) {
        if (normalized.startsWith(`packages/${workspace}/`)) selected.add(workspace)
      }
    } else {
      for (const workspace of available) selected.add(workspace)
    }
  }
  return available.filter((workspace) => selected.has(workspace))
}
