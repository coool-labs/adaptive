export type RequirementHost = "opencode" | "pi"

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
