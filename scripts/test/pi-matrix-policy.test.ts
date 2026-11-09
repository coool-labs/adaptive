import { expect, it } from "vitest"
import {
  assertSupportedPi,
  comparePiVersions,
  parsePiMatrix,
  piBaseline,
  testedPiVersion,
} from "../pi-matrix-policy.js"

const raw = {
  minimum: "1.5.0",
  versions: ["1.5.0", "latest"],
  surfaces: ["sdk", "json", "tui"],
  nodeMajor: 24,
}

it("requires the minimum/latest hosts and every real surface on Node 24", () => {
  expect(parsePiMatrix(raw)).toEqual(raw)
  for (const bad of [null, 1, {}, { ...raw, minimum: 1 }])
    expect(() => parsePiMatrix(bad)).toThrow("Pi matrix")
  for (const versions of [
    undefined,
    null,
    [],
    ["1.5.0"],
    ["1.6.0", "latest"],
    ["1.5.0", "current"],
  ]) {
    expect(() => parsePiMatrix({ ...raw, versions })).toThrow("versions")
  }
  expect(() => parsePiMatrix({ minimum: raw.minimum })).toThrow("versions")
  expect(() => parsePiMatrix({ minimum: raw.minimum, versions: raw.versions })).toThrow("surfaces")
  expect(() => parsePiMatrix({ ...raw, surfaces: [] })).toThrow("surfaces")
  expect(() =>
    parsePiMatrix({ minimum: raw.minimum, versions: raw.versions, surfaces: raw.surfaces }),
  ).toThrow("nodeMajor")
  expect(() => parsePiMatrix({ ...raw, nodeMajor: 26 })).toThrow("nodeMajor")
})

it("associates a historical baseline with the archive that actually passed, never a later build", () => {
  const matrix = parsePiMatrix(raw)
  const hosts = ["1.5.0", "1.5.0"]
  const passed = matrix.versions.flatMap((requested) =>
    matrix.surfaces.map((surface) => ({ requested, version: "1.5.0", surface })),
  )
  const artifact = {
    version: "0.0.0",
    filename: "coool-pi-adaptive-0.0.0.tgz",
    integrity: `sha512-${"A".repeat(86)}==`,
  }
  const timestamp = "2026-11-09T09:12:02.863Z"
  expect(piBaseline(matrix, hosts, passed, artifact, timestamp)).toEqual({
    schemaVersion: 1,
    claim: "historical-host-compatibility",
    minimum: "1.5.0",
    testedUpTo: "1.5.0",
    verifiedAt: timestamp,
    artifact: { name: "@coool/pi-adaptive", ...artifact },
    hosts: matrix.versions.map((requested) => ({
      requested,
      version: "1.5.0",
      surfaces: matrix.surfaces,
    })),
  })
  expect(() => piBaseline(matrix, hosts, passed.slice(0, 3), artifact, timestamp)).toThrow(
    "missing",
  )
  expect(() =>
    piBaseline(matrix, hosts, passed, { ...artifact, version: "unknown" }, timestamp),
  ).toThrow("invalid")
  expect(() =>
    piBaseline(matrix, hosts, passed, { ...artifact, filename: "../other.tgz" }, timestamp),
  ).toThrow("filename")
  expect(() =>
    piBaseline(matrix, hosts, passed, { ...artifact, integrity: "sha512-unknown" }, timestamp),
  ).toThrow("integrity")
  expect(() => piBaseline(matrix, hosts, passed, artifact, "unknown")).toThrow("verifiedAt")
  expect(() => piBaseline(matrix, hosts, passed, artifact, "2026-11-09")).toThrow("verifiedAt")
})

it("checks actual resolved versions, not registry labels or lexicographic order", () => {
  expect(comparePiVersions("1.10.0", "1.9.9")).toBeGreaterThan(0)
  expect(comparePiVersions("1.5.1", "1.5.0")).toBeGreaterThan(0)
  expect(comparePiVersions("1.5.0", "1.5.0")).toBe(0)
  expect(comparePiVersions("2.0.0", "1.5.0")).toBeGreaterThan(0)
  expect(() => {
    assertSupportedPi("latest", "1.5.0")
  }).toThrow("invalid")
  expect(() => {
    assertSupportedPi("1.5.0", "bad")
  }).toThrow("invalid")
  expect(() => {
    assertSupportedPi("2.0.0", "1.5.0")
  }).toThrow("unsupported")
  expect(() => {
    assertSupportedPi("1.4.9", "1.5.0")
  }).toThrow("unsupported")
  expect(() => {
    assertSupportedPi("1.5.0", "0.5.0")
  }).toThrow("unsupported")
  assertSupportedPi("1.5.0", "1.5.0")
})

it("records testedUpTo only after the full resolved matrix succeeds", () => {
  const matrix = parsePiMatrix(raw)
  const resolved = ["1.5.0", "1.10.0"]
  const passed = resolved.flatMap((version, index) =>
    matrix.surfaces.map((surface) => ({
      requested: index === 0 ? "1.5.0" : "latest",
      version,
      surface,
    })),
  )
  expect(testedPiVersion(matrix, resolved, passed)).toBe("1.10.0")
  const sameVersion = passed.map((entry) => ({ ...entry, version: "1.5.0" }))
  expect(testedPiVersion(matrix, ["1.5.0", "1.5.0"], sameVersion)).toBe("1.5.0")
  expect(() => testedPiVersion(matrix, ["1.5.0", "1.5.0"], sameVersion.slice(0, 3))).toThrow(
    "missing 1.5.0 sdk",
  )
  expect(() => testedPiVersion(matrix, [], [])).toThrow("unresolved")
  expect(() => testedPiVersion(matrix, resolved, passed.slice(0, -1))).toThrow("missing 1.10.0 tui")
})
