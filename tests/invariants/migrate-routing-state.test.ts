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
          "onboarding": { targetAgent: "pm", question: "Q", designContext: "" },
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
          "valid":   { targetAgent: "pm", question: "Q", designContext: "" },
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

    it("applies the same rules to escalationNotifications", () => {
      const input = fixture({
        escalationNotifications: {
          "valid":   { targetAgent: "pm", question: "Q" },
          "corrupt": { targetAgent: "wat", question: "Q" },
        },
      })
      const { cleaned, report } = migrateRoutingState(input)
      expect(report.changed).toBe(true)
      expect(Object.keys(cleaned.escalationNotifications!)).toEqual(["valid"])
      expect(report.droppedEscalationNotifications.map((d) => d.key)).toEqual(["corrupt"])
    })
  })

  describe("idempotency", () => {
    it("re-running on already-clean state reports no changes", () => {
      const input = fixture({
        pendingEscalations: {
          "onboarding": { targetAgent: "pm", question: "Q", designContext: "" },
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
          "valid":   { targetAgent: "pm", question: "Q", designContext: "" },
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
