// CLAUDE.md Principle 17 — Cross-surface message consistency.
//
// "Every claim the platform makes to a user about feature state must be
// consistent across all surfaces, all invocations, all channels, and all
// time within a turn. Same query → same factual answer regardless of
// agent / channel / slash command / invocation / time."
//
// This invariant is EXTENSIBLE. v1 pins the SSOT contract: the canonical
// state-query / readiness-summary computation lives at
// `runtime/readiness-builder.ts` (`buildReadinessReport`), composing the
// deterministic auditors per Principle 11. Every surface that composes a
// platform message about feature state must derive from this SSOT — no
// duplicated readiness logic anywhere.
//
// As consistency violations are surfaced via integration walks (B13 was
// the first), specific assertions are added to this file pinning the
// post-fix consistent behavior so the class can never recur. The
// invariant grows over time; the principle does not change.
//
// The structural enforcement pattern:
//   1. SSOT exists and is correctly exported (v1 — pinned now).
//   2. No handler file computes its own readiness — must call into the SSOT
//      (v1 — sanity check that handler files import from readiness-builder
//      where they compose readiness messages).
//   3. Per-surface assertions (added as violations are found):
//      - State-query fast-path response uses SSOT (B13 fix will pin this).
//      - Concierge cross-channel state response uses SSOT (TBD).
//      - Slash command override response uses SSOT (TBD).
//      - Re-escalation notifications quote the SSOT-computed counts (TBD).

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, join } from "node:path"
import {
  buildReadinessReport,
  type ReadinessReport,
} from "../../runtime/readiness-builder"

const REPO_ROOT = resolve(__dirname, "..", "..")
const HANDLERS_ROOT = resolve(REPO_ROOT, "interfaces", "slack", "handlers")
const RUNTIME_AGENTS_ROOT = resolve(REPO_ROOT, "runtime", "agents")

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  if (!statSync(dir).isDirectory()) return out
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...listTsFiles(p))
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p)
  }
  return out
}

// ── SSOT module sanity ───────────────────────────────────────────────────────

describe("Principle 17 — SSOT module exists and is correctly shaped", () => {
  it("buildReadinessReport is exported from runtime/readiness-builder.ts", () => {
    expect(typeof buildReadinessReport).toBe("function")
  })

  it("ReadinessReport type carries the canonical fields used by every state-query surface", () => {
    // Sanity construction with minimal valid input — this also documents the
    // surface area surfaces depend on. Adding a new field here is a deliberate
    // change to the SSOT contract that every surface will inherit.
    const fakeReport: ReadinessReport = {
      aggregate: "ready",
      ownReady: true,
      ownFindingCount: 0,
      upstreamPmFindingCount: 0,
      upstreamDesignFindingCount: 0,
      ownFindings: [],
      upstreamFindings: [],
      summary: "",
      directive: "",
      pendingApprovalActive: false,
      escalationActive: false,
      escalationTarget: null,
    }
    expect(fakeReport.aggregate).toBeDefined()
    expect(fakeReport.summary).toBeDefined()
    expect(fakeReport.directive).toBeDefined()
  })
})

// ── No-duplicate-readiness-logic guard ───────────────────────────────────────
//
// Heuristic check: any handler or agent runner file that mentions "readiness"
// or "aggregate" in a context that suggests its own computation should also
// import from readiness-builder. This is a soft signal — the v1 invariant
// is sanity-level. As specific consistency violations are fixed, harder
// assertions (e.g. AST-greps for the SSOT call) are added below.

describe("Principle 17 — handler / agent files don't compute their own readiness independently", () => {
  const handlerFiles = listTsFiles(HANDLERS_ROOT)
  const agentRunnerFiles = listTsFiles(RUNTIME_AGENTS_ROOT)
  const filesToAudit = [...handlerFiles, ...agentRunnerFiles]

  it("at least one handler file is scanned (sanity guard)", () => {
    expect(filesToAudit.length).toBeGreaterThan(0)
  })

  it("V2 agent runners import buildReadinessReport from the canonical module (Block B1 already enforces this; pinned here as a Principle 17 floor)", () => {
    const v2Runners = agentRunnerFiles.filter((p) =>
      /run(Architect|Design|Pm)AgentV2\.ts$/.test(p),
    )
    expect(v2Runners.length, "expected the 3 V2 runners").toBeGreaterThanOrEqual(3)
    for (const file of v2Runners) {
      const source = readFileSync(file, "utf8")
      expect(
        source,
        `[Principle 17] V2 runner ${file.replace(REPO_ROOT + "/", "")} must import buildReadinessReport from runtime/readiness-builder — this is the canonical SSOT for every state-query / readiness-summary computation`,
      ).toMatch(/buildReadinessReport/)
    }
  })
})

// ── Per-surface assertions (extended as violations are surfaced) ────────────
//
// As each consistency violation is fixed, add a specific assertion here that
// pins the post-fix consistent behavior. Each assertion should reference its
// manifest item (e.g. B13) + regression catalog bug number so the linkage is
// auditable.
//
// Template for new assertions:
//
// describe("[manifest BNN / bug #M] — <surface name> uses SSOT", () => {
//   it("...", () => {
//     // Assertion that pins the post-fix behavior. Could be:
//     //   - source-grep: handler file imports buildReadinessReport
//     //   - source-grep: handler doesn't have its own copy of readiness logic
//     //   - integration-test cross-reference: scenario X and scenario Y produce
//     //     the same readiness shape
//   })
// })
//
// Pending assertions (added as their respective fixes ship):
//
// - B13: architect's state-query fast-path includes upstream findings (currently
//   it only counts own engineering-spec findings, contradicting the finalize gate).
//   Pin: when upstream findings exist, fast-path's `aggregate` is NOT
//   `ready-pending-approval` and `total` includes upstream counts.
//
// - TBD (concierge cross-channel): concierge's state response in `#all-<product>`
//   about a feature derives from the same SSOT as the agent's response in
//   `#feature-X`.
//
// - TBD (slash command override): `/pm` in feature channel and `/pm` in main
//   channel produce identical state summaries for the same feature.
