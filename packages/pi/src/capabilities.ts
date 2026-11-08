export interface ToolCapability {
  readonly providerID: string
  readonly id: string
  readonly tools: boolean
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadToolCapabilities(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<readonly ToolCapability[]> {
  let text: string
  try {
    text = await read(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("Adaptive capabilities: invalid JSON")
  }
  if (
    !(object(raw) && Array.isArray(raw["models"])) ||
    Object.keys(raw).some((key) => key !== "models")
  )
    throw new Error("Adaptive capabilities.models: expected an array in a models-only object")
  const seen = new Set<string>()
  return raw["models"].map((entry: unknown, index: number) => {
    const field = `Adaptive capabilities.models[${String(index)}]`
    if (!object(entry)) throw new Error(`${field}: expected an object`)
    const providerID = entry["providerID"]
    const id = entry["id"]
    const tools = entry["tools"]
    if (typeof providerID !== "string" || providerID.trim().length === 0)
      throw new Error(`${field}.providerID: expected a non-empty string`)
    if (typeof id !== "string" || id.trim().length === 0)
      throw new Error(`${field}.id: expected a non-empty string`)
    if (typeof tools !== "boolean") throw new Error(`${field}.tools: expected a boolean`)
    if (Object.keys(entry).some((key) => !["providerID", "id", "tools"].includes(key)))
      throw new Error(`${field}: unknown field`)
    const key = JSON.stringify([providerID, id])
    if (seen.has(key)) throw new Error(`${field}: duplicate model`)
    seen.add(key)
    return { providerID, id, tools }
  })
}
