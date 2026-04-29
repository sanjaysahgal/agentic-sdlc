// Block A6 tests — V2 designer runner. Mechanical replication of
// architect-runner-v2 tests with designer-specific assertions
// (no decision-review branch; handoff prose names architect; off-topic
// identifies as UX Designer).

import { describe, it, expect } from "vitest"
import {
  classifyDesignBranch,
  renderStateQueryFastPath,
  renderOffTopicRedirect,
  renderApprovalConfirm,
  renderStaleSpecError,
  renderEscalationEngaged,
  renderNormalAgentTurn,
  runDesignAgentV2,
  type DesignClassifierInput,
  type DesignIntent,
  type DesignStateFlags,
  type RunDesignV2Deps,
  type StateMutation,
} from "../../runtime/agents/runDesignAgentV2"
import { buildReadinessReport, type ReadinessReportInput } from "../../runtime/readiness-builder"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function reportInput(over: Partial<ReadinessReportInput> = {}): ReadinessReportInput {
  return {
    callingAgent:     "ux-design",
    featureName:      "demo-feature",
    ownSpec:          { specType: "design", status: "ready", findingCount: 0 },
    upstreamAudits:   [],  // designer's upstream is PM only
    activeEscalation: null,
    ...over,
  }
}

function intent(over: Partial<DesignIntent> = {}): DesignIntent {
  return { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false, ...over }
}

function state(over: Partial<DesignStateFlags> = {}): DesignStateFlags {
  return { hasPendingApproval: false, readOnly: false, ...over }
}

function classifierInput(over: Partial<DesignClassifierInput> = {}): DesignClassifierInput {
  return { report: buildReadinessReport(reportInput()), intent: intent(), state: state(), ...over }
}

function makeDeps(reportIn: ReadinessReportInput, overrides?: {
  fetchCurrentDraft?:    (path: string, branch: string) => Promise<string | null>
  runLLMForEscalation?:  RunDesignV2Deps["runLLMForEscalation"]
  runLLMForNormalTurn?:  RunDesignV2Deps["runLLMForNormalTurn"]
}): {
  deps: RunDesignV2Deps
  appliedMutations: StateMutation[]
  emittedTexts: string[]
  logLines: string[]
} {
  const appliedMutations: StateMutation[] = []
  const emittedTexts:     string[]        = []
  const logLines:         string[]        = []
  const deps: RunDesignV2Deps = {
    loadReport:          async () => reportIn,
    applyStateMutation:  async (m) => { appliedMutations.push(m) },
    emit:                async (t) => { emittedTexts.push(t) },
    mainChannelName:     "test-main-channel",
    fetchCurrentDraft:   overrides?.fetchCurrentDraft ?? (async () => null),
    runLLMForEscalation: overrides?.runLLMForEscalation ?? (async () => "stub-esc"),
    runLLMForNormalTurn: overrides?.runLLMForNormalTurn ?? (async () => "stub-normal"),
    log:                 (l) => { logLines.push(l) },
  }
  return { deps, appliedMutations, emittedTexts, logLines }
}

// ── Classifier tests (6 branches; no decision-review) ─────────────────────────

describe("classifyDesignBranch — pure routing", () => {
  it("readOnly=true → escalation-engaged (highest precedence)", () => {
    expect(classifyDesignBranch(classifierInput({
      state: state({ readOnly: true, hasPendingApproval: true }),
      intent: intent({ isAffirmative: true, isStateQuery: true }),
    }))).toBe("escalation-engaged")
  })

  it("hasPendingApproval + affirmative → approval-confirm", () => {
    expect(classifyDesignBranch(classifierInput({
      state:  state({ hasPendingApproval: true }),
      intent: intent({ isAffirmative: true }),
    }))).toBe("approval-confirm")
  })

  it("hasPendingApproval + non-affirmative → falls through to normal-agent-turn", () => {
    expect(classifyDesignBranch(classifierInput({
      state:  state({ hasPendingApproval: true }),
      intent: intent({ isAffirmative: false }),
    }))).toBe("normal-agent-turn")
  })

  it("isOffTopic=true → off-topic-redirect", () => {
    expect(classifyDesignBranch(classifierInput({ intent: intent({ isOffTopic: true }) })))
      .toBe("off-topic-redirect")
  })

  it("isCheckIn=true → state-query-fast-path", () => {
    expect(classifyDesignBranch(classifierInput({ intent: intent({ isCheckIn: true }) })))
      .toBe("state-query-fast-path")
  })

  it("isStateQuery=true → state-query-fast-path", () => {
    expect(classifyDesignBranch(classifierInput({ intent: intent({ isStateQuery: true }) })))
      .toBe("state-query-fast-path")
  })

  it("default branch → normal-agent-turn", () => {
    expect(classifyDesignBranch(classifierInput())).toBe("normal-agent-turn")
  })

  it("off-topic beats state-query (cannot be both)", () => {
    expect(classifyDesignBranch(classifierInput({
      intent: intent({ isOffTopic: true, isStateQuery: true }),
    }))).toBe("off-topic-redirect")
  })
})

// ── Renderer tests ────────────────────────────────────────────────────────────

describe("renderStateQueryFastPath — designer state-query (mirrors architect)", () => {
  it("emits report.summary verbatim", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStateQueryFastPath({ report: r, userMessage: "hi" })
    expect(out.text).toBe(r.summary)
  })

  it("upstream-dirty case surfaces PM count (NOT 'Nothing blocking')", () => {
    const r = buildReadinessReport(reportInput({
      upstreamAudits: [{ auditingAgent: "ux-design", specType: "product", findingCount: 5 }],
    }))
    const out = renderStateQueryFastPath({ report: r, userMessage: "hi" })
    expect(out.text).toContain("5 product findings")
    expect(out.text).not.toMatch(/Nothing blocking/i)
  })

  it("appends user + assistant messages, no spec writes", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStateQueryFastPath({ report: r, userMessage: "hi" })
    expect(out.stateMutations).toEqual([
      { kind: "append-message", role: "user",      content: "hi" },
      { kind: "append-message", role: "assistant", content: r.summary },
    ])
  })
})

describe("renderOffTopicRedirect — designer identifies as UX Designer", () => {
  it("identifies as UX Designer (not Architect)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderOffTopicRedirect({
      report: r, userMessage: "what's for lunch", mainChannelName: "general",
    })
    expect(out.text).toContain("I'm the UX Designer")
    expect(out.text).not.toContain("I'm the Architect")
  })

  it("includes main-channel name + concierge phrasing", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderOffTopicRedirect({
      report: r, userMessage: "x", mainChannelName: "general",
    })
    expect(out.text).toContain("*#general*")
    expect(out.text).toContain("concierge has the full picture")
  })

  it("surfaces report.summary alongside the redirect", () => {
    const r = buildReadinessReport(reportInput({
      upstreamAudits: [{ auditingAgent: "ux-design", specType: "product", findingCount: 2 }],
    }))
    const out = renderOffTopicRedirect({
      report: r, userMessage: "x", mainChannelName: "general",
    })
    expect(out.text).toContain(r.summary)
    expect(out.text).toContain("2 product findings")
  })
})

describe("renderApprovalConfirm — designer hands off to architect (next phase)", () => {
  it("names architect as the next phase agent (not engineer agents)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "yes", featureName: "f",
      filePath: "p.md", specContent: "c", mainChannelName: "general",
    })
    expect(out.text).toContain("software architect produces the engineering plan")
    expect(out.text).not.toContain("engineer agents")
  })

  it("emits design-spec save mutation (not engineering-spec)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "yes", featureName: "f",
      filePath: "p.md", specContent: "spec content", mainChannelName: "general",
    })
    expect(out.stateMutations).toContainEqual({
      kind: "save-approved-design-spec", filePath: "p.md", content: "spec content",
    })
    expect(out.stateMutations).toContainEqual({ kind: "clear-pending-approval" })
  })
})

describe("renderStaleSpecError — designer staleness warning", () => {
  it("emits 'design spec has been modified' (not engineering)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStaleSpecError({ report: r, userMessage: "yes" })
    expect(out.text).toContain("The design spec has been modified")
    expect(out.text).not.toContain("engineering spec has been modified")
  })

  it("clears pending-approval; appends history", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStaleSpecError({ report: r, userMessage: "yes" })
    expect(out.stateMutations).toEqual([
      { kind: "clear-pending-approval" },
      { kind: "append-message", role: "user",      content: "yes" },
      { kind: "append-message", role: "assistant", content: out.text },
    ])
  })
})

describe("renderEscalationEngaged — designer LLM with brief", () => {
  it("invokes runLLM with brief + report; emits response", async () => {
    const r = buildReadinessReport(reportInput())
    const calls: any[] = []
    const out = await renderEscalationEngaged({
      report: r, userMessage: "[BRIEF]",
      runLLM: async (i) => { calls.push(i); return "designer-response" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].brief).toBe("[BRIEF]")
    expect(out.text).toBe("designer-response")
  })
})

describe("renderNormalAgentTurn — designer LLM with directive", () => {
  it("injects report.directive + userMessage into runLLM input", async () => {
    const r = buildReadinessReport(reportInput({
      upstreamAudits: [{ auditingAgent: "ux-design", specType: "product", findingCount: 3 }],
    }))
    const calls: any[] = []
    const out = await renderNormalAgentTurn({
      report: r, userMessage: "any",
      runLLM: async (i) => { calls.push(i); return "designer-response" },
    })
    expect(calls[0].directive).toBe(r.directive)
    expect(calls[0].directive).toContain("3 product findings")
    expect(calls[0].userMessage).toBe("any")
    expect(out.text).toBe("designer-response")
  })
})

// ── Orchestrator E2E tests ────────────────────────────────────────────────────

describe("runDesignAgentV2 — orchestrator end-to-end", () => {
  it("state-query branch: report built, summary emitted, history appended", async () => {
    const reportIn = reportInput({
      upstreamAudits: [{ auditingAgent: "ux-design", specType: "product", findingCount: 2 }],
    })
    const { deps, emittedTexts, appliedMutations, logLines } = makeDeps(reportIn)

    await runDesignAgentV2({
      userMessage: "hi", featureName: "demo-feature",
      intent: intent({ isCheckIn: true }), state: state(), deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(emittedTexts[0]).toContain("2 product findings")
    expect(appliedMutations).toHaveLength(2)
    expect(logLines.some((l) => l.includes("[V2-DESIGNER]") && l.includes("branch=state-query-fast-path"))).toBe(true)
  })

  it("approval-confirm + fresh draft → renders handoff and saves approved", async () => {
    const reportIn = reportInput()
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportIn, {
      fetchCurrentDraft: async () => "# cached spec content",
    })

    await runDesignAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingApproval: true,
        pendingApprovalContext: { filePath: "p.md", specContent: "# cached spec content" },
      }),
      deps,
    })

    expect(emittedTexts[0]).toContain("approved")
    expect(emittedTexts[0]).toContain("software architect")
    expect(appliedMutations.find((m) => m.kind === "save-approved-design-spec")).toBeDefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-approval")).toBeDefined()
  })

  it("approval-confirm + STALE draft → flips to stale-spec-error, NO save", async () => {
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportInput(), {
      fetchCurrentDraft: async () => "# DIFFERENT content",
    })

    await runDesignAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingApproval: true,
        pendingApprovalContext: { filePath: "p.md", specContent: "# cached spec content" },
      }),
      deps,
    })

    expect(emittedTexts[0]).toContain("design spec has been modified")
    expect(appliedMutations.find((m) => m.kind === "save-approved-design-spec")).toBeUndefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-approval")).toBeDefined()
  })

  it("escalation-engaged routes to runLLMForEscalation (not normal)", async () => {
    let escCalled = false
    let normalCalled = false
    const { deps, emittedTexts } = makeDeps(reportInput(), {
      runLLMForEscalation: async () => { escCalled = true; return "esc" },
      runLLMForNormalTurn: async () => { normalCalled = true; return "normal" },
    })

    await runDesignAgentV2({
      userMessage: "[BRIEF]", featureName: "f",
      intent: intent(), state: state({ readOnly: true }), deps,
    })

    expect(escCalled).toBe(true)
    expect(normalCalled).toBe(false)
    expect(emittedTexts).toEqual(["esc"])
  })

  it("normal-agent-turn routes to runLLMForNormalTurn (not escalation)", async () => {
    let escCalled = false
    let normalCalled = false
    const { deps, emittedTexts } = makeDeps(reportInput(), {
      runLLMForEscalation: async () => { escCalled = true; return "esc" },
      runLLMForNormalTurn: async () => { normalCalled = true; return "normal" },
    })

    await runDesignAgentV2({
      userMessage: "any", featureName: "f", intent: intent(), state: state(), deps,
    })

    expect(normalCalled).toBe(true)
    expect(escCalled).toBe(false)
    expect(emittedTexts).toEqual(["normal"])
  })

  it("approval-confirm without pendingApprovalContext throws (defensive)", async () => {
    const { deps } = makeDeps(reportInput())
    await expect(
      runDesignAgentV2({
        userMessage: "yes", featureName: "f",
        intent: intent({ isAffirmative: true }),
        state: state({ hasPendingApproval: true }),  // ctx missing
        deps,
      })
    ).rejects.toThrow(/pendingApprovalContext missing/)
  })

  it("does NOT call emit if LLM dep throws (no half-state)", async () => {
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportInput(), {
      runLLMForNormalTurn: async () => { throw new Error("LLM-fail") },
    })

    await expect(
      runDesignAgentV2({
        userMessage: "any", featureName: "f", intent: intent(), state: state(), deps,
      })
    ).rejects.toThrow(/LLM-fail/)

    expect(emittedTexts).toEqual([])
    expect(appliedMutations).toEqual([])
  })

  it("all 6 branches dispatch without V2-NOT-IMPLEMENTED stubs", async () => {
    const allBranchInputs: Array<{ name: string; intent: DesignIntent; state: DesignStateFlags }> = [
      { name: "escalation-engaged",    intent: intent(),                       state: state({ readOnly: true }) },
      { name: "approval-confirm",      intent: intent({ isAffirmative: true }), state: state({ hasPendingApproval: true, pendingApprovalContext: { filePath: "p", specContent: "c" } }) },
      { name: "off-topic-redirect",    intent: intent({ isOffTopic: true }),   state: state() },
      { name: "state-query-fast-path", intent: intent({ isCheckIn: true }),    state: state() },
      { name: "normal-agent-turn",     intent: intent(),                       state: state() },
    ]

    for (const tc of allBranchInputs) {
      const { deps } = makeDeps(reportInput())
      await expect(
        runDesignAgentV2({
          userMessage: "test", featureName: "f", intent: tc.intent, state: tc.state, deps,
        }),
        `branch ${tc.name} threw NOT-IMPLEMENTED`
      ).resolves.not.toThrow()
    }
  })

  it("determinism: same input → byte-identical output", async () => {
    const reportIn = reportInput({
      upstreamAudits: [{ auditingAgent: "ux-design", specType: "product", findingCount: 4 }],
    })
    async function run(): Promise<{ emitted: string[]; mutations: StateMutation[] }> {
      const emitted: string[] = []
      const mutations: StateMutation[] = []
      const deps: RunDesignV2Deps = {
        loadReport: async () => reportIn,
        applyStateMutation: async (m) => { mutations.push(m) },
        emit: async (t) => { emitted.push(t) },
        mainChannelName: "general",
        fetchCurrentDraft: async () => null,
        runLLMForEscalation: async () => "e",
        runLLMForNormalTurn: async () => "n",
        log: () => {},
      }
      await runDesignAgentV2({
        userMessage: "hi", featureName: "f",
        intent: intent({ isCheckIn: true }), state: state(), deps,
      })
      return { emitted, mutations }
    }
    const a = await run()
    const b = await run()
    expect(a.emitted).toEqual(b.emitted)
    expect(a.mutations).toEqual(b.mutations)
  })
})
