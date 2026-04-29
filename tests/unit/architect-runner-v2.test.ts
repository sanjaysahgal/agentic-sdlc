// Block A4 step 2 tests — V2 architect runner: classifier + state-query
// branch + orchestration.
//
// Per the plan + AGENT_RUNNER_REWRITE_MAP.md, every V2 branch has a pure
// renderer testable in isolation, plus an orchestrator test that verifies
// the full runner dispatches correctly. This file covers the skeleton +
// the state-query branch shipped in this commit. Subsequent commits add
// renderer tests for the remaining branches.

import { describe, it, expect, vi } from "vitest"
import {
  classifyArchitectBranch,
  renderStateQueryFastPath,
  runArchitectAgentV2,
  type ArchitectClassifierInput,
  type ArchitectIntent,
  type ArchitectStateFlags,
  type RunArchV2Deps,
  type StateMutation,
} from "../../runtime/agents/runArchitectAgentV2"
import { buildReadinessReport, type ReadinessReportInput } from "../../runtime/readiness-builder"

// ── Test fixtures ─────────────────────────────────────────────────────────────

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

function intent(over: Partial<ArchitectIntent> = {}): ArchitectIntent {
  return {
    isAffirmative: false,
    isCheckIn:     false,
    isStateQuery:  false,
    isOffTopic:    false,
    ...over,
  }
}

function state(over: Partial<ArchitectStateFlags> = {}): ArchitectStateFlags {
  return {
    hasPendingApproval:       false,
    hasPendingDecisionReview: false,
    readOnly:                 false,
    ...over,
  }
}

function classifierInput(over: Partial<ArchitectClassifierInput> = {}): ArchitectClassifierInput {
  return {
    report: buildReadinessReport(reportInput()),
    intent: intent(),
    state:  state(),
    ...over,
  }
}

// ── Classifier tests (pure function, every branch enumerated) ─────────────────

describe("classifyArchitectBranch — pure routing of state+intent → branch kind", () => {
  describe("readOnly takes precedence", () => {
    it("readOnly=true → escalation-engaged regardless of any other flag", () => {
      expect(classifyArchitectBranch(classifierInput({
        state: state({ readOnly: true, hasPendingApproval: true }),
        intent: intent({ isAffirmative: true, isStateQuery: true }),
      }))).toBe("escalation-engaged")
    })
  })

  describe("pending decision review", () => {
    it("hasPendingDecisionReview + affirmative → decision-review-confirm", () => {
      expect(classifyArchitectBranch(classifierInput({
        state:  state({ hasPendingDecisionReview: true }),
        intent: intent({ isAffirmative: true }),
      }))).toBe("decision-review-confirm")
    })

    it("hasPendingDecisionReview + non-affirmative → falls through to normal-agent-turn", () => {
      expect(classifyArchitectBranch(classifierInput({
        state:  state({ hasPendingDecisionReview: true }),
        intent: intent({ isAffirmative: false }),
      }))).toBe("normal-agent-turn")
    })
  })

  describe("pending approval", () => {
    it("hasPendingApproval + affirmative → approval-confirm", () => {
      expect(classifyArchitectBranch(classifierInput({
        state:  state({ hasPendingApproval: true }),
        intent: intent({ isAffirmative: true }),
      }))).toBe("approval-confirm")
    })

    it("hasPendingApproval + non-affirmative → falls through", () => {
      expect(classifyArchitectBranch(classifierInput({
        state:  state({ hasPendingApproval: true }),
        intent: intent({ isAffirmative: false }),
      }))).toBe("normal-agent-turn")
    })
  })

  describe("off-topic redirect", () => {
    it("isOffTopic=true → off-topic-redirect", () => {
      expect(classifyArchitectBranch(classifierInput({
        intent: intent({ isOffTopic: true }),
      }))).toBe("off-topic-redirect")
    })
  })

  describe("state-query fast-path (the branch that retires the manual-test bug)", () => {
    it("isStateQuery=true → state-query-fast-path", () => {
      expect(classifyArchitectBranch(classifierInput({
        intent: intent({ isStateQuery: true }),
      }))).toBe("state-query-fast-path")
    })

    it("isCheckIn=true → state-query-fast-path", () => {
      expect(classifyArchitectBranch(classifierInput({
        intent: intent({ isCheckIn: true }),
      }))).toBe("state-query-fast-path")
    })

    it("both isStateQuery and isCheckIn true → state-query-fast-path (idempotent)", () => {
      expect(classifyArchitectBranch(classifierInput({
        intent: intent({ isStateQuery: true, isCheckIn: true }),
      }))).toBe("state-query-fast-path")
    })
  })

  describe("default branch", () => {
    it("no special intent + no pending state + no readOnly → normal-agent-turn", () => {
      expect(classifyArchitectBranch(classifierInput())).toBe("normal-agent-turn")
    })

    it("affirmative without any pending state → normal-agent-turn (the agent decides what affirmation means)", () => {
      expect(classifyArchitectBranch(classifierInput({
        intent: intent({ isAffirmative: true }),
      }))).toBe("normal-agent-turn")
    })
  })

  describe("precedence ordering (readOnly > decision-review > approval > off-topic > state-query > default)", () => {
    it("decision-review beats approval (decision-review goes first)", () => {
      // The architect can have both flags if the spec save was held for
      // review (pendingDecisionReview) and a prior approval is also set.
      // Decision-review wins because the user is confirming the review,
      // not the approval.
      expect(classifyArchitectBranch(classifierInput({
        state:  state({ hasPendingDecisionReview: true, hasPendingApproval: true }),
        intent: intent({ isAffirmative: true }),
      }))).toBe("decision-review-confirm")
    })

    it("off-topic beats state-query (off-topic message can't also be a state query)", () => {
      expect(classifyArchitectBranch(classifierInput({
        intent: intent({ isOffTopic: true, isStateQuery: true }),
      }))).toBe("off-topic-redirect")
    })
  })
})

// ── State-query branch tests (the load-bearing fix) ───────────────────────────

describe("renderStateQueryFastPath — the branch that retires the manual-test regression", () => {
  it("emits the report's summary verbatim (single source of truth)", () => {
    const report = buildReadinessReport(reportInput({
      ownSpec: { specType: "engineering", status: "ready", findingCount: 0 },
    }))
    const rendered = renderStateQueryFastPath({ report, userMessage: "hi" })
    expect(rendered.text).toBe(report.summary)
  })

  it("upstream-dirty case surfaces upstream counts (NOT 'Nothing blocking')", () => {
    // The exact bug from manual testing: architect said "Nothing blocking"
    // when PM had 4 findings and Design had 26+15. V2 must surface the
    // actual counts via the readiness summary.
    const report = buildReadinessReport(reportInput({
      upstreamAudits: [
        { auditingAgent: "architect", specType: "product", findingCount: 4 },
        { auditingAgent: "ux-design", specType: "design",  findingCount: 26 },
        { auditingAgent: "architect", specType: "design",  findingCount: 15 },
      ],
    }))
    const rendered = renderStateQueryFastPath({ report, userMessage: "hi" })
    expect(rendered.text).toContain("4 product findings")
    expect(rendered.text).toContain("26 design findings")
    expect(rendered.text).toContain("15 design findings")
    expect(rendered.text).not.toMatch(/Nothing blocking/i)
  })

  it("escalation-active case surfaces the queued target (NOT a generic state)", () => {
    const report = buildReadinessReport(reportInput({
      activeEscalation: { targetAgent: "pm", originAgent: "architect", itemCount: 4 },
    }))
    const rendered = renderStateQueryFastPath({ report, userMessage: "hi" })
    expect(rendered.text).toContain("paused")
    expect(rendered.text).toContain("PM is engaged on 4 items")
  })

  it("appends user + assistant messages to history (no spec writes)", () => {
    const report = buildReadinessReport(reportInput())
    const rendered = renderStateQueryFastPath({ report, userMessage: "hi" })
    expect(rendered.stateMutations).toEqual([
      { kind: "append-message", role: "user",      content: "hi" },
      { kind: "append-message", role: "assistant", content: report.summary },
    ])
  })

  it("zero LLM calls — pure renderer (asserted by the function being synchronous)", () => {
    // The function returns synchronously; if it ever needed an LLM call
    // it would be async. This is a structural assertion via the type.
    const report   = buildReadinessReport(reportInput())
    const result   = renderStateQueryFastPath({ report, userMessage: "hi" })
    expect(result).not.toBeInstanceOf(Promise)
  })
})

// ── Runner orchestration tests (deps-injected, full dispatch verified) ────────

describe("runArchitectAgentV2 — orchestration", () => {
  function makeDeps(reportIn: ReadinessReportInput): {
    deps:               RunArchV2Deps
    appliedMutations:   StateMutation[]
    emittedTexts:       string[]
    logLines:           string[]
  } {
    const appliedMutations: StateMutation[] = []
    const emittedTexts:     string[]        = []
    const logLines:         string[]        = []
    const deps: RunArchV2Deps = {
      loadReport:         async () => reportIn,
      applyStateMutation: async (m) => { appliedMutations.push(m) },
      emit:               async (t) => { emittedTexts.push(t) },
      log:                (l) => { logLines.push(l) },
    }
    return { deps, appliedMutations, emittedTexts, logLines }
  }

  it("state-query branch: report built, summary emitted, history appended", async () => {
    const reportIn = reportInput({
      upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 3 }],
    })
    const { deps, appliedMutations, emittedTexts, logLines } = makeDeps(reportIn)

    await runArchitectAgentV2({
      userMessage: "hi",
      featureName: "demo-feature",
      intent:      intent({ isCheckIn: true }),
      state:       state(),
      deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(emittedTexts[0]).toContain("3 product findings")
    expect(appliedMutations).toHaveLength(2)
    expect(appliedMutations[0]).toEqual({ kind: "append-message", role: "user", content: "hi" })
    expect(appliedMutations[1].kind).toBe("append-message")
    expect(logLines.some((l) => l.includes("[V2-ARCHITECT]") && l.includes("branch=state-query-fast-path"))).toBe(true)
  })

  it("classifier diagnostic log records the branch + aggregate", async () => {
    const { deps, logLines } = makeDeps(reportInput())

    await runArchitectAgentV2({
      userMessage: "hi",
      featureName: "demo-feature",
      intent:      intent({ isCheckIn: true }),
      state:       state(),
      deps,
    })

    expect(logLines.some((l) => l.includes("aggregate=ready"))).toBe(true)
    expect(logLines.some((l) => l.includes("totalFindings=0"))).toBe(true)
  })

  it("stub branches throw with NOT-IMPLEMENTED + map row pointer (assert subsequent commits implement them)", async () => {
    // Verifies the stubs are wired correctly into the dispatch. The error
    // message must reference the AGENT_RUNNER_REWRITE_MAP row so failures
    // surface where the V2 implementation owes work.
    const { deps } = makeDeps(reportInput())

    await expect(
      runArchitectAgentV2({
        userMessage: "any text",
        featureName: "demo-feature",
        intent:      intent({ isOffTopic: true }),
        state:       state(),
        deps,
      })
    ).rejects.toThrow(/V2-NOT-IMPLEMENTED.*AGENT_RUNNER_REWRITE_MAP/)
  })

  it("does NOT call emit if the renderer throws (no half-state)", async () => {
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportInput())

    await expect(
      runArchitectAgentV2({
        userMessage: "any text",
        featureName: "demo-feature",
        intent:      intent({ isOffTopic: true }),
        state:       state(),
        deps,
      })
    ).rejects.toThrow()

    expect(emittedTexts).toEqual([])
    expect(appliedMutations).toEqual([])
  })

  it("custom log function (default uses console.log)", async () => {
    const customLog = vi.fn()
    const reportIn  = reportInput()
    const baseDeps  = makeDeps(reportIn).deps
    const deps: RunArchV2Deps = { ...baseDeps, log: customLog }

    await runArchitectAgentV2({
      userMessage: "hi",
      featureName: "demo-feature",
      intent:      intent({ isCheckIn: true }),
      state:       state(),
      deps,
    })

    expect(customLog).toHaveBeenCalled()
    const call = customLog.mock.calls.find((c: any[]) => String(c[0]).includes("[V2-ARCHITECT]"))
    expect(call).toBeDefined()
  })
})

// ── Determinism (Principle 11) ────────────────────────────────────────────────

describe("V2 architect runner — determinism (Principle 11)", () => {
  it("same input → byte-identical output across repeated invocations", async () => {
    const reportIn = reportInput({
      upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 3 }],
    })

    async function run(): Promise<{ emitted: string[]; mutations: StateMutation[] }> {
      const emitted:   string[]        = []
      const mutations: StateMutation[] = []
      const deps: RunArchV2Deps = {
        loadReport:         async () => reportIn,
        applyStateMutation: async (m) => { mutations.push(m) },
        emit:               async (t) => { emitted.push(t) },
        log:                () => {},
      }
      await runArchitectAgentV2({
        userMessage: "hi",
        featureName: "demo-feature",
        intent:      intent({ isCheckIn: true }),
        state:       state(),
        deps,
      })
      return { emitted, mutations }
    }

    const a = await run()
    const b = await run()
    const c = await run()
    expect(a.emitted).toEqual(b.emitted)
    expect(b.emitted).toEqual(c.emitted)
    expect(a.mutations).toEqual(b.mutations)
  })
})
