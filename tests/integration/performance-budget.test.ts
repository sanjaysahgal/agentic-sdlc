// Block D3 — per-turn performance budget (synthetic).
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`.
// V2 single-path runners must complete a turn under a synthetic budget
// when LLM latencies are mocked to deterministic values. The budget
// catches unbounded loops, accidental synchronous I/O in the hot path,
// or O(n²) data-structure work introduced by future refactors.
//
// Production budget (real LLMs, real GitHub, real Slack) is C3's nightly
// E2E smoke at < 45s — separate concern, real-infra dependency.
//
// Synthetic budget: 200ms for a state-query branch (pure, no LLM call),
// 500ms for an LLM-orchestrated branch (LLM mock returns immediately).
// These are intentionally tight — they're a CI gate against regressions,
// not a performance characterization. If a legitimate code change pushes
// past these, raise the budget deliberately with a documented reason.

import { describe, it, expect } from "vitest"
import { runArchitectAgentV2, type RunArchV2Deps } from "../../runtime/agents/runArchitectAgentV2"
import { runDesignAgentV2, type RunDesignV2Deps } from "../../runtime/agents/runDesignAgentV2"
import { runPmAgentV2, type RunPmV2Deps } from "../../runtime/agents/runPmAgentV2"
import type { ReadinessReportInput } from "../../runtime/readiness-builder"

// ── Synthetic budgets (milliseconds) ──────────────────────────────────────────

// State-query / off-topic / approval-confirm branches: pure rendering, no
// LLM call. Should complete in <50ms in practice; budget is 200ms with
// margin for slow CI runners.
const PURE_BRANCH_BUDGET_MS = 200

// LLM-orchestrated branches with mocked LLM (returns immediately):
// adds one async tick per LLM call. Budget is 500ms.
const LLM_BRANCH_BUDGET_MS = 500

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeArchitectDeps(reportInput: ReadinessReportInput): RunArchV2Deps {
  return {
    loadReport:           async () => reportInput,
    applyStateMutation:   async () => {},
    emit:                 async () => {},
    mainChannelName:      "test-main",
    githubOwner:          "o",
    githubRepo:           "r",
    fetchCurrentDraft:    async () => null,
    runLLMForEscalation:  async () => "esc-response",
    runLLMForNormalTurn:  async () => "normal-response",
    log:                  () => {},
  }
}

function makeDesignDeps(reportInput: ReadinessReportInput): RunDesignV2Deps {
  return {
    loadReport:           async () => reportInput,
    applyStateMutation:   async () => {},
    emit:                 async () => {},
    mainChannelName:      "test-main",
    fetchCurrentDraft:    async () => null,
    runLLMForEscalation:  async () => "esc-response",
    runLLMForNormalTurn:  async () => "normal-response",
    log:                  () => {},
  }
}

function makePmDeps(reportInput: ReadinessReportInput): RunPmV2Deps {
  return {
    loadReport:           async () => reportInput,
    applyStateMutation:   async () => {},
    emit:                 async () => {},
    mainChannelName:      "test-main",
    fetchCurrentDraft:    async () => null,
    runLLMForEscalation:  async () => "esc-response",
    runLLMForNormalTurn:  async () => "normal-response",
    log:                  () => {},
  }
}

function archReportInput(): ReadinessReportInput {
  return {
    callingAgent:     "architect",
    featureName:      "perf-feature",
    ownSpec:          { specType: "engineering", status: "ready", findingCount: 0 },
    upstreamAudits:   [
      { auditingAgent: "architect", specType: "product", findingCount: 0 },
      { auditingAgent: "architect", specType: "design",  findingCount: 0 },
    ],
    activeEscalation: null,
  }
}

function designReportInput(): ReadinessReportInput {
  return {
    callingAgent:     "ux-design",
    featureName:      "perf-feature",
    ownSpec:          { specType: "design", status: "ready", findingCount: 0 },
    upstreamAudits:   [
      { auditingAgent: "ux-design", specType: "product", findingCount: 0 },
    ],
    activeEscalation: null,
  }
}

function pmReportInput(): ReadinessReportInput {
  return {
    callingAgent:     "pm",
    featureName:      "perf-feature",
    ownSpec:          { specType: "product", status: "ready", findingCount: 0 },
    upstreamAudits:   [],
    activeEscalation: null,
  }
}

async function timeMs(fn: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await fn()
  return performance.now() - start
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("D3 — V2 architect runner synthetic performance budget", () => {
  it(`state-query-fast-path branch completes in < ${PURE_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runArchitectAgentV2({
        userMessage: "where are we",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: true, isStateQuery: true, isOffTopic: false },
        state:       { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
        deps:        makeArchitectDeps(archReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(PURE_BRANCH_BUDGET_MS)
  })

  it(`off-topic-redirect branch completes in < ${PURE_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runArchitectAgentV2({
        userMessage: "tell me a joke",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: true },
        state:       { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
        deps:        makeArchitectDeps(archReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(PURE_BRANCH_BUDGET_MS)
  })

  it(`normal-agent-turn branch (mocked LLM) completes in < ${LLM_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runArchitectAgentV2({
        userMessage: "let's plan engineering",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
        state:       { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
        deps:        makeArchitectDeps(archReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(LLM_BRANCH_BUDGET_MS)
  })
})

describe("D3 — V2 designer runner synthetic performance budget", () => {
  it(`state-query-fast-path branch completes in < ${PURE_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runDesignAgentV2({
        userMessage: "where are we",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: true, isStateQuery: true, isOffTopic: false },
        state:       { hasPendingApproval: false, readOnly: false },
        deps:        makeDesignDeps(designReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(PURE_BRANCH_BUDGET_MS)
  })

  it(`normal-agent-turn branch (mocked LLM) completes in < ${LLM_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runDesignAgentV2({
        userMessage: "let's design",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
        state:       { hasPendingApproval: false, readOnly: false },
        deps:        makeDesignDeps(designReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(LLM_BRANCH_BUDGET_MS)
  })
})

describe("D3 — V2 PM runner synthetic performance budget", () => {
  it(`state-query-fast-path branch completes in < ${PURE_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runPmAgentV2({
        userMessage: "where are we",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: true, isStateQuery: true, isOffTopic: false },
        state:       { hasPendingApproval: false, readOnly: false },
        deps:        makePmDeps(pmReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(PURE_BRANCH_BUDGET_MS)
  })

  it(`normal-agent-turn branch (mocked LLM) completes in < ${LLM_BRANCH_BUDGET_MS}ms`, async () => {
    const elapsed = await timeMs(async () => {
      await runPmAgentV2({
        userMessage: "let's spec",
        featureName: "perf-feature",
        intent:      { isAffirmative: false, isCheckIn: false, isStateQuery: false, isOffTopic: false },
        state:       { hasPendingApproval: false, readOnly: false },
        deps:        makePmDeps(pmReportInput()),
      })
    })
    expect(elapsed).toBeLessThan(LLM_BRANCH_BUDGET_MS)
  })
})

// ── Determinism: variance check (safety net for flaky budgets) ───────────────
// Run each pure branch 10 times, assert the slowest run is still under
// budget. Catches "test passes when CI is fast, fails on busy runners."
// Production budget regression detection lives here, not in C3 (which
// runs against real infra and varies more).

describe("D3 — performance budget variance (10x runs of pure branch)", () => {
  it(`architect state-query worst-of-10 < ${PURE_BRANCH_BUDGET_MS}ms`, async () => {
    let max = 0
    for (let i = 0; i < 10; i++) {
      const ms = await timeMs(async () => {
        await runArchitectAgentV2({
          userMessage: "hi",
          featureName: "perf-feature",
          intent:      { isAffirmative: false, isCheckIn: true, isStateQuery: false, isOffTopic: false },
          state:       { hasPendingApproval: false, hasPendingDecisionReview: false, readOnly: false },
          deps:        makeArchitectDeps(archReportInput()),
        })
      })
      if (ms > max) max = ms
    }
    expect(max).toBeLessThan(PURE_BRANCH_BUDGET_MS)
  })
})
