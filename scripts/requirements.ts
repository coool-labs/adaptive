export type RequirementHost = "opencode" | "pi"

/** Only real host journeys count as E2E; unit declarations cannot satisfy the gate. */
export function requirementE2ESource(host: RequirementHost, file: string): boolean {
  const prefixes =
    host === "pi"
      ? ["test/runtime/", "test/packed/", "test/tui/", "test/matrix/"]
      : [
          "test/runtime-e2e/",
          "test/e2e-web/",
          "test/e2e-gui/",
          "test/e2e-tui/",
          "test/plugin-test/",
        ]
  const normalized = file.replaceAll("\\", "/")
  return prefixes.some((prefix) => normalized.startsWith(prefix))
}

/** Every live ID has exactly one scope; missing scopes fail closed. */
export function requirementCatalogue(
  doc: string,
  host: RequirementHost,
): { all: string[]; applicable: string[] } {
  const all = [...doc.matchAll(/^- \*\*ADP-\d{3}\*\*/gm)].map((match) => match[0].slice(4, 11))
  const scopes = new Map<string, string>()
  for (const match of doc.matchAll(/^- \[([^\]]+)\]: (.+)$/gm)) {
    const separator = match[0].indexOf("]")
    const scope = match[0].slice(3, separator)
    if (scope !== "both" && scope !== "opencode" && scope !== "pi")
      throw new Error(`requirements: unknown scope ${scope}`)
    for (const id of match[0].slice(separator + 3).match(/ADP-\d{3}/g) ?? []) {
      if (!all.includes(id)) throw new Error(`requirements: scoped ID ${id} is not defined`)
      if (scopes.has(id)) throw new Error(`requirements: duplicate scope for ${id}`)
      scopes.set(id, scope)
    }
  }
  for (const id of all) {
    if (!scopes.has(id)) throw new Error(`requirements: ${id} has no scope`)
  }
  return {
    all,
    applicable: all.filter((id) => scopes.get(id) === "both" || scopes.get(id) === host),
  }
}
