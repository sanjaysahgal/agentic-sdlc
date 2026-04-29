// Block A7 tests — V2 PM runner. Mechanical replication of design-runner-v2
// tests with PM-specific assertions (no decision-review branch; handoff
// prose names UX designer; off-topic identifies as Product Manager;
// upstreamAudits always [] because PM is the head of the spec chain).

import { describe, it, expect } from "vitest"
import {
  classifyPmBranch,
  renderStateQueryFastPath,
  renderOffTopicRedirect,
  renderApprovalConfirm,
  renderStaleSpecError,
  renderEscalationEngaged,
  renderNormalAgentTurn,
  runPmAgentV2,
  type PmClassifierInput,
  type PmIntent,
  type PmStateFlags,
  type RunPmV2Deps,
  type StateMutation,
} from "../../runtime/agents/runPmAgentV2"
import { buildReadinessReport, type ReadinessReportInput } from "../../runtime/readiness-builder"

// ── Fixtures ──────────────────────────────────────────────────────────────────

function reportInput(over: Partial<ReadinessReportInput> = {}): ReadinessReportInput {
  return {
    callingAgent:     "pm",
    featureName:      "demo-feature",
    ownSpec:          { specType: "product", status: "ready", findingCount: 0 },
    upstreamAudits:   [],  // PM has no upstream — always empty
    activeEscalation: null,
    ...over,
  }
}

function intent(over: Partial<PmIntent> = {}): PmIntent {
  return { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false, ...over }
}

function state(over: Partial<PmStateFlags> = {}): PmStateFlags {
  return { hasPendingApproval: false, readOnly: false, ...over }
}

function classifierInput(over: Partial<PmClassifierInput> = {}): PmClassifierInput {
  return { report: buildReadinessReport(reportInput()), intent: intent(), state: state(), ...over }
}

function makeDeps(reportIn: ReadinessReportInput, overrides?: {
  fetchCurrentDraft?:    (path: string, branch: string) => Promise<string | null>
  runLLMForEscalation?:  RunPmV2Deps["runLLMForEscalation"]
  runLLMForNormalTurn?:  RunPmV2Deps["runLLMForNormalTurn"]
}): {
  deps: RunPmV2Deps
  appliedMutations: StateMutation[]
  emittedTexts: string[]
  logLines: string[]
} {
  const appliedMutations: StateMutation[] = []
  const emittedTexts:     string[]        = []
  const logLines:         string[]        = []
  const deps: RunPmV2Deps = {
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

describe("classifyPmBranch — pure routing", () => {
  it("readOnly=true → escalation-engaged (highest precedence)", () => {
    expect(classifyPmBranch(classifierInput({
      state: state({ readOnly: true, hasPendingApproval: true }),
      intent: intent({ isAffirmative: true, isStateQuery: true }),
    }))).toBe("escalation-engaged")
  })

  it("hasPendingApproval + affirmative → approval-confirm", () => {
    expect(classifyPmBranch(classifierInput({
      state:  state({ hasPendingApproval: true }),
      intent: intent({ isAffirmative: true }),
    }))).toBe("approval-confirm")
  })

  it("hasPendingApproval + non-affirmative → falls through to normal-agent-turn", () => {
    expect(classifyPmBranch(classifierInput({
      state:  state({ hasPendingApproval: true }),
      intent: intent({ isAffirmative: false }),
    }))).toBe("normal-agent-turn")
  })

  it("isOffTopic=true → off-topic-redirect", () => {
    expect(classifyPmBranch(classifierInput({ intent: intent({ isOffTopic: true }) })))
      .toBe("off-topic-redirect")
  })

  it("isCheckIn=true → state-query-fast-path", () => {
    expect(classifyPmBranch(classifierInput({ intent: intent({ isCheckIn: true }) })))
      .toBe("state-query-fast-path")
  })

  it("isStateQuery=true → state-query-fast-path", () => {
    expect(classifyPmBranch(classifierInput({ intent: intent({ isStateQuery: true }) })))
      .toBe("state-query-fast-path")
  })

  it("default branch → normal-agent-turn", () => {
    expect(classifyPmBranch(classifierInput())).toBe("normal-agent-turn")
  })

  it("off-topic beats state-query (cannot be both)", () => {
    expect(classifyPmBranch(classifierInput({
      intent: intent({ isOffTopic: true, isStateQuery: true }),
    }))).toBe("off-topic-redirect")
  })
})

// ── Renderer tests ────────────────────────────────────────────────────────────

describe("renderStateQueryFastPath — PM state-query (mirrors architect/designer)", () => {
  it("emits report.summary verbatim", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStateQueryFastPath({ report: r, userMessage: "hi" })
    expect(out.text).toBe(r.summary)
  })

  it("PM dirty-own case surfaces own findings (no upstream)", () => {
    const r = buildReadinessReport(reportInput({
      ownSpec: { specType: "product", status: "dirty", findingCount: 7 },
    }))
    const out = renderStateQueryFastPath({ report: r, userMessage: "hi" })
    expect(out.text).toBe(r.summary)
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

describe("renderOffTopicRedirect — PM identifies as Product Manager", () => {
  it("identifies as Product Manager (not UX Designer or Architect)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderOffTopicRedirect({
      report: r, userMessage: "what's for lunch", mainChannelName: "general",
    })
    expect(out.text).toContain("I'm the Product Manager")
    expect(out.text).not.toContain("I'm the UX Designer")
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
      ownSpec: { specType: "product", status: "dirty", findingCount: 3 },
    }))
    const out = renderOffTopicRedirect({
      report: r, userMessage: "x", mainChannelName: "general",
    })
    expect(out.text).toContain(r.summary)
  })
})

describe("renderApprovalConfirm — PM hands off to UX designer (next phase)", () => {
  it("names UX designer as the next phase agent (not architect)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "yes", featureName: "f",
      filePath: "p.md", specContent: "c", mainChannelName: "general",
    })
    expect(out.text).toContain("UX designer produces the screens")
    expect(out.text).not.toContain("software architect")
  })

  it("emits product-spec save mutation (not design or engineering)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "yes", featureName: "f",
      filePath: "p.md", specContent: "spec content", mainChannelName: "general",
    })
    expect(out.stateMutations).toContainEqual({
      kind: "save-approved-product-spec", filePath: "p.md", content: "spec content",
    })
    expect(out.stateMutations).toContainEqual({ kind: "clear-pending-approval" })
  })

  it("uses 'product spec' wording (not 'design spec' or 'engineering spec')", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "yes", featureName: "demo",
      filePath: "p.md", specContent: "c", mainChannelName: "general",
    })
    expect(out.text).toContain("*demo* product spec")
    expect(out.text).not.toContain("design spec")
    expect(out.text).not.toContain("engineering spec")
  })
})

describe("renderStaleSpecError — PM staleness warning", () => {
  it("emits 'product spec has been modified' (not design or engineering)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStaleSpecError({ report: r, userMessage: "yes" })
    expect(out.text).toContain("The product spec has been modified")
    expect(out.text).not.toContain("design spec has been modified")
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

describe("renderEscalationEngaged — PM LLM with brief", () => {
  it("invokes runLLM with brief + report; emits response", async () => {
    const r = buildReadinessReport(reportInput())
    const calls: any[] = []
    const out = await renderEscalationEngaged({
      report: r, userMessage: "[BRIEF]",
      runLLM: async (i) => { calls.push(i); return "pm-response" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].brief).toBe("[BRIEF]")
    expect(out.text).toBe("pm-response")
  })
})

describe("renderNormalAgentTurn — PM LLM with directive", () => {
  it("injects report.directive + userMessage into runLLM input", async () => {
    const r = buildReadinessReport(reportInput({
      ownSpec: { specType: "product", status: "dirty", findingCount: 2 },
    }))
    const calls: any[] = []
    const out = await renderNormalAgentTurn({
      report: r, userMessage: "any",
      runLLM: async (i) => { calls.push(i); return "pm-response" },
    })
    expect(calls[0].directive).toBe(r.directive)
    expect(calls[0].userMessage).toBe("any")
    expect(out.text).toBe("pm-response")
  })
})

// ── Orchestrator E2E tests ────────────────────────────────────────────────────

describe("runPmAgentV2 — orchestrator end-to-end", () => {
  it("state-query branch: report built, summary emitted, history appended", async () => {
    const reportIn = reportInput({
      ownSpec: { specType: "product", status: "dirty", findingCount: 4 },
    })
    const { deps, emittedTexts, appliedMutations, logLines } = makeDeps(reportIn)

    await runPmAgentV2({
      userMessage: "hi", featureName: "demo-feature",
      intent: intent({ isCheckIn: true }), state: state(), deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(appliedMutations).toHaveLength(2)
    expect(logLines.some((l) => l.includes("[V2-PM]") && l.includes("branch=state-query-fast-path"))).toBe(true)
  })

  it("approval-confirm + fresh draft → renders handoff and saves approved", async () => {
    const reportIn = reportInput()
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportIn, {
      fetchCurrentDraft: async () => "# cached spec content",
    })

    await runPmAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingApproval: true,
        pendingApprovalContext: { filePath: "p.md", specContent: "# cached spec content" },
      }),
      deps,
    })

    expect(emittedTexts[0]).toContain("approved")
    expect(emittedTexts[0]).toContain("UX designer")
    expect(appliedMutations.find((m) => m.kind === "save-approved-product-spec")).toBeDefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-approval")).toBeDefined()
  })

  it("approval-confirm + STALE draft → flips to stale-spec-error, NO save", async () => {
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportInput(), {
      fetchCurrentDraft: async () => "# DIFFERENT content",
    })

    await runPmAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingApproval: true,
        pendingApprovalContext: { filePath: "p.md", specContent: "# cached spec content" },
      }),
      deps,
    })

    expect(emittedTexts[0]).toContain("product spec has been modified")
    expect(appliedMutations.find((m) => m.kind === "save-approved-product-spec")).toBeUndefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-approval")).toBeDefined()
  })

  it("escalation-engaged routes to runLLMForEscalation (not normal)", async () => {
    let escCalled = false
    let normalCalled = false
    const { deps, emittedTexts } = makeDeps(reportInput(), {
      runLLMForEscalation: async () => { escCalled = true; return "esc" },
      runLLMForNormalTurn: async () => { normalCalled = true; return "normal" },
    })

    await runPmAgentV2({
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

    await runPmAgentV2({
      userMessage: "any", featureName: "f", intent: intent(), state: state(), deps,
    })

    expect(normalCalled).toBe(true)
    expect(escCalled).toBe(false)
    expect(emittedTexts).toEqual(["normal"])
  })

  it("approval-confirm without pendingApprovalContext throws (defensive)", async () => {
    const { deps } = makeDeps(reportInput())
    await expect(
      runPmAgentV2({
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
      runPmAgentV2({
        userMessage: "any", featureName: "f", intent: intent(), state: state(), deps,
      })
    ).rejects.toThrow(/LLM-fail/)

    expect(emittedTexts).toEqual([])
    expect(appliedMutations).toEqual([])
  })

  it("all 6 branches dispatch without V2-NOT-IMPLEMENTED stubs", async () => {
    const allBranchInputs: Array<{ name: string; intent: PmIntent; state: PmStateFlags }> = [
      { name: "escalation-engaged",    intent: intent(),                        state: state({ readOnly: true }) },
      { name: "approval-confirm",      intent: intent({ isAffirmative: true }), state: state({ hasPendingApproval: true, pendingApprovalContext: { filePath: "p", specContent: "c" } }) },
      { name: "off-topic-redirect",    intent: intent({ isOffTopic: true }),    state: state() },
      { name: "state-query-fast-path", intent: intent({ isCheckIn: true }),     state: state() },
      { name: "normal-agent-turn",     intent: intent(),                        state: state() },
    ]

    for (const tc of allBranchInputs) {
      const { deps } = makeDeps(reportInput())
      await expect(
        runPmAgentV2({
          userMessage: "test", featureName: "f", intent: tc.intent, state: tc.state, deps,
        }),
        `branch ${tc.name} threw NOT-IMPLEMENTED`
      ).resolves.not.toThrow()
    }
  })

  it("determinism: same input → byte-identical output", async () => {
    const reportIn = reportInput({
      ownSpec: { specType: "product", status: "dirty", findingCount: 5 },
    })
    async function run(): Promise<{ emitted: string[]; mutations: StateMutation[] }> {
      const emitted: string[] = []
      const mutations: StateMutation[] = []
      const deps: RunPmV2Deps = {
        loadReport: async () => reportIn,
        applyStateMutation: async (m) => { mutations.push(m) },
        emit: async (t) => { emitted.push(t) },
        mainChannelName: "general",
        fetchCurrentDraft: async () => null,
        runLLMForEscalation: async () => "e",
        runLLMForNormalTurn: async () => "n",
        log: () => {},
      }
      await runPmAgentV2({
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
