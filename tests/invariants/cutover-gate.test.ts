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

type GateItem = {
  readonly id:            string
  readonly title:         string
  readonly block:         string
  readonly gates_block_e: boolean
  readonly status:        Status
}

type Manifest = {
  readonly schema_version: number
  readonly purpose:        string
  readonly items:          readonly GateItem[]
  readonly valid_statuses: readonly string[]
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
      expect(manifest.schema_version).toBe(1)
      expect(manifest.items.length).toBeGreaterThan(0)
    })

    it("every item has the required fields and a valid status", () => {
      for (const item of manifest.items) {
        expect(item.id).toMatch(/^[A-Z]\d+$/)
        expect(typeof item.title).toBe("string")
        expect(typeof item.block).toBe("string")
        expect(typeof item.gates_block_e).toBe("boolean")
        expect(VALID_STATUSES).toContain(item.status)
      }
    })

    it("item ids are unique", () => {
      const ids = manifest.items.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it("manifest's valid_statuses field matches the test's VALID_STATUSES", () => {
      expect(manifest.valid_statuses).toEqual([...VALID_STATUSES])
    })
  })

  describe("cutover precondition — when CUTOVER_ENABLED is true, every gating item must be done", () => {
    it("if CUTOVER_ENABLED, no gating item is in pending/in-progress/burn-in", () => {
      const gating    = manifest.items.filter((i) => i.gates_block_e)
      const incomplete = gating.filter((i) => i.status !== "done")
      if (CUTOVER_ENABLED) {
        // Helpful failure mode: list every pending item so operator can
        // address them in lockstep with the cutover flip.
        const summary = incomplete.map((i) => `${i.id} [${i.status}]: ${i.title}`)
        expect(summary, "Cutover flag is ON but these gating items are not done").toEqual([])
      } else {
        // Cutover not yet attempted — incomplete items are expected.
        // Just assert the test is wired (always-true assertion) so the
        // describe block runs and produces telemetry below.
        expect(true).toBe(true)
      }
    })
  })

  describe("plan-level gate summary (telemetry; always passes)", () => {
    it("emits status roll-up for operator visibility", () => {
      const counts: Record<string, number> = {}
      for (const item of manifest.items) {
        counts[item.status] = (counts[item.status] ?? 0) + 1
      }
      const total = manifest.items.length
      // eslint-disable-next-line no-console
      console.log(`[B5-GATE] CUTOVER_ENABLED=${CUTOVER_ENABLED} total=${total} done=${counts.done ?? 0} burn-in=${counts["burn-in"] ?? 0} in-progress=${counts["in-progress"] ?? 0} pending=${counts.pending ?? 0}`)
      expect(total).toBeGreaterThan(20)  // sanity: manifest has the full A–M slate
    })

    it("emits per-block summary for operator visibility", () => {
      const byBlock: Record<string, { total: number; done: number }> = {}
      for (const item of manifest.items) {
        byBlock[item.block] = byBlock[item.block] ?? { total: 0, done: 0 }
        byBlock[item.block].total += 1
        if (item.status === "done") byBlock[item.block].done += 1
      }
      const blocks = Object.keys(byBlock).sort()
      for (const b of blocks) {
        const { total, done } = byBlock[b]
        // eslint-disable-next-line no-console
        console.log(`[B5-GATE]   block ${b}: ${done}/${total} done`)
      }
      expect(blocks.length).toBeGreaterThanOrEqual(8)  // A, B, C, D, G, H, I, J, K, L, M
    })
  })
})
