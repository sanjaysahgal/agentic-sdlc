// Block B5 — cutover-gate test.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`.
// Reads `docs/cutover-gate-status.json` (the single source of truth for
// gating-item status across blocks A–M). Asserts: when the cutover flag
// at `runtime/cutover-flag.ts:CUTOVER_ENABLED` is `true`, every gating
// item in the manifest must have status `done`.
//
// Today the flag is `false` and many items are `pending` — that's
// expected and the gate passes (no cutover attempted). When Block E
// readiness is asserted, an operator flips the flag to `true` IN THE
// SAME PR as the dispatcher wiring change. The gate immediately runs
// against the manifest; any pending items fail the merge.
//
// Defense in depth: the dispatcher wiring (added in Block E) must ALSO
// import `CUTOVER_ENABLED` and treat it as the runtime branch — so a
// deploy with the constant still `false` cannot accidentally route to
// V2 handlers. The CI gate ensures the static state is consistent;
// the runtime check ensures the deploy state matches.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { CUTOVER_ENABLED } from "../../runtime/cutover-flag"

// ── Manifest types ────────────────────────────────────────────────────────────

const VALID_STATUSES = ["pending", "in-progress", "burn-in", "done"] as const
type Status = typeof VALID_STATUSES[number]

const VALID_VERIFICATIONS = [
  "pending",
  "burn-in",
  "docs-only",
  "infrastructure-only",
  "wired-and-exercised",
] as const
type Verification = typeof VALID_VERIFICATIONS[number]

type GateItem = {
  readonly id:                string
  readonly title:             string
  readonly block:             string
  readonly gates_block_e:     boolean
  readonly status:            Status
  readonly verification:      Verification
  readonly verification_note?: string
}

type Manifest = {
  readonly schema_version:      number
  readonly purpose:             string
  readonly items:               readonly GateItem[]
  readonly valid_statuses:      readonly string[]
  readonly valid_verifications: readonly string[]
}

const MANIFEST_PATH = resolve(__dirname, "..", "..", "docs", "cutover-gate-status.json")

function loadManifest(): Manifest {
  const text = readFileSync(MANIFEST_PATH, "utf-8")
  return JSON.parse(text) as Manifest
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Block B5 — cutover-gate test", () => {
  const manifest = loadManifest()

  describe("manifest structural validity", () => {
    it("loads the manifest without parse errors", () => {
      expect(manifest.schema_version).toBe(2)
      expect(manifest.items.length).toBeGreaterThan(0)
    })

    it("every item has the required fields and valid status + verification", () => {
      for (const item of manifest.items) {
        expect(item.id).toMatch(/^[A-Z]\d+$/)
        expect(typeof item.title).toBe("string")
        expect(typeof item.block).toBe("string")
        expect(typeof item.gates_block_e).toBe("boolean")
        expect(VALID_STATUSES).toContain(item.status)
        expect(VALID_VERIFICATIONS).toContain(item.verification)
      }
    })

    it("item ids are unique", () => {
      const ids = manifest.items.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it("manifest's valid_statuses field matches the test's VALID_STATUSES", () => {
      expect(manifest.valid_statuses).toEqual([...VALID_STATUSES])
    })

    it("manifest's valid_verifications field matches the test's VALID_VERIFICATIONS", () => {
      expect(manifest.valid_verifications).toEqual([...VALID_VERIFICATIONS])
    })

    it("status=done items must have verification != pending (status and verification can't disagree)", () => {
      const conflicts = manifest.items.filter((i) => i.status === "done" && i.verification === "pending")
      expect(conflicts, "items marked status=done can't have verification=pending").toEqual([])
    })

    it("infrastructure-only and docs-only items carry a verification_note explaining why", () => {
      // Soft enforcement: items demoted to infrastructure-only get an explanation;
      // docs-only items don't strictly need one (the verification grade itself is the note).
      const infraOnlyMissingNote = manifest.items.filter(
        (i) => i.verification === "infrastructure-only" && !i.verification_note,
      )
      expect(infraOnlyMissingNote.map((i) => i.id), "infrastructure-only items must explain why they aren't wired").toEqual([])
    })
  })

  describe("cutover precondition — when CUTOVER_ENABLED is true, every gating item must be wired-and-exercised", () => {
    it("if CUTOVER_ENABLED, every gating item is verification=wired-and-exercised", () => {
      // Schema v2 (post-audit): Block E readiness requires verification=wired-and-exercised,
      // not just status=done. Items that exist as infrastructure-only (modules with no
      // callers), docs-only (paper), or burn-in (legitimate clock running) are NOT enough.
      const gating    = manifest.items.filter((i) => i.gates_block_e)
      const incomplete = gating.filter((i) => i.verification !== "wired-and-exercised")
      if (CUTOVER_ENABLED) {
        const summary = incomplete.map((i) => `${i.id} [status=${i.status} verification=${i.verification}]: ${i.title}`)
        expect(summary, "Cutover flag is ON but these gating items are not wired-and-exercised").toEqual([])
      } else {
        // Cutover not yet attempted — incomplete items are expected.
        expect(true).toBe(true)
      }
    })
  })

  describe("plan-level gate summary (telemetry; always passes)", () => {
    it("emits verification roll-up — the truthful state for operator visibility", () => {
      const counts: Record<string, number> = {}
      for (const item of manifest.items) {
        counts[item.verification] = (counts[item.verification] ?? 0) + 1
      }
      const total = manifest.items.length
      const wired = counts["wired-and-exercised"] ?? 0
      // eslint-disable-next-line no-console
      console.log(`[B5-GATE] CUTOVER_ENABLED=${CUTOVER_ENABLED} total=${total} wired-and-exercised=${wired} infrastructure-only=${counts["infrastructure-only"] ?? 0} docs-only=${counts["docs-only"] ?? 0} burn-in=${counts["burn-in"] ?? 0} pending=${counts.pending ?? 0}`)
      // eslint-disable-next-line no-console
      console.log(`[B5-GATE] Block E readiness: ${wired}/${total} items wired-and-exercised (${Math.round((wired/total)*100)}%)`)
      expect(total).toBeGreaterThan(20)
    })

    it("emits per-block verification summary for operator visibility", () => {
      const byBlock: Record<string, { total: number; wired: number; infraOnly: number; docsOnly: number }> = {}
      for (const item of manifest.items) {
        byBlock[item.block] = byBlock[item.block] ?? { total: 0, wired: 0, infraOnly: 0, docsOnly: 0 }
        byBlock[item.block].total += 1
        if (item.verification === "wired-and-exercised") byBlock[item.block].wired += 1
        if (item.verification === "infrastructure-only") byBlock[item.block].infraOnly += 1
        if (item.verification === "docs-only")           byBlock[item.block].docsOnly += 1
      }
      const blocks = Object.keys(byBlock).sort()
      for (const b of blocks) {
        const { total, wired, infraOnly, docsOnly } = byBlock[b]
        // eslint-disable-next-line no-console
        console.log(`[B5-GATE]   block ${b}: ${wired}/${total} wired (infra-only=${infraOnly} docs-only=${docsOnly})`)
      }
      expect(blocks.length).toBeGreaterThanOrEqual(8)
    })
  })
})
