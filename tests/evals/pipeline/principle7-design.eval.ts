import { describe, it, expect, vi, beforeEach } from "vitest"
import Anthropic from "@anthropic-ai/sdk"

// Pipeline eval: Principle 7 — design agent proactive gap surfacing.
//
// Tests that the design agent surfaces blocking gaps WITHOUT a trigger phrase.
// The user says "what is the next step for this feature" — a completely
// phrasing-neutral question. The platform must:
//   1. Run auditPhaseCompletion regardless (always-on, Principle 7)
//   2. Agent must surface PM spec gaps and escalate — not answer generically
//   3. Agent must name specific design gaps it will fix
//
// Mocked: @octokit/rest (deterministic GitHub state — PM spec with 2 blocking
//   questions, no design draft yet so auditPhaseCompletion skips design rubric)
// Real:   @anthropic-ai/sdk (live API — real reasoning, real tool calls)
// Judge:  Haiku (evaluates pass/fail criteria on the final response)
//
// Run: npm run eval:pipeline
// Not in main test suite (excluded by .eval.ts extension + separate config).

// ─── GitHub mock — must be hoisted before any static import of @octokit/rest ─

const mockGetContent  = vi.hoisted(() => vi.fn())
const mockGetRef      = vi.hoisted(() => vi.fn())
const mockCreateRef   = vi.hoisted(() => vi.fn())
const mockCreateOrUpdate = vi.hoisted(() => vi.fn())
const mockPaginate    = vi.hoisted(() => vi.fn())

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdate,
        listBranches: vi.fn(),
      },
      git: { getRef: mockGetRef, createRef: mockCreateRef },
      paginate: mockPaginate,
    }
  }),
}))

// @anthropic-ai/sdk is NOT mocked — real API calls.

import { handleFeatureChannelMessage } from "../../../interfaces/slack/handlers/message"
import { clearHistory, setConfirmedAgent } from "../../../runtime/conversation-store"
import { clearSummaryCache } from "../../../runtime/conversation-summarizer"

// ─── GitHub state — PM spec with 2 blocking questions, no design draft ────────

const PM_SPEC = `
# Onboarding — Product Spec

## Problem
New users arrive with no context. First-session drop-off is high.

## Target Users
Engineering managers at 5–20 person teams evaluating the product.

## User Stories
- US-1: As a new user, I can sign up in under 2 minutes
- US-2: As a returning user, I can sign in via SSO

## Acceptance Criteria
- Sign-up: email + password
- SSO: Google and GitHub supported
- AC-11: Conversation history preserved across sessions

## Open Questions
- [type: product] [blocking: yes] What is the exact error UX when SSO token is revoked mid-session?
- [type: product] [blocking: yes] How is anonymous session data linked to the authenticated user account after sign-in?

## Non-Goals
- Mobile optimization (post-v1)
`.trim()

// ─── Haiku judge (independent Anthropic instance) ─────────────────────────────

const judge = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function passes(response: string, criterion: string): Promise<boolean> {
  const result = await judge.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system: "You are a strict evaluator. Given an AI agent response and a criterion, answer only YES or NO.",
    messages: [{ role: "user", content: `Response:\n${response}\n\nCriterion: ${criterion}\n\nPasses?` }],
  })
  const text = result.content[0].type === "text" ? result.content[0].text.trim().toUpperCase() : "NO"
  return text.startsWith("YES")
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

const FEATURE = "onboarding"

function makeSlackClient() {
  const updates: string[] = []
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "eval-ts" }),
        update: vi.fn().mockImplementation(async (p: any) => {
          updates.push(p.text ?? "")
          return {}
        }),
      },
      files: { uploadV2: vi.fn().mockRejectedValue(new Error("no scope")) },
    },
    getLastResponse: () => updates.at(-1) ?? "",
  }
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

describe("Principle 7 — design agent surfaces gaps proactively on neutral phrases", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHistory(FEATURE)
    clearSummaryCache(FEATURE)

    mockPaginate.mockResolvedValue([])
    mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
    mockCreateRef.mockResolvedValue({})
    mockCreateOrUpdate.mockResolvedValue({})

    // GitHub state: PM spec on main, no design draft on design branch
    mockGetContent.mockImplementation(({ path }: { path?: string }) => {
      if (path?.endsWith("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(PM_SPEC).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    setConfirmedAgent(FEATURE, "ux-design")
  })

  it("surfaces PM blocking questions without being asked — does not answer generically", async () => {
    const { client, getLastResponse } = makeSlackClient()

    await handleFeatureChannelMessage({
      channelName:  "feature-onboarding",
      threadTs:     "eval-thread-1",
      channelId:    "CEVAL",
      client:       client as any,
      channelState: { productSpecApproved: false, engineeringSpecApproved: false, pendingAgent: null, pendingMessage: null, pendingThreadTs: null },
      userMessage:  "what is the next step for this feature",
    })

    const response = getLastResponse()
    expect(response.length).toBeGreaterThan(0)

    const [notGeneric, mentionsBlockingGap, escalatesOrFlags] = await Promise.all([
      passes(response, "The response does NOT generically say 'the next step is to start design' without flagging any gaps or open questions"),
      passes(response, "The response mentions at least one unresolved or blocking question from the PM spec (SSO failure, anonymous session linking, or conversation history)"),
      passes(response, "The response either calls offer_pm_escalation, asks the PM to resolve a question, or explicitly states design cannot proceed until PM gaps are resolved"),
    ])

    expect(notGeneric,        "should not answer generically without flagging gaps").toBe(true)
    expect(mentionsBlockingGap, "should surface at least one PM blocking question").toBe(true)
    expect(escalatesOrFlags,  "should escalate or block on PM gaps").toBe(true)
  })

  it("does not claim 'no open questions' when blocking questions exist in PM spec", async () => {
    const { client, getLastResponse } = makeSlackClient()

    await handleFeatureChannelMessage({
      channelName:  "feature-onboarding",
      threadTs:     "eval-thread-2",
      channelId:    "CEVAL",
      client:       client as any,
      channelState: { productSpecApproved: false, engineeringSpecApproved: false, pendingAgent: null, pendingMessage: null, pendingThreadTs: null },
      userMessage:  "are we ready to start designing?",
    })

    const response = getLastResponse()
    expect(response.length).toBeGreaterThan(0)

    const [doesNotClaimReady, namesBroadProblem] = await Promise.all([
      passes(response, "The response does NOT say the spec is ready to design, all questions are resolved, or design can start immediately"),
      passes(response, "The response identifies a specific gap, blocker, or unresolved question that must be addressed before design can proceed"),
    ])

    expect(doesNotClaimReady, "should not claim readiness when blocking questions exist").toBe(true)
    expect(namesBroadProblem, "should name a specific blocker").toBe(true)
  })
})
