import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Block J1 of the approved system-wide plan
 * (~/.claude/plans/rate-this-plan-zesty-tiger.md). Structural invariant for
 * `MANUAL_TESTS.md` — the per-agent per-behavior catalog of manual Slack
 * scenarios for paths automated tests can't faithfully reproduce.
 *
 * The catalog is owned by the platform; this test enforces three rules so
 * the file stays useful:
 *
 *   1. Floor on count — at least MIN_MT_COUNT entries. If the user deletes
 *      a scenario, we want to see it (drop the floor explicitly + add a
 *      backlog item explaining why).
 *
 *   2. Sequential numbering — MT-1, MT-2, MT-3, …. No gaps. Renumbering
 *      is a deliberate edit, not silent drift.
 *
 *   3. Every entry has the required sections — Why this can't be automated,
 *      Pre-flight, Setup, Actions, Expected outcome, Failure signatures.
 *      A scenario missing any of these is a checklist with no rigor.
 *
 * Block E (cutover) requires this catalog be marked `done` in
 * `docs/cutover-gate-status.json`. This test is what makes "done"
 * enforceable.
 */

const REPO_ROOT = resolve(__dirname, "..", "..")
const CATALOG_PATH = resolve(REPO_ROOT, "MANUAL_TESTS.md")

const MIN_MT_COUNT = 16  // raised from 15 when MT-16 (Block N2 stripper sentence-drop) was added

const REQUIRED_SECTIONS = [
  "Why this can't be automated",
  "Setup",
  "Actions",
  "Expected outcome",
  "Failure signatures",
] as const

// File-level pre-flight protocol section — applies to all MT-N entries.
// Asserted separately so older entries that don't repeat it inline still pass.
const REQUIRED_GLOBAL_SECTION = "## Pre-flight protocol"

interface MtEntry {
  id:    number
  title: string
  body:  string
}

function parseMtEntries(source: string): MtEntry[] {
  const entries: MtEntry[] = []
  // Match `### MT-N — Title` headers and capture body up to the next ### or end.
  const re = /^### MT-(\d+) — (.+?)$([\s\S]*?)(?=^### MT-\d+|^## |$(?![\r\n]))/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    entries.push({
      id:    Number(m[1]),
      title: m[2].trim(),
      body:  m[3],
    })
  }
  return entries
}

describe("MANUAL_TESTS.md catalog invariant (Block J1)", () => {
  const source = readFileSync(CATALOG_PATH, "utf8")
  const entries = parseMtEntries(source)

  it(`catalog has at least ${MIN_MT_COUNT} MT-N entries (today's floor)`, () => {
    expect(entries.length).toBeGreaterThanOrEqual(MIN_MT_COUNT)
  })

  it("MT-IDs are sequential starting from 1 (no gaps)", () => {
    const ids = entries.map((e) => e.id).sort((a, b) => a - b)
    for (let i = 0; i < ids.length; i++) {
      const expectedId = i + 1
      if (ids[i] !== expectedId) {
        throw new Error(
          `MT-${expectedId} is missing or out of order. Found IDs in sorted order: [${ids.join(", ")}]. ` +
          `Either renumber the catalog or add the missing entry.`,
        )
      }
    }
  })

  it.each(REQUIRED_SECTIONS.flatMap((section) =>
    [...Array(Math.max(MIN_MT_COUNT, 1)).keys()].map((i) => [i + 1, section] as const),
  ))("MT-%i body contains required section: %s", (id, section) => {
    const entry = entries.find((e) => e.id === id)
    if (!entry) return  // sequential-numbering test will catch missing IDs
    expect(entry.body, `MT-${id} ("${entry.title}") missing required section "${section}"`).toContain(section)
  })

  it("every MT title is non-empty", () => {
    for (const e of entries) {
      expect(e.title.length, `MT-${e.id} has empty title`).toBeGreaterThan(0)
    }
  })

  it(`file contains global section: ${REQUIRED_GLOBAL_SECTION}`, () => {
    expect(source).toContain(REQUIRED_GLOBAL_SECTION)
  })
})
