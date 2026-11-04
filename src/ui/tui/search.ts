/**
 * The search a searchable list (one with a placeholder) applies in the TUI:
 * case-insensitive substring over title and description; a blank query keeps
 * everything. The GUI host filters the same two fields itself.
 */
export function matchOptions<Option extends { title: string; description?: string }>(
  query: string,
  options: readonly Option[],
): readonly Option[] {
  const needle = query.trim().toLowerCase()
  return options.filter((option) =>
    `${option.title}\n${option.description ?? ""}`.toLowerCase().includes(needle),
  )
}
