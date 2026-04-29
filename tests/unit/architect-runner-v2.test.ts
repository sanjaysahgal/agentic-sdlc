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
  renderOffTopicRedirect,
  renderApprovalConfirm,
  renderDecisionReviewConfirm,
  renderStaleSpecError,
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

// Module-scoped makeDeps so multiple describe blocks can use it. Returns the
// deps object plus closure-captured arrays the test can assert against.
function makeDeps(reportIn: ReadinessReportInput, fetchOverride?: (path: string, branch: string) => Promise<string | null>): {
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
    mainChannelName:    "test-main-channel",
    githubOwner:        "test-owner",
    githubRepo:         "test-repo",
    fetchCurrentDraft:  fetchOverride ?? (async () => null),
    log:                (l) => { logLines.push(l) },
  }
  return { deps, appliedMutations, emittedTexts, logLines }
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

// ── Off-topic redirect tests ──────────────────────────────────────────────────

describe("renderOffTopicRedirect — surfaces redirect AND current readiness", () => {
  it("includes the main-channel name + concierge phrasing", () => {
    const report = buildReadinessReport(reportInput())
    const rendered = renderOffTopicRedirect({
      report,
      userMessage:     "what's for lunch",
      mainChannelName: "general",
    })
    expect(rendered.text).toContain("*#general*")
    expect(rendered.text).toContain("concierge has the full picture")
  })

  it("surfaces the report.summary alongside the redirect (the readiness-aware upgrade over legacy)", () => {
    const report = buildReadinessReport(reportInput({
      upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 3 }],
    }))
    const rendered = renderOffTopicRedirect({
      report,
      userMessage:     "what's for lunch",
      mainChannelName: "general",
    })
    expect(rendered.text).toContain(report.summary)
    expect(rendered.text).toContain("3 product findings")
  })

  it("identifies as Architect (so the user knows what this channel is for)", () => {
    const report = buildReadinessReport(reportInput())
    const rendered = renderOffTopicRedirect({
      report,
      userMessage:     "what's for lunch",
      mainChannelName: "general",
    })
    expect(rendered.text).toContain("I'm the Architect")
  })

  it("appends user + assistant messages to history (no spec writes)", () => {
    const report = buildReadinessReport(reportInput())
    const rendered = renderOffTopicRedirect({
      report,
      userMessage:     "what's for lunch",
      mainChannelName: "general",
    })
    expect(rendered.stateMutations).toHaveLength(2)
    expect(rendered.stateMutations[0]).toEqual({ kind: "append-message", role: "user", content: "what's for lunch" })
    expect(rendered.stateMutations[1].kind).toBe("append-message")
  })

  it("zero LLM calls — pure renderer (synchronous return)", () => {
    const report = buildReadinessReport(reportInput())
    const result = renderOffTopicRedirect({
      report,
      userMessage:     "what's for lunch",
      mainChannelName: "general",
    })
    expect(result).not.toBeInstanceOf(Promise)
  })
})

// ── Runner orchestration tests (deps-injected, full dispatch verified) ────────

describe("runArchitectAgentV2 — orchestration", () => {
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

  it("off-topic branch: full E2E through the runner emits the redirect with readiness summary inline", async () => {
    const reportIn = reportInput({
      upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 5 }],
    })
    const { deps, emittedTexts, appliedMutations, logLines } = makeDeps(reportIn)

    await runArchitectAgentV2({
      userMessage: "what's for lunch",
      featureName: "demo-feature",
      intent:      intent({ isOffTopic: true }),
      state:       state(),
      deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(emittedTexts[0]).toContain("test-main-channel")
    expect(emittedTexts[0]).toContain("5 product findings")
    expect(emittedTexts[0]).toContain("I'm the Architect")
    expect(appliedMutations).toHaveLength(2)
    expect(appliedMutations[0]).toEqual({ kind: "append-message", role: "user", content: "what's for lunch" })
    expect(logLines.some((l) => l.includes("branch=off-topic-redirect"))).toBe(true)
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

  it("remaining stub branches still throw with NOT-IMPLEMENTED + map row pointer", async () => {
    // Verifies the stubs are wired correctly into the dispatch. The error
    // message must reference the AGENT_RUNNER_REWRITE_MAP row so failures
    // surface where the V2 implementation owes work. Currently
    // escalation-engaged + normal-agent-turn are the remaining stubs;
    // this test uses readOnly=true to hit escalation-engaged.
    const { deps } = makeDeps(reportInput())

    await expect(
      runArchitectAgentV2({
        userMessage: "any",
        featureName: "demo-feature",
        intent:      intent(),
        state:       state({ readOnly: true }),
        deps,
      })
    ).rejects.toThrow(/V2-NOT-IMPLEMENTED.*AGENT_RUNNER_REWRITE_MAP/)
  })

  it("does NOT call emit if the renderer throws (no half-state)", async () => {
    const { deps, emittedTexts, appliedMutations } = makeDeps(reportInput())

    await expect(
      runArchitectAgentV2({
        userMessage: "any",
        featureName: "demo-feature",
        intent:      intent(),
        state:       state({ readOnly: true }),
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

// ── Approval-confirm renderer tests ───────────────────────────────────────────

describe("renderApprovalConfirm — post-approval handoff to engineering agents", () => {
  it("emits the canonical approval message naming the feature + main channel", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "approved", featureName: "test-feature",
      filePath: "specs/features/test-feature/test-feature.engineering.md",
      specContent: "# eng spec", mainChannelName: "general",
    })
    expect(out.text).toContain("*test-feature* engineering spec is saved and approved")
    expect(out.text).toContain(":white_check_mark:")
    expect(out.text).toContain("*#general*")
    expect(out.text).toContain("engineer agents")
  })

  it("emits state mutations: clear-pending-approval + save-approved + history (in order)", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderApprovalConfirm({
      report: r, userMessage: "yes", featureName: "test-feature",
      filePath: "specs/features/test-feature/test-feature.engineering.md",
      specContent: "# eng spec content", mainChannelName: "general",
    })
    expect(out.stateMutations).toEqual([
      { kind: "clear-pending-approval" },
      {
        kind: "save-approved-engineering-spec",
        filePath: "specs/features/test-feature/test-feature.engineering.md",
        content: "# eng spec content",
      },
      { kind: "append-message", role: "user", content: "yes" },
      { kind: "append-message", role: "assistant", content: out.text },
    ])
  })

  it("zero LLM calls — pure renderer (synchronous return)", () => {
    const result = renderApprovalConfirm({
      report: buildReadinessReport(reportInput()), userMessage: "yes",
      featureName: "f", filePath: "p", specContent: "c", mainChannelName: "general",
    })
    expect(result).not.toBeInstanceOf(Promise)
  })
})

// ── Decision-review-confirm renderer tests ────────────────────────────────────

describe("renderDecisionReviewConfirm — held content saved as draft", () => {
  it("emits canonical confirmation + GitHub URL", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderDecisionReviewConfirm({
      report: r, userMessage: "yes", featureName: "test-feature",
      filePath: "specs/features/test-feature/test-feature.engineering.md",
      specContent: "# eng spec", githubOwner: "o", githubRepo: "r",
    })
    expect(out.text).toContain("Decisions confirmed")
    expect(out.text).toContain("engineering spec draft saved")
    expect(out.text).toContain("https://github.com/o/r/blob/spec/test-feature-engineering/specs/features/test-feature/test-feature.engineering.md")
  })

  it("emits state mutations: clear-pending-decision-review + save-DRAFT (not approved) + history", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderDecisionReviewConfirm({
      report: r, userMessage: "yes", featureName: "f",
      filePath: "f.md", specContent: "content",
      githubOwner: "o", githubRepo: "r",
    })
    expect(out.stateMutations).toEqual([
      { kind: "clear-pending-decision-review" },
      { kind: "save-draft-engineering-spec", filePath: "f.md", content: "content" },
      { kind: "append-message", role: "user", content: "yes" },
      { kind: "append-message", role: "assistant", content: out.text },
    ])
  })
})

// ── Stale-spec-error renderer tests ───────────────────────────────────────────

describe("renderStaleSpecError — readiness-aware staleness warning", () => {
  it("emits the canonical 'spec was modified' warning", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStaleSpecError({ report: r, userMessage: "yes" })
    expect(out.text).toContain("The engineering spec has been modified since the approval was offered")
    expect(out.text).toContain("*approve* again when ready")
  })

  it("surfaces the report.summary alongside the warning (readiness-aware upgrade)", () => {
    const r = buildReadinessReport(reportInput({
      upstreamAudits: [{ auditingAgent: "architect", specType: "product", findingCount: 7 }],
    }))
    const out = renderStaleSpecError({ report: r, userMessage: "yes" })
    expect(out.text).toContain(r.summary)
    expect(out.text).toContain("7 product findings")
  })

  it("emits state mutations: clear-pending-approval + history", () => {
    const r = buildReadinessReport(reportInput())
    const out = renderStaleSpecError({ report: r, userMessage: "yes" })
    expect(out.stateMutations).toEqual([
      { kind: "clear-pending-approval" },
      { kind: "append-message", role: "user", content: "yes" },
      { kind: "append-message", role: "assistant", content: out.text },
    ])
  })
})

// ── Orchestrator E2E tests for the new branches ───────────────────────────────

describe("runArchitectAgentV2 orchestrator — approval / decision-review / stale-spec", () => {
  it("approval-confirm + fresh draft → renders approval handoff and saves approved", async () => {
    const reportIn = reportInput()
    const { deps, emittedTexts, appliedMutations, logLines } = (() => {
      const m: StateMutation[] = []
      const t: string[] = []
      const l: string[] = []
      const d: RunArchV2Deps = {
        loadReport: async () => reportIn,
        applyStateMutation: async (x) => { m.push(x) },
        emit: async (s) => { t.push(s) },
        mainChannelName: "general",
        githubOwner: "o", githubRepo: "r",
        fetchCurrentDraft: async () => "# cached spec content",  // fresh: matches cached
        log: (s) => { l.push(s) },
      }
      return { deps: d, appliedMutations: m, emittedTexts: t, logLines: l }
    })()

    await runArchitectAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingApproval: true,
        pendingApprovalContext: { filePath: "p.md", specContent: "# cached spec content" },
      }),
      deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(emittedTexts[0]).toContain("approved")
    expect(appliedMutations.find((m) => m.kind === "save-approved-engineering-spec")).toBeDefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-approval")).toBeDefined()
    expect(logLines.some((l) => l.includes("branch=approval-confirm"))).toBe(true)
  })

  it("approval-confirm + STALE draft → orchestrator flips to stale-spec-error renderer, NO save", async () => {
    const reportIn = reportInput()
    const { deps, emittedTexts, appliedMutations, logLines } = (() => {
      const m: StateMutation[] = []
      const t: string[] = []
      const l: string[] = []
      const d: RunArchV2Deps = {
        loadReport: async () => reportIn,
        applyStateMutation: async (x) => { m.push(x) },
        emit: async (s) => { t.push(s) },
        mainChannelName: "general",
        githubOwner: "o", githubRepo: "r",
        fetchCurrentDraft: async () => "# DIFFERENT content",  // stale: differs from cached
        log: (s) => { l.push(s) },
      }
      return { deps: d, appliedMutations: m, emittedTexts: t, logLines: l }
    })()

    await runArchitectAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingApproval: true,
        pendingApprovalContext: { filePath: "p.md", specContent: "# cached spec content" },
      }),
      deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(emittedTexts[0]).toContain("modified since the approval was offered")
    expect(appliedMutations.find((m) => m.kind === "save-approved-engineering-spec")).toBeUndefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-approval")).toBeDefined()
    expect(logLines.some((l) => l.includes("branch=stale-spec-error"))).toBe(true)
  })

  it("decision-review-confirm → renders draft-saved + clears pending-decision-review", async () => {
    const reportIn = reportInput()
    const { deps, emittedTexts, appliedMutations, logLines } = makeDeps(reportIn)

    await runArchitectAgentV2({
      userMessage: "yes", featureName: "test-feature",
      intent: intent({ isAffirmative: true }),
      state: state({
        hasPendingDecisionReview: true,
        pendingDecisionReviewContext: { filePath: "p.md", specContent: "# resolved content" },
      }),
      deps,
    })

    expect(emittedTexts).toHaveLength(1)
    expect(emittedTexts[0]).toContain("Decisions confirmed")
    expect(appliedMutations.find((m) => m.kind === "save-draft-engineering-spec")).toBeDefined()
    expect(appliedMutations.find((m) => m.kind === "clear-pending-decision-review")).toBeDefined()
    expect(logLines.some((l) => l.includes("branch=decision-review-confirm"))).toBe(true)
  })

  it("approval-confirm without pendingApprovalContext throws (defensive guard)", async () => {
    const { deps } = makeDeps(reportInput())
    await expect(
      runArchitectAgentV2({
        userMessage: "yes", featureName: "test",
        intent: intent({ isAffirmative: true }),
        state: state({ hasPendingApproval: true }),  // ctx missing
        deps,
      })
    ).rejects.toThrow(/pendingApprovalContext missing/)
  })

  it("decision-review-confirm without pendingDecisionReviewContext throws (defensive guard)", async () => {
    const { deps } = makeDeps(reportInput())
    await expect(
      runArchitectAgentV2({
        userMessage: "yes", featureName: "test",
        intent: intent({ isAffirmative: true }),
        state: state({ hasPendingDecisionReview: true }),  // ctx missing
        deps,
      })
    ).rejects.toThrow(/pendingDecisionReviewContext missing/)
  })
})
