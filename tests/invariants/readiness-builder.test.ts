// Phase 5 wart fix — readiness builder tests.
//
// Exhaustive coverage of `buildReadinessReport`. Pure function, so every
// state combination is a unit test with no mocks. The validation criterion
// from the BACKLOG entry is "rerun the manual test scenario above; the
// architect's response should change from 'Nothing blocking' to
// 'Engineering complete, but PM has 4 findings + Design has 26'." Tests
// assert that the directive contains the exact verbatim numbers the agent
// must surface — Principle 11 is enforced structurally, not via prompt
// rules.

import { describe, it, expect } from "vitest"
import {
  buildReadinessReport,
  type ReadinessReportInput,
  type ReadinessAuditSource,
} from "../../runtime/readiness-builder"

function input(over: Partial<ReadinessReportInput> = {}): ReadinessReportInput {
  return {
    callingAgent:     "architect",
    featureName:      "onboarding",
    ownSpec:          { specType: "engineering", status: "ready", findingCount: 0 },
    upstreamAudits:   [],
    activeEscalation: null,
    ...over,
  }
}

const PM_AUDIT: ReadinessAuditSource = { auditingAgent: "architect", specType: "product",     findingCount: 4 }
const DESIGN_AUDIT_BY_DESIGNER: ReadinessAuditSource = { auditingAgent: "ux-design", specType: "design", findingCount: 26 }
const DESIGN_AUDIT_BY_ARCH:     ReadinessAuditSource = { auditingAgent: "architect", specType: "design", findingCount: 15 }

describe("buildReadinessReport — Phase 5 wart fix (architect/designer readiness)", () => {
  describe("aggregate state classification", () => {
    it("everything clean → ready", () => {
      const r = buildReadinessReport(input())
      expect(r.aggregate).toBe("ready")
      expect(r.totalFindingCount).toBe(0)
    })

    it("own dirty + upstream clean → dirty-own", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "dirty", findingCount: 3 },
      }))
      expect(r.aggregate).toBe("dirty-own")
      expect(r.totalFindingCount).toBe(3)
    })

    it("own clean + upstream dirty → dirty-upstream", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [PM_AUDIT, DESIGN_AUDIT_BY_DESIGNER],
      }))
      expect(r.aggregate).toBe("dirty-upstream")
      expect(r.totalFindingCount).toBe(30)
    })

    it("active escalation overrides all other state → escalation-active", () => {
      const r = buildReadinessReport(input({
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
      }))
      expect(r.aggregate).toBe("escalation-active")
    })

    it("active escalation overrides even when own + upstream are dirty", () => {
      const r = buildReadinessReport(input({
        ownSpec:         { specType: "engineering", status: "dirty", findingCount: 5 },
        upstreamAudits:  [PM_AUDIT],
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
      }))
      expect(r.aggregate).toBe("escalation-active")
    })

    it("missing draft (no spec yet) + nothing else → ready-pending-approval", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "missing", findingCount: 0 },
      }))
      expect(r.aggregate).toBe("ready-pending-approval")
    })
  })

  describe("manual test 2026-04-27 reproduction (the canonical regression case)", () => {
    // Setup: architect has its own engineering audit clean; PM audit
    // produced 4 findings; design has 26 from designer's perspective + 15
    // architect-only = 41 from architect's perspective. Active escalation
    // already queued for PM (4 items).
    const canonical = input({
      callingAgent:    "architect",
      featureName:     "onboarding",
      ownSpec:         { specType: "engineering", status: "ready", findingCount: 0 },
      upstreamAudits:  [PM_AUDIT, DESIGN_AUDIT_BY_DESIGNER, DESIGN_AUDIT_BY_ARCH],
      activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
    })

    it("aggregate state names the active escalation, not the gap counts", () => {
      const r = buildReadinessReport(canonical)
      expect(r.aggregate).toBe("escalation-active")
    })

    it("totalFindingCount sums every source verbatim (4 + 26 + 15 = 45)", () => {
      const r = buildReadinessReport(canonical)
      expect(r.totalFindingCount).toBe(45)
    })

    it("directive surfaces the EXACT counts by source — never minimized", () => {
      const r = buildReadinessReport(canonical)
      expect(r.directive).toContain("4 product findings (Architect's audit)")
      expect(r.directive).toContain("26 design findings (Designer's audit)")
      expect(r.directive).toContain("15 design findings (Architect's audit)")
      expect(r.directive).toContain("PM is engaged on 4 items from the Architect")
    })

    it("directive forbids minimization based on user phrasing (Principle 11)", () => {
      const r = buildReadinessReport(canonical)
      expect(r.directive.toLowerCase()).toContain("must report these counts verbatim")
      expect(r.directive).toContain("Principle 11")
    })

    it("directive prescribes the next step that matches the aggregate state", () => {
      const r = buildReadinessReport(canonical)
      // escalation-active → tell user PM is engaged, reply after resolution
      expect(r.directive).toContain("PM is engaged")
      expect(r.directive.toLowerCase()).toContain("do not propose handoff yet")
    })
  })

  describe("own-spec line formatting", () => {
    it("missing draft", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "missing", findingCount: 0 },
      }))
      expect(r.directive).toContain("no draft on the spec branch yet")
    })

    it("ready clean", () => {
      const r = buildReadinessReport(input())
      expect(r.directive).toContain("internal audit clean (0 findings)")
    })

    it("dirty single — singular pluralization", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "dirty", findingCount: 1 },
      }))
      expect(r.directive).toContain("1 finding from your own audit")
      expect(r.directive).not.toContain("1 findings")
    })

    it("dirty plural — plural pluralization", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "dirty", findingCount: 7 },
      }))
      expect(r.directive).toContain("7 findings from your own audit")
    })
  })

  describe("upstream-line formatting", () => {
    it("no upstream audits → 'none applicable'", () => {
      const r = buildReadinessReport(input())
      expect(r.directive).toContain("Upstream spec audits: none applicable")
    })

    it("upstream all clean → labeled clean line, no escalation needed", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [
          { auditingAgent: "architect", specType: "product", findingCount: 0 },
          { auditingAgent: "architect", specType: "design",  findingCount: 0 },
        ],
      }))
      expect(r.directive).toContain("0 product findings")
      expect(r.directive).toContain("0 design findings")
      expect(r.directive).toContain("all clean")
    })

    it("multiple sources on the same spec are surfaced separately (P15 labeling)", () => {
      // The architect-readiness gap explicitly required: "Design has 26
      // (designer's audit) PLUS 15 (architect-only)". Each entry is one
      // labeled source.
      const r = buildReadinessReport(input({
        upstreamAudits: [DESIGN_AUDIT_BY_DESIGNER, DESIGN_AUDIT_BY_ARCH],
      }))
      expect(r.directive).toContain("26 design findings (Designer's audit)")
      expect(r.directive).toContain("15 design findings (Architect's audit)")
      expect(r.directive).toContain("= 41 total upstream findings")
    })

    it("singular pluralization within a single source", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 1 }],
      }))
      expect(r.directive).toContain("1 product finding (Architect's audit)")
      expect(r.directive).not.toMatch(/1 product findings/)
    })
  })

  describe("escalation line formatting", () => {
    it("no escalation → 'none' explicit", () => {
      const r = buildReadinessReport(input())
      expect(r.directive).toContain("Active escalation: none")
    })

    it("escalation with itemCount=1 — singular", () => {
      const r = buildReadinessReport(input({
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 1 },
      }))
      expect(r.directive).toMatch(/PM is engaged on 1 item from the Architect/)
    })

    it("escalation with itemCount>1 — plural", () => {
      const r = buildReadinessReport(input({
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 5 },
      }))
      expect(r.directive).toMatch(/PM is engaged on 5 items from the Architect/)
    })

    it("escalation summary is appended in parens when provided", () => {
      const r = buildReadinessReport(input({
        activeEscalation: {
          targetAgent: "pm",
          originAgent: "ux-design",
          itemCount: 3,
          summary: "see thread above",
        },
      }))
      expect(r.directive).toContain("PM is engaged on 3 items from the Designer (see thread above)")
    })
  })

  describe("next-step prescription matches aggregate state", () => {
    it("ready → 'state the spec is implementation-ready'", () => {
      const r = buildReadinessReport(input())
      expect(r.directive.toLowerCase()).toContain("implementation-ready")
    })

    it("dirty-own → 'offer to draft tightenings'", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "dirty", findingCount: 3 },
      }))
      expect(r.directive).toContain("offer to draft tightenings")
    })

    it("dirty-upstream → 'PM-first ordering' explicit", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [PM_AUDIT, DESIGN_AUDIT_BY_DESIGNER],
      }))
      expect(r.directive).toContain("PM-first ordering")
    })

    it("escalation-active → 'do not propose handoff yet'", () => {
      const r = buildReadinessReport(input({
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 2 },
      }))
      expect(r.directive.toLowerCase()).toContain("do not propose handoff yet")
    })
  })

  describe("cross-agent parity (Principle 15) — designer path", () => {
    // The designer's readiness check has the same shape — own design
    // spec + upstream PM audit (designer doesn't audit anything else
    // upstream because PM is the only spec above design).
    it("designer with clean own + dirty PM upstream → dirty-upstream + correct labels", () => {
      const r = buildReadinessReport({
        callingAgent:    "ux-design",
        featureName:     "onboarding",
        ownSpec:         { specType: "design", status: "ready", findingCount: 0 },
        upstreamAudits:  [{ auditingAgent: "ux-design", specType: "product", findingCount: 7 }],
        activeEscalation: null,
      })
      expect(r.aggregate).toBe("dirty-upstream")
      expect(r.directive).toContain("Designer on `onboarding`")
      expect(r.directive).toContain("7 product findings (Designer's audit)")
      expect(r.directive).toContain("PM-first ordering")
    })

    it("designer with active PM escalation → escalation-active", () => {
      const r = buildReadinessReport({
        callingAgent:    "ux-design",
        featureName:     "onboarding",
        ownSpec:         { specType: "design", status: "ready", findingCount: 0 },
        upstreamAudits:  [],
        activeEscalation: { targetAgent: "pm", originAgent: "ux-design", itemCount: 2 },
      })
      expect(r.aggregate).toBe("escalation-active")
      expect(r.directive).toContain("PM is engaged on 2 items from the Designer")
    })
  })

  describe("determinism (Principle 11)", () => {
    it("same input → byte-identical directive across repeated calls", () => {
      const i = input({
        ownSpec:         { specType: "engineering", status: "dirty", findingCount: 3 },
        upstreamAudits:  [PM_AUDIT, DESIGN_AUDIT_BY_DESIGNER],
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
      })
      const a = buildReadinessReport(i)
      const b = buildReadinessReport(i)
      const c = buildReadinessReport(i)
      expect(a.directive).toBe(b.directive)
      expect(b.directive).toBe(c.directive)
      expect(a.aggregate).toBe(b.aggregate)
      expect(a.totalFindingCount).toBe(b.totalFindingCount)
    })
  })
})

// ─── Block A3: user-facing summary (renderReadinessUserSummary integrated) ────
//
// Per docs/AGENT_RUNNER_REWRITE_MAP.md A3 decision, V2 runners use the
// `summary` field on deterministic fast-path branches (state-query check-ins,
// off-topic redirects, post-approval handoffs) — same source of truth as
// the LLM `directive`, formatted for direct posting to Slack.

describe("buildReadinessReport.summary — Block A3 fast-path user-facing renderer", () => {
  describe("aggregate=ready", () => {
    it("clean own + no upstream → 'internal audit clean' + approval prompt", () => {
      const r = buildReadinessReport(input())
      expect(r.summary).toContain("internal audit clean (0 findings)")
      expect(r.summary).toContain("Reply *approved*")
      // Ready branch uses bold "*<feature> <specType> spec*" (visual emphasis
      // on the spec identity). Backticks are reserved for the dirty-upstream
      // and escalation-active branches where the feature name needs visual
      // distinction from surrounding prose.
      expect(r.summary).toContain("*onboarding engineering spec*")
    })

    it("clean own + clean upstream → notes upstream is clean too", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 0 }],
      }))
      expect(r.summary).toContain("Upstream specs are clean")
    })
  })

  describe("aggregate=dirty-own", () => {
    it("singular finding pluralization", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "dirty", findingCount: 1 },
      }))
      expect(r.summary).toContain("1 finding from this phase's audit")
      expect(r.summary).not.toContain("1 findings")
      expect(r.summary).toContain("show items")
    })

    it("plural finding pluralization", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "dirty", findingCount: 7 },
      }))
      expect(r.summary).toContain("7 findings from this phase's audit")
    })
  })

  describe("aggregate=dirty-upstream (the canonical regression case)", () => {
    it("4 PM + 26 design + 15 design (architect-only) reproduces in user summary", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [PM_AUDIT, DESIGN_AUDIT_BY_DESIGNER, DESIGN_AUDIT_BY_ARCH],
      }))
      expect(r.summary).toContain("4 product findings")
      expect(r.summary).toContain("26 design findings")
      expect(r.summary).toContain("15 design findings")
      expect(r.summary).toContain("total 45")
      expect(r.summary).toContain("PM-first ordering")
    })

    it("only PM dirty — surfaces PM count without Design noise", () => {
      const r = buildReadinessReport(input({
        upstreamAudits: [PM_AUDIT, { auditingAgent: "architect", specType: "design", findingCount: 0 }],
      }))
      expect(r.summary).toContain("4 product findings")
      expect(r.summary).not.toContain("0 design findings")
    })
  })

  describe("aggregate=escalation-active", () => {
    it("names target agent + item count + resume instruction", () => {
      const r = buildReadinessReport(input({
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
      }))
      expect(r.summary).toContain("paused")
      expect(r.summary).toContain("PM is engaged on 4 items")
      expect(r.summary).toContain("Reply *yes*")
    })

    it("singular item pluralization", () => {
      const r = buildReadinessReport(input({
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 1 },
      }))
      expect(r.summary).toContain("PM is engaged on 1 item")
      expect(r.summary).not.toMatch(/1 items/)
    })
  })

  describe("aggregate=ready-pending-approval", () => {
    it("missing draft state → approval-gate prose", () => {
      const r = buildReadinessReport(input({
        ownSpec: { specType: "engineering", status: "missing", findingCount: 0 },
      }))
      expect(r.summary).toContain("ready for your phase's approval gate")
    })
  })

  describe("determinism (Principle 11)", () => {
    it("same input → byte-identical summary across repeated calls", () => {
      const i = input({
        upstreamAudits:  [PM_AUDIT, DESIGN_AUDIT_BY_DESIGNER],
        activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
      })
      const a = buildReadinessReport(i)
      const b = buildReadinessReport(i)
      expect(a.summary).toBe(b.summary)
    })
  })
})
