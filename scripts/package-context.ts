import { dirname, join } from "node:path"

/** Packed-artifact and traceability commands share one explicit package scope. */
export function packageContext(
  args: readonly string[],
  cwd: string,
  exists: (path: string) => boolean,
): { workspace: "opencode" | "pi"; root: string; directory: string } {
  const workspace = args[1]
  if (
    args.length !== 2 ||
    args[0] !== "--pkg" ||
    (workspace !== "opencode" && workspace !== "pi")
  ) {
    throw new Error("Expected --pkg opencode or --pkg pi")
  }
  let root = cwd
  while (!exists(join(root, "package-lock.json"))) {
    const parent = dirname(root)
    if (root === parent) throw new Error("Could not locate workspace root (package-lock.json)")
    root = parent
  }
  const directory = join(root, "packages", workspace)
  if (!exists(join(directory, "package.json"))) {
    throw new Error(`Package ${workspace} does not exist: ${directory}`)
  }
  return { workspace, root, directory }
}
