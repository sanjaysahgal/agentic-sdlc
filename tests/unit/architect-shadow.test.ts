// Block A5 tests — architect shadow wrapper.
//
// Verifies shadowArchitectV2 logs one [V2-ARCHITECT-SHADOW] line per
// invocation with the right fields, never throws, and never has side
// effects (no Slack posts, no state mutations) — these last two are
// asserted by construction (the wrapper imports nothing that could
// produce side effects beyond console.log).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { shadowArchitectV2 } from "../../runtime/agents/shadow"
import type { ReadinessReportInput } from "../../runtime/readiness-builder"

describe("shadowArchitectV2 — Block A5 minimal classifier-only shadow", () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  function reportInput(over: Partial<ReadinessReportInput> = {}): ReadinessReportInput {
    return {
      callingAgent:     "architect",
      featureName:      "demo-feature",
      ownSpec:          { specType: "engineering", status: "ready", findingCount: 0 },
      upstreamAudits:   [],
      activeEscalation: null,
      ...over,
    }
  }

  it("logs one line per invocation with the canonical [V2-ARCHITECT-SHADOW] prefix", () => {
    shadowArchitectV2({
      featureName: "demo-feature",
      userMessage: "hi",
      intent: { isAffirmative: false, isCheckIn: true, isStateQuery: false, isOffTopic: false },
      state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
      reportInput: reportInput(),
    })

    expect(logSpy).toHaveBeenCalledTimes(1)
    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("[V2-ARCHITECT-SHADOW]")
    expect(line).toContain("feature=demo-feature")
  })

  it("includes the V2 classifier's branch decision in the log line", () => {
    // isCheckIn=true should classify as state-query-fast-path
    shadowArchitectV2({
      featureName: "f",
      userMessage: "hi",
      intent: { isAffirmative: false, isCheckIn: true, isStateQuery: false, isOffTopic: false },
      state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
      reportInput: reportInput(),
    })

    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("branch=state-query-fast-path")
  })

  it("includes aggregate state + total finding count in the log", () => {
    // upstream-dirty case: aggregate should be "dirty-upstream", total > 0
    shadowArchitectV2({
      featureName: "f",
      userMessage: "any",
      intent: { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
      state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
      reportInput: reportInput({
        upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 7 }],
      }),
    })

    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("aggregate=dirty-upstream")
    expect(line).toContain("total=7")
  })

  it("classifies readOnly=true → escalation-engaged (highest precedence)", () => {
    shadowArchitectV2({
      featureName: "f",
      userMessage: "[BRIEF]",
      intent: { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
      state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: true },
      reportInput: reportInput(),
    })

    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("branch=escalation-engaged")
  })

  it("classifies default (no special intent + no pending state) → normal-agent-turn", () => {
    shadowArchitectV2({
      featureName: "f",
      userMessage: "any",
      intent: { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
      state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
      reportInput: reportInput(),
    })

    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain("branch=normal-agent-turn")
  })

  it("never throws — logs SHADOW-ERROR line on internal failure (e.g. corrupted reportInput)", () => {
    // Pass a deliberately broken reportInput shape — buildReadinessReport
    // should still handle it, but if any internal step fails, the wrapper
    // must catch and log instead of throwing.
    expect(() =>
      shadowArchitectV2({
        featureName: "f",
        userMessage: "any",
        intent: { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
        state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
        // @ts-expect-error — deliberately broken for the never-throws assertion
        reportInput: null,
      }),
    ).not.toThrow()

    // Some line was logged either as success or as SHADOW-ERROR; both are acceptable.
    expect(logSpy).toHaveBeenCalled()
  })

  it("is a pure observer: returns undefined (no side effects beyond logging)", () => {
    const result = shadowArchitectV2({
      featureName: "f",
      userMessage: "any",
      intent: { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
      state:  { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
      reportInput: reportInput(),
    })
    expect(result).toBeUndefined()
  })
})
