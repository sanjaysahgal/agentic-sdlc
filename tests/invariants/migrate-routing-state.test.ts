// Phase 5 / I2 — tests for the on-disk routing-state migration.
//
// The migration runs once before Phase 4 cutover (and idempotently afterwards
// if needed) to drop any pendingEscalation / escalationNotification entry
// whose targetAgent isn't a valid AgentId. These tests pin the contract:
//
//   - Corrupt entries are dropped with a documented reason
//   - Valid entries (including the legacy "design" alias) are preserved
//   - Missing or non-string targetAgent → drop
//   - Re-running on already-clean state is a no-op (changed: false)
//   - Other top-level fields (pendingApprovals, threadAgents, …) pass through

import { describe, it, expect } from "vitest"
import { migrateRoutingState, type RoutingStateOnDisk } from "../../scripts/migrate-routing-state-v2"

function fixture(over: Partial<RoutingStateOnDisk> = {}): RoutingStateOnDisk {
  return {
    pendingEscalations:      {},
    escalationNotifications: {},
    pendingApprovals:        {},
    threadAgents:            {},
    orientedUsers:           [],
    ...over,
  }
}

describe("migrateRoutingState — Phase 5 / I2", () => {
  describe("validation rules", () => {
    it("preserves entries whose targetAgent is a valid AgentId", () => {
      const input = fixture({
        pendingEscalations: {
          "onboarding": { targetAgent: "pm", productSpec: "approved", question: "Q", designContext: "" },
          "checkout":   { targetAgent: "architect", question: "Q", designContext: "" },
          "search":     { targetAgent: "ux-design", question: "Q", designContext: "" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(false)
      expect(Object.keys(cleaned.pendingEscalations!).sort()).toEqual(["checkout", "onboarding", "search"])
      expect(report.droppedPendingEscalations).toEqual([])
    })

    it("preserves entries with the legacy 'design' alias (canonicalized at read time, not migration time)", () => {
      // "design" is a non-pm target — productSpec is not required.
      const input = fixture({
        pendingEscalations: {
          "onboarding": { targetAgent: "design", question: "Q", designContext: "" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(false)
      expect(cleaned.pendingEscalations!["onboarding"]).toBeDefined()
      expect((cleaned.pendingEscalations!["onboarding"] as any).targetAgent).toBe("design")
    })

    it("drops entries with corrupt targetAgent (typo, removed agent, garbage)", () => {
      const input = fixture({
        pendingEscalations: {
          "valid":   { targetAgent: "pm", productSpec: "approved", question: "Q", designContext: "" },
          "typo":    { targetAgent: "pmm", question: "Q", designContext: "" },
          "removed": { targetAgent: "old-agent-name", question: "Q", designContext: "" },
          "garbage": { targetAgent: "🚀", question: "Q", designContext: "" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(Object.keys(cleaned.pendingEscalations!)).toEqual(["valid"])
      expect(report.droppedPendingEscalations.map((d) => d.key).sort()).toEqual(["garbage", "removed", "typo"])
      // Each drop carries a human-readable reason.
      for (const drop of report.droppedPendingEscalations) {
        expect(drop.reason).toMatch(/corrupt targetAgent value/)
      }
    })

    it("drops entries with missing or non-string targetAgent", () => {
      const input = fixture({
        pendingEscalations: {
          "missing":    { question: "Q", designContext: "" } as any,
          "null":       { targetAgent: null, question: "Q", designContext: "" } as any,
          "numeric":    { targetAgent: 42, question: "Q", designContext: "" } as any,
          "object":     { targetAgent: { kind: "pm" }, question: "Q", designContext: "" } as any,
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(Object.keys(cleaned.pendingEscalations!)).toEqual([])
      for (const drop of report.droppedPendingEscalations) {
        expect(drop.reason).toMatch(/missing-or-non-string targetAgent/)
      }
    })

    it("applies the same targetAgent rules to escalationNotifications", () => {
      const input = fixture({
        escalationNotifications: {
          "valid":   { targetAgent: "pm", originAgent: "ux-design", question: "Q" },
          "corrupt": { targetAgent: "wat", originAgent: "ux-design", question: "Q" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(Object.keys(cleaned.escalationNotifications!)).toEqual(["valid"])
      expect(report.droppedEscalationNotifications.map((d) => d.key)).toEqual(["corrupt"])
    })
  })

  describe("I8 — escalationNotification.originAgent required", () => {
    it("drops entries with missing originAgent (FLAG-D pre-Phase-5 silently routed to ux-design)", () => {
      const input = fixture({
        escalationNotifications: {
          "withOrigin":    { targetAgent: "pm", originAgent: "architect", question: "Q" },
          "missingOrigin": { targetAgent: "pm", question: "Q" } as any,
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(Object.keys(cleaned.escalationNotifications!)).toEqual(["withOrigin"])
      expect(report.droppedEscalationNotifications[0].key).toBe("missingOrigin")
      expect(report.droppedEscalationNotifications[0].reason).toMatch(/missing-or-non-string originAgent/)
    })

    it("drops entries with corrupt originAgent (typo, removed agent, garbage)", () => {
      const input = fixture({
        escalationNotifications: {
          "valid":         { targetAgent: "pm", originAgent: "ux-design", question: "Q" },
          "typoOrigin":    { targetAgent: "pm", originAgent: "uxdesign",   question: "Q" },
          "removedOrigin": { targetAgent: "pm", originAgent: "old-name",   question: "Q" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(Object.keys(cleaned.escalationNotifications!)).toEqual(["valid"])
      for (const drop of report.droppedEscalationNotifications) {
        expect(drop.reason).toMatch(/corrupt originAgent/)
      }
    })

    it("preserves the legacy 'design' alias as a valid originAgent (pre-Phase-5 records carry it)", () => {
      const input = fixture({
        escalationNotifications: {
          "legacy": { targetAgent: "pm", originAgent: "design", question: "Q" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(false)
      expect(cleaned.escalationNotifications!["legacy"]).toBeDefined()
    })

    it("targetAgent corruption takes precedence over originAgent corruption (single-reason drop)", () => {
      const input = fixture({
        escalationNotifications: {
          "bothCorrupt": { targetAgent: "wat", originAgent: "also-wat", question: "Q" } as any,
        },
      })
      const { report } = migrateRoutingState(input)
      expect(report.droppedEscalationNotifications).toHaveLength(1)
      expect(report.droppedEscalationNotifications[0].reason).toMatch(/corrupt targetAgent/)
    })

    it("pendingEscalations are unaffected by originAgent rules (they don't carry an origin field)", () => {
      const input = fixture({
        pendingEscalations: {
          "noOrigin": { targetAgent: "pm", productSpec: "approved spec", question: "Q", designContext: "" },
        },
      })
      const { report } = migrateRoutingState(input)
      expect(report.changed).toBe(false)
      expect(report.droppedPendingEscalations).toEqual([])
    })
  })

  describe("FLAG-5 — pendingEscalation.productSpec required when target=pm", () => {
    it("preserves pm-target entries that carry a non-empty productSpec", () => {
      const input = fixture({
        pendingEscalations: {
          "withSpec": { targetAgent: "pm", productSpec: "## AC\n1. SSO sign-in.", question: "Q", designContext: "" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(false)
      expect(cleaned.pendingEscalations!["withSpec"]).toBeDefined()
    })

    it("drops pm-target entries with missing productSpec", () => {
      const input = fixture({
        pendingEscalations: {
          "missingSpec": { targetAgent: "pm", question: "Q", designContext: "" } as any,
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(cleaned.pendingEscalations).toEqual({})
      expect(report.droppedPendingEscalations[0].reason).toMatch(/missing-or-empty productSpec for target=pm \(FLAG-5\)/)
    })

    it("drops pm-target entries with empty-string productSpec", () => {
      const input = fixture({
        pendingEscalations: {
          "emptySpec":      { targetAgent: "pm", productSpec: "",     question: "Q", designContext: "" },
          "whitespaceSpec": { targetAgent: "pm", productSpec: "   ", question: "Q", designContext: "" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(cleaned.pendingEscalations).toEqual({})
      expect(report.droppedPendingEscalations.map((d) => d.key).sort()).toEqual(["emptySpec", "whitespaceSpec"])
    })

    it("drops pm-target entries with non-string productSpec", () => {
      const input = fixture({
        pendingEscalations: {
          "nullSpec": { targetAgent: "pm", productSpec: null,            question: "Q", designContext: "" } as any,
          "objSpec":  { targetAgent: "pm", productSpec: { content: "x" }, question: "Q", designContext: "" } as any,
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(cleaned.pendingEscalations).toEqual({})
    })

    it("does NOT enforce productSpec on non-pm targets (architect / design / ux-design)", () => {
      const input = fixture({
        pendingEscalations: {
          "architectNoSpec": { targetAgent: "architect", question: "Q", designContext: "draft" },
          "designNoSpec":    { targetAgent: "design",    question: "Q", designContext: "draft" },
          "uxDesignNoSpec":  { targetAgent: "ux-design", question: "Q", designContext: "draft" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(false)
      expect(Object.keys(cleaned.pendingEscalations!).sort()).toEqual(["architectNoSpec", "designNoSpec", "uxDesignNoSpec"])
    })

    it("targetAgent corruption takes precedence over FLAG-5 (single-reason drop)", () => {
      const input = fixture({
        pendingEscalations: {
          "corruptAndNoSpec": { targetAgent: "wat", question: "Q", designContext: "" } as any,
        },
      })
      const { report } = migrateRoutingState(input)
      expect(report.droppedPendingEscalations).toHaveLength(1)
      expect(report.droppedPendingEscalations[0].reason).toMatch(/corrupt targetAgent/)
    })
  })

  describe("idempotency", () => {
    it("re-running on already-clean state reports no changes", () => {
      const input = fixture({
        pendingEscalations: {
          "onboarding": { targetAgent: "pm", productSpec: "approved", question: "Q", designContext: "" },
        },
      })
      const first  = migrateRoutingState(input)
      const second = migrateRoutingState(first.cleaned)
      expect(second.report.changed).toBe(false)
      expect(second.report.droppedPendingEscalations).toEqual([])
      expect(second.cleaned).toEqual(first.cleaned)
    })

    it("re-running after a cleanup converges (no infinite drift)", () => {
      const input = fixture({
        pendingEscalations: {
          "valid":   { targetAgent: "pm", productSpec: "approved", question: "Q", designContext: "" },
          "corrupt": { targetAgent: "wat", question: "Q", designContext: "" },
        },
      })
      const r1 = migrateRoutingState(input)
      const r2 = migrateRoutingState(r1.cleaned)
      const r3 = migrateRoutingState(r2.cleaned)
      expect(r1.report.changed).toBe(true)
      expect(r2.report.changed).toBe(false)
      expect(r3.report.changed).toBe(false)
      expect(r3.cleaned).toEqual(r2.cleaned)
    })
  })

  describe("pass-through", () => {
    it("does not modify pendingApprovals, threadAgents, orientedUsers, or unknown fields", () => {
      const input = fixture({
        pendingApprovals: {
          "onboarding": { specType: "product", specContent: "...", filePath: "x.md", featureName: "onboarding" } as any,
        },
        threadAgents: { "T1": "pm" },
        orientedUsers: ["onboarding/U1"],
        someFutureField: { keep: "me" } as any,
      })
      const { cleaned } = migrateRoutingState(input)
      expect(cleaned.pendingApprovals).toEqual(input.pendingApprovals)
      expect(cleaned.threadAgents).toEqual(input.threadAgents)
      expect(cleaned.orientedUsers).toEqual(input.orientedUsers)
      expect(cleaned.someFutureField).toEqual(input.someFutureField)
    })

    it("handles missing top-level fields without throwing (fresh install)", () => {
      const { cleaned, report } = migrateRoutingState({})
      expect(report.changed).toBe(false)
      expect(cleaned).toEqual({})
    })
  })
})
