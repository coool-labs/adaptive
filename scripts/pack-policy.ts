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
