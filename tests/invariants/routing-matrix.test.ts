// Phase 2 — the matrix test that turns docs/ROUTING_STATE_MACHINE.md into executable
// truth.
//
// Every row in §8 / §9 / §10 of the spec doc is parsed into a SpecRow and driven
// through routeFeatureMessage / routeGeneralMessage. The router is byte-equivalent to
// today's behavior including the FLAGs — the matrix encodes the bugs as deliberate
// PASS rows so Phase 5 fixes are visible diffs (each FLAG row will flip in Phase 5).
//
// I14 — Spec-test correspondence: the row count is snapshotted; spec drift fails CI.

import { describe, it, expect } from "vitest"
import { resolve } from "node:path"
import { parseSpecTables, type SpecRow } from "../../runtime/routing/spec-parser"
import {
  buildFeatureRoutingInputFromRow,
  buildGeneralRoutingInputFromRow,
} from "../../runtime/routing/snapshot"
import { routeFeatureMessage } from "../../runtime/routing/route-feature-message"
import { routeGeneralMessage } from "../../runtime/routing/route-general-message"
import type { RoutingDecision } from "../../runtime/routing/types"

const SPEC_PATH = resolve(__dirname, "..", "..", "docs", "ROUTING_STATE_MACHINE.md")
const parsed    = parseSpecTables(SPEC_PATH)

// The handful of spec rows that describe composite shapes (e.g. "classify-and-route →
// run-agent(...)") or undefined behavior do not map to a single canonical RoutingDecision
// kind today. They are tracked here and skipped with a documented reason; Phase 5 either
// makes them precise or removes them.
const SKIPPED_LINES = new Set<number>([
  // FLAG-B undefined behavior — Phase 5 turns this into invalid-state with cleanup. The
  // router today returns invalid-state already, but the spec text reads "undefined
  // behavior" which doesn't match any canonical kind.
  // (no rows to skip — kept here for forward compatibility)
])

describe("Routing state machine matrix — spec / router correspondence", () => {
  it("row count snapshot (I14 — drift fails CI)", () => {
    expect({
      feature:   parsed.feature.length,
      general:   parsed.general.length,
      postAgent: parsed.postAgent.length,
    }).toMatchSnapshot()
  })

  describe("feature channel", () => {
    for (const row of parsed.feature) {
      const skip = SKIPPED_LINES.has(row.lineNumber)
      const title = `L${row.lineNumber} ${row.phase}/${row.entry} state=${shortState(row)} msg=${JSON.stringify(row.userMsg ?? "")} → ${row.expected.kind}${row.expected.flag ? " [" + row.expected.flag + "]" : ""}`
      ;(skip ? it.skip : it)(title, () => {
        const input    = buildFeatureRoutingInputFromRow(row)
        const decision = routeFeatureMessage(input)
        assertDecisionMatches(decision, row)
      })
    }
  })

  describe("general channel", () => {
    for (const row of parsed.general) {
      const title = `L${row.lineNumber} ${row.entry} threadAgent=${row.state.threadAgent ?? "—"} msg=${JSON.stringify(row.userMsg ?? "")} → ${row.expected.kind}`
      it(title, () => {
        if ((row.entry ?? "").includes("/")) {
          // Composite "G2/G3/G4" row — covered by individual G2/G3/G4 rows above.
          return
        }
        const input    = buildGeneralRoutingInputFromRow(row)
        const decision = routeGeneralMessage(input)
        assertDecisionMatches(decision, row)
      })
    }
  })
})

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assertDecisionMatches(decision: RoutingDecision, row: SpecRow): void {
  const exp = row.expected
  const failure = `\n  spec line ${row.lineNumber}: ${row.rawLine}\n  produced: ${JSON.stringify(decision)}\n  expected kind: ${exp.kind} args: ${JSON.stringify(exp.args)}`

  // FLAG-B is a special case: the spec text reads "undefined behavior" because
  // today's code crashes/mis-routes on a corrupt targetAgent. The router already
  // produces the Phase 5 fix (invalid-state with cleanup) ahead of schedule —
  // accept either to avoid encoding the literal undefinedness in tests.
  if (exp.kind === "undefined-behavior") {
    expect(decision.kind, failure).toBe("invalid-state")
    return
  }

  // L218: "yes" on a multi-item review either advances the cursor (more items
  // remaining) or completes the review (last item). Both kinds are correct
  // depending on cursor position; the matrix row covers the union.
  if (exp.kind === "confirm-decision-review-item-or-complete") {
    expect(["confirm-decision-review-item", "complete-decision-review"], failure).toContain(decision.kind)
    return
  }

  // Composite or non-canonical kinds are skipped — handled by SKIPPED_LINES above.
  expect(decision.kind, failure).toBe(exp.kind)

  // For run-agent, also assert agent + mode match the spec row's args.
  if (exp.kind === "run-agent" && decision.kind === "run-agent") {
    if (exp.args.agent)         expect(decision.agent, failure).toBe(exp.args.agent)
    if (exp.args.mode === "primary" && exp.args.modeQualifier === "product-level") {
      expect(decision.mode, failure).toBe("primary-product-level")
    } else if (exp.args.mode === "primary, product-level") {
      expect(decision.mode, failure).toBe("primary-product-level")
    } else if ((exp.args.mode ?? "").startsWith("orientation")) {
      // Spec text "mode=orientation if !S7" = orientation mode when S7 (isUserOriented) is false.
      expect(decision.mode, failure).toBe("orientation")
    } else if (exp.args.mode) {
      expect(decision.mode, failure).toBe(exp.args.mode)
    }
  }

  // For approve-spec, assert the specType matches.
  if (exp.kind === "approve-spec" && decision.kind === "approve-spec") {
    if (exp.args._0) expect(decision.specType, failure).toBe(exp.args._0)
  }

  // For show-hold-message, assert heldAgent matches when specified.
  if (exp.kind === "show-hold-message" && decision.kind === "show-hold-message") {
    if (exp.args.heldAgent) {
      const expectedHeld = exp.args.heldAgent === "design" ? "ux-design" : exp.args.heldAgent
      expect(decision.heldAgent, failure).toBe(expectedHeld)
    }
  }

  // For run-escalation-confirmed, assert origin/target match.
  if (exp.kind === "run-escalation-confirmed" && decision.kind === "run-escalation-confirmed") {
    if (exp.args.target) {
      const expectedTarget = exp.args.target === "design" ? "ux-design" : exp.args.target
      expect(decision.targetAgent, failure).toBe(expectedTarget)
    }
    if (exp.args.origin) {
      const expectedOrigin = exp.args.origin === "design" ? "ux-design" : exp.args.origin
      expect(decision.originAgent, failure).toBe(expectedOrigin)
    }
  }
}

function shortState(row: SpecRow): string {
  return Object.entries(row.state)
    .filter(([, v]) => v && v !== "—")
    .map(([k, v]) => `${k}=${v}`)
    .join(",") || "—"
}
