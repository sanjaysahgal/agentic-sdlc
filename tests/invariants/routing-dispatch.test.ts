// Phase 2 — dispatcher tests.
//
// Verifies:
//   I15  — the dispatcher (not the router) is the only place that mutates state.
//   I16  — set-confirmed-agent must be paired with clear-history-on-phase-change.
//   I17  — re-evaluate is bounded at depth = 1; second pass is refused.
//   Order — preEffects → agent → postEffects, in that exact sequence.

import { describe, it, expect, vi } from "vitest"
import { executeDecision, assertCoupledEffects, type DispatchDeps } from "../../runtime/routing/dispatch"
import type { FeatureRoutingInput, RoutingDecision } from "../../runtime/routing/types"
import { featureKey } from "../../runtime/routing/types"

function buildDeps(): DispatchDeps & { calls: string[] } {
  const calls: string[] = []
  const log  = (s: string) => calls.push(`log:${s}`)
  return {
    calls,
    store: {
      setConfirmedAgent:           (k, a) => calls.push(`setConfirmedAgent:${k.feature}:${a}`),
      clearConfirmedAgent:         (k)    => calls.push(`clearConfirmedAgent:${k.feature}`),
      clearHistory:                (k)    => calls.push(`clearHistory:${k.feature}`),
      setPendingEscalation:        (k, v) => calls.push(`setPendingEscalation:${k.feature}:${v.targetAgent}`),
      clearPendingEscalation:      (k)    => calls.push(`clearPendingEscalation:${k.feature}`),
      setEscalationNotification:   (k, v) => calls.push(`setEscalationNotification:${k.feature}:${v.targetAgent}`),
      clearEscalationNotification: (k)    => calls.push(`clearEscalationNotification:${k.feature}`),
      setPendingApproval:          (k, v) => calls.push(`setPendingApproval:${k.feature}:${v.specType}`),
      clearPendingApproval:        (k)    => calls.push(`clearPendingApproval:${k.feature}`),
      setPendingDecisionReview:    (k)    => calls.push(`setPendingDecisionReview:${k.feature}`),
      clearPendingDecisionReview:  (k)    => calls.push(`clearPendingDecisionReview:${k.feature}`),
      advanceDecisionReviewCursor: (k)    => calls.push(`advanceDecisionReviewCursor:${k.feature}`),
      setThreadAgent:              (k, a) => calls.push(`setThreadAgent:${k.thread}:${a}`),
      clearThreadAgent:            (k)    => calls.push(`clearThreadAgent:${k.thread}`),
      markUserOriented:            (k, u) => calls.push(`markUserOriented:${k.feature}:${u}`),
    },
    runAgent:                  vi.fn(async (a, m) => { calls.push(`runAgent:${a}:${m}`) }),
    patchSpec:                 vi.fn(async ({ specType }) => { calls.push(`patchSpec:${specType}`) }),
    writebackToMain:           vi.fn(async ({ specType }) => { calls.push(`writebackToMain:${specType}`) }),
    postSlackMessage:          vi.fn(async (t)            => { calls.push(`postSlackMessage:${t.slice(0, 20)}`) }),
    reAuditAndMaybeReEscalate: vi.fn(async (k)            => { calls.push(`reAudit:${k.feature}`) }),
    autoContinue:              vi.fn(async (m)            => { calls.push(`autoContinue:${m.slice(0, 20)}`) }),
    reEvaluate:                vi.fn((_input)             => ({ kind: "no-active-agent", preEffects: [], postEffects: [] }) as RoutingDecision),
    log,
  }
}

const KEY = featureKey("dispatch-test")
const INPUT: FeatureRoutingInput = {
  channel: "feature",
  key: KEY,
  entry: "E1",
  phase: "design-in-progress",
  state: {
    confirmedAgent: null,
    pendingEscalation: null,
    escalationNotification: null,
    pendingApproval: null,
    pendingDecisionReview: null,
    isUserOriented: true,
    history: [],
  },
  intent: { kind: "slack-message", rawText: "hi", userId: "U_TEST" as any },
  depth: 0,
}

describe("executeDecision", () => {
  it("applies preEffects → agent run → postEffects in order", async () => {
    const deps = buildDeps()
    const decision: RoutingDecision = {
      kind: "run-escalation-confirmed",
      originAgent: "ux-design",
      targetAgent: "pm",
      preEffects: [
        { kind: "clear-pending-escalation", key: KEY },
        { kind: "set-escalation-notification", key: KEY, value: { targetAgent: "pm", question: "q", originAgent: "design" } },
      ],
      postEffects: [
        { kind: "post-slack-message", text: "PM @mentioned, awaiting reply" },
      ],
    }

    await executeDecision(decision, INPUT, deps)

    const sequence = deps.calls.filter((c) => !c.startsWith("log:"))
    expect(sequence).toEqual([
      "clearPendingEscalation:dispatch-test",
      "setEscalationNotification:dispatch-test:pm",
      "runAgent:pm:primary",
      "postSlackMessage:PM @mentioned, await",
    ])
  })

  it("does NOT call runAgent for purely-display decisions like show-hold-message", async () => {
    const deps = buildDeps()
    const decision: RoutingDecision = {
      kind: "show-hold-message",
      heldAgent: "pm",
      reason: "escalation",
      preEffects: [],
      postEffects: [{ kind: "post-slack-message", text: "PM is paused — say yes to bring them back." }],
    }
    await executeDecision(decision, INPUT, deps)
    expect(deps.runAgent).not.toHaveBeenCalled()
    expect(deps.postSlackMessage).toHaveBeenCalledOnce()
  })

  it("logs one [DISPATCH] line per call with kind, effect counts, and durationMs", async () => {
    const deps = buildDeps()
    const decision: RoutingDecision = { kind: "no-active-agent", preEffects: [], postEffects: [] }
    await executeDecision(decision, INPUT, deps)
    const dispatchLine = deps.calls.find((c) => c.includes("[DISPATCH]"))
    expect(dispatchLine).toMatch(/kind=no-active-agent preEffects=0 postEffects=0 reEvaluated=false durationMs=\d+/)
  })

  describe("I17 — bounded re-evaluate", () => {
    it("at depth=0, re-evaluate calls reEvaluate(input) and dispatches the new decision", async () => {
      const deps = buildDeps()
      // Make reEvaluate return a decision that itself runs an agent so we can see
      // the second pass produced a side effect.
      deps.reEvaluate = vi.fn((_input) => ({
        kind: "run-agent",
        agent: "concierge",
        mode: "primary",
        preEffects: [],
        postEffects: [],
      }) as RoutingDecision)

      const decision: RoutingDecision = {
        kind: "run-agent",
        agent: "pm",
        mode: "primary",
        preEffects: [],
        postEffects: [{ kind: "re-evaluate" }],
      }
      await executeDecision(decision, INPUT, deps)

      expect(deps.reEvaluate).toHaveBeenCalledOnce()
      expect(deps.runAgent).toHaveBeenCalledTimes(2) // first pass + re-evaluated pass
    })

    it("at depth=1, re-evaluate is refused and logged as DISPATCH-ERROR", async () => {
      const deps = buildDeps()
      const inputAtDepth1 = { ...INPUT, depth: 1 as 0 | 1 }
      const decision: RoutingDecision = {
        kind: "run-agent",
        agent: "pm",
        mode: "primary",
        preEffects: [],
        postEffects: [{ kind: "re-evaluate" }],
      }
      await executeDecision(decision, inputAtDepth1, deps)

      expect(deps.reEvaluate).not.toHaveBeenCalled()
      const errLine = deps.calls.find((c) => c.includes("[DISPATCH-ERROR]"))
      expect(errLine).toBeDefined()
      expect(errLine).toContain("re-evaluate refused")
    })
  })
})

describe("assertCoupledEffects (I16)", () => {
  it("passes when set-confirmed-agent is followed by clear-history-on-phase-change", () => {
    const decision: RoutingDecision = {
      kind: "run-agent",
      agent: "ux-design",
      mode: "primary",
      preEffects: [
        { kind: "set-confirmed-agent", key: KEY, agent: "ux-design" },
        { kind: "clear-history-on-phase-change", key: KEY },
      ],
      postEffects: [],
    }
    expect(() => assertCoupledEffects(decision)).not.toThrow()
  })

  it("throws when set-confirmed-agent is NOT followed by clear-history-on-phase-change", () => {
    const decision: RoutingDecision = {
      kind: "run-agent",
      agent: "ux-design",
      mode: "primary",
      preEffects: [
        { kind: "set-confirmed-agent", key: KEY, agent: "ux-design" },
        { kind: "clear-pending-approval", key: KEY }, // wrong next effect
      ],
      postEffects: [],
    }
    expect(() => assertCoupledEffects(decision)).toThrow(/I16 violated/)
  })

  it("throws when set-confirmed-agent and the following clear-history reference different keys", () => {
    const decision: RoutingDecision = {
      kind: "run-agent",
      agent: "ux-design",
      mode: "primary",
      preEffects: [
        { kind: "set-confirmed-agent", key: KEY, agent: "ux-design" },
        { kind: "clear-history-on-phase-change", key: featureKey("other-feature") },
      ],
      postEffects: [],
    }
    expect(() => assertCoupledEffects(decision)).toThrow(/same key/)
  })
})
