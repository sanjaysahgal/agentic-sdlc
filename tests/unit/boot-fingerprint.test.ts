// Boot fingerprint tests.
//
// The fingerprint is what proves the running bot actually loaded the latest
// code (not a tsx-watch-cached old module). Tests guard the contract:
//   1. CODE_MARKER must be a non-empty string (the [BOOT] log relies on it)
//   2. CODE_MARKER must NOT be a placeholder ("TODO", "BUMP-ME", etc.) — the
//      whole point is that it's a real version identifier
//   3. bootFingerprint() returns BOTH commit and codeMarker, with codeMarker
//      always equal to the exported constant

import { describe, it, expect } from "vitest"
import { bootFingerprint, CODE_MARKER } from "../../runtime/boot-fingerprint"

describe("bootFingerprint", () => {
  it("returns the exported CODE_MARKER verbatim", () => {
    const fp = bootFingerprint()
    expect(fp.codeMarker).toBe(CODE_MARKER)
  })

  it("returns a commit string (either a short SHA or 'unknown')", () => {
    const fp = bootFingerprint()
    expect(typeof fp.commit).toBe("string")
    expect(fp.commit.length).toBeGreaterThan(0)
    // Either a short git SHA (≥ 7 hex chars) or the literal "unknown" fallback.
    expect(fp.commit).toMatch(/^([0-9a-f]{7,}|unknown)$/)
  })
})

describe("CODE_MARKER invariants", () => {
  it("is a non-empty string", () => {
    expect(typeof CODE_MARKER).toBe("string")
    expect(CODE_MARKER.length).toBeGreaterThan(0)
  })

  it("is not a placeholder value (must be a real version identifier)", () => {
    const placeholders = ["TODO", "BUMP-ME", "FIXME", "PLACEHOLDER", "TBD", ""]
    for (const p of placeholders) {
      expect(CODE_MARKER.toUpperCase()).not.toBe(p)
    }
  })

  it("contains a meaningful identifier (no whitespace-only, no version numbers alone)", () => {
    expect(CODE_MARKER.trim()).toBe(CODE_MARKER)
    // A bare "v1" or "1.0" wouldn't tell a manual tester what the build contains.
    expect(CODE_MARKER).not.toMatch(/^v?\d+(\.\d+)*$/)
  })
})
