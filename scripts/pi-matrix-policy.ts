export interface PiMatrix {
  minimum: string
  versions: [string, "latest"]
  surfaces: ["sdk", "json", "tui"]
  nodeMajor: 24
}

function versionParts(version: string): [number, number, number] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Pi version: invalid ${version}`)
  const parts = version.split(".")
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])]
}

export function assertSupportedPi(version: string, minimum: string): void {
  const actual = versionParts(version)
  const floor = versionParts(minimum)
  if (actual[0] !== 1 || comparePiVersions(version, minimum) < 0 || floor[0] !== 1)
    throw new Error(`Pi ${version} is unsupported (expected >=${minimum} <2)`)
}

export function comparePiVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

export function parsePiMatrix(raw: unknown): PiMatrix {
  if (typeof raw !== "object" || raw === null) throw new Error("Pi matrix: expected object")
  if (!("minimum" in raw) || typeof raw.minimum !== "string")
    throw new Error("Pi matrix.minimum: expected version")
  assertSupportedPi(raw.minimum, "1.5.0")
  if (
    !("versions" in raw && Array.isArray(raw.versions)) ||
    raw.versions.length !== 2 ||
    raw.versions[0] !== raw.minimum ||
    raw.versions[1] !== "latest"
  )
    throw new Error("Pi matrix.versions: expected [minimum, latest]")
  if (!("surfaces" in raw) || JSON.stringify(raw.surfaces) !== '["sdk","json","tui"]')
    throw new Error("Pi matrix.surfaces: expected sdk, json, tui")
  if (!("nodeMajor" in raw) || raw.nodeMajor !== 24)
    throw new Error("Pi matrix.nodeMajor: expected 24")
  return {
    minimum: raw.minimum,
    versions: [raw.minimum, "latest"],
    surfaces: ["sdk", "json", "tui"],
    nodeMajor: 24,
  }
}

export interface PiMatrixPass {
  requested: string
  version: string
  surface: "sdk" | "json" | "tui"
}

/** A failed or partial matrix must never advance the tested-up-to claim. */
export function testedPiVersion(
  matrix: PiMatrix,
  resolved: readonly string[],
  passed: readonly PiMatrixPass[],
): string {
  if (resolved.length !== matrix.versions.length) throw new Error("Pi matrix: unresolved hosts")
  for (const [index, version] of resolved.entries()) {
    assertSupportedPi(version, matrix.minimum)
    for (const surface of matrix.surfaces) {
      if (
        !passed.some(
          (entry) =>
            entry.requested === matrix.versions[index] &&
            entry.version === version &&
            entry.surface === surface,
        )
      )
        throw new Error(`Pi matrix: missing ${version} ${surface}`)
    }
  }
  return resolved.reduce(
    (latest, version) => (comparePiVersions(version, latest) > 0 ? version : latest),
    matrix.minimum,
  )
}

/** Historical host compatibility is not a certification of a later rebuilt archive. */
export function piBaseline(
  matrix: PiMatrix,
  resolved: readonly string[],
  passed: readonly PiMatrixPass[],
  artifact: { readonly version: string; readonly filename: string; readonly integrity: string },
  verifiedAt: string,
) {
  const testedUpTo = testedPiVersion(matrix, resolved, passed)
  versionParts(artifact.version)
  if (!/^[\w.-]+\.tgz$/.test(artifact.filename))
    throw new Error("Pi baseline.artifact.filename: expected npm archive name")
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.integrity))
    throw new Error("Pi baseline.artifact.integrity: expected sha512 SRI")
  if (!Number.isFinite(Date.parse(verifiedAt)) || new Date(verifiedAt).toISOString() !== verifiedAt)
    throw new Error("Pi baseline.verifiedAt: expected canonical ISO timestamp")
  return {
    schemaVersion: 1,
    claim: "historical-host-compatibility",
    minimum: matrix.minimum,
    testedUpTo,
    verifiedAt,
    artifact: { name: "@coool/pi-adaptive", ...artifact },
    hosts: resolved.map((version, index) => ({
      requested: matrix.versions[index],
      version,
      surfaces: matrix.surfaces,
    })),
  }
}
