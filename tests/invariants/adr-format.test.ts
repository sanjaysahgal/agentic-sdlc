import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Block M2 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Structural invariant
 * for `docs/adr/`. Asserts every ADR file follows the documented format
 * (`docs/adr/README.md`) and the index in README.md references every ADR.
 *
 * The DoD CI hook (`.github/workflows/doc-sync-check.yml`) is the
 * runtime layer of M2 — already present, asserts SYSTEM_ARCHITECTURE.md
 * is updated when runtime/ changes. This test is the structural layer.
 */

const REPO_ROOT = resolve(__dirname, "..", "..")
const ADR_DIR = resolve(REPO_ROOT, "docs/adr")

const REQUIRED_SECTIONS = ["## Status", "## Context", "## Decision", "## Consequences"] as const

const VALID_STATUSES = ["Proposed", "Accepted", "Deprecated", "Superseded"] as const

interface AdrFile {
  filename: string
  number:   number
  body:     string
}

function listAdrs(): AdrFile[] {
  return readdirSync(ADR_DIR)
    .filter((f) => /^\d{4}-.+\.md$/.test(f))
    .map((f) => ({
      filename: f,
      number:   Number(f.slice(0, 4)),
      body:     readFileSync(resolve(ADR_DIR, f), "utf8"),
    }))
    .sort((a, b) => a.number - b.number)
}

describe("ADR format invariant (Block M2)", () => {
  const adrs = listAdrs()

  it("at least one ADR exists (sanity)", () => {
    expect(adrs.length).toBeGreaterThan(0)
  })

  it("ADR numbers are sequential starting at 0001 (no gaps)", () => {
    for (let i = 0; i < adrs.length; i++) {
      const expected = i + 1
      if (adrs[i].number !== expected) {
        throw new Error(
          `ADR-${String(expected).padStart(4, "0")} missing or out of order. ` +
          `Found ADRs (in order): ${adrs.map((a) => a.filename).join(", ")}`,
        )
      }
    }
  })

  it.each(adrs)("$filename has matching H1 title `# ADR-NNNN: ...`", ({ filename, number, body }) => {
    const numStr = String(number).padStart(4, "0")
    const expectedPrefix = `# ADR-${numStr}:`
    const firstLine = body.split("\n")[0]
    expect(firstLine, `${filename} H1 should start with "${expectedPrefix}"`).toContain(expectedPrefix)
  })

  it.each(adrs.flatMap((a) => REQUIRED_SECTIONS.map((s) => [a.filename, s, a.body] as const)))(
    "$0 contains required section: $1",
    (_filename, section, body) => {
      expect(body).toContain(section)
    },
  )

  it.each(adrs)("$filename has a valid Status value", ({ filename, body }) => {
    const statusMatch = body.match(/## Status\s*\n+\s*([^\n]+)/)
    expect(statusMatch, `${filename} missing or malformed ## Status`).not.toBeNull()
    const status = statusMatch![1].trim()
    const isValid = VALID_STATUSES.some((v) => status.startsWith(v))
    if (!isValid) {
      throw new Error(
        `${filename} status "${status}" is not one of: ${VALID_STATUSES.join(", ")}. ` +
        `(Superseded entries should be "Superseded by ADR-NNNN".)`,
      )
    }
  })

  it("README.md indexes every ADR file", () => {
    const readme = readFileSync(resolve(ADR_DIR, "README.md"), "utf8")
    for (const adr of adrs) {
      expect(readme, `README.md missing index entry for ${adr.filename}`).toContain(adr.filename)
    }
  })
})
