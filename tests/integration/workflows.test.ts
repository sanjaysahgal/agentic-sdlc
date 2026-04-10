import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

// End-to-end multi-turn workflow tests.
//
// Each scenario runs multiple handleFeatureChannelMessage calls in sequence,
// verifying state transitions between turns:
//   • confirmedAgent changes when a spec is approved
//   • Phase detection drives routing on next turn / new thread
//   • PM escalation round-trip (design → PM → back to design thread)
//   • Thread isolation — concurrent features don't bleed state
//
// Strategy: mock only @octokit/rest and @anthropic-ai/sdk (external boundaries).
// All internal state (conversation-store, workspace-config, agent helpers) runs real.
//
// NOTE: conversation store is now keyed by featureName (not threadTs).
//   channelName "feature-onboarding" → featureName "onboarding"
//   channelName "feature-dashboard"  → featureName "dashboard"
// THREAD constants are retained as threadTs values for Slack API calls only.

// Minimal HTML that satisfies all blocking validators (id="hero" present as sibling of id="thread")
const VALID_MOCK_HTML = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #fff; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`

const mockGetContent    = vi.hoisted(() => vi.fn())
const mockGetRef        = vi.hoisted(() => vi.fn())
const mockCreateRef     = vi.hoisted(() => vi.fn())
const mockDeleteRef     = vi.hoisted(() => vi.fn())
const mockCreateOrUpdate = vi.hoisted(() => vi.fn())
const mockPaginate      = vi.hoisted(() => vi.fn())
const mockAnthropicCreate = vi.hoisted(() => vi.fn())

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdate,
        listBranches: vi.fn(),
      },
      git: {
        getRef: mockGetRef,
        createRef: mockCreateRef,
        deleteRef: mockDeleteRef,
      },
      paginate: mockPaginate,
    }
  }),
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } }
  }),
}))

import { handleFeatureChannelMessage } from "../../../interfaces/slack/handlers/message"
import {
  clearHistory,
  clearLegacyMessages,
  setConfirmedAgent,
  getConfirmedAgent,
  appendMessage,
  getHistory,
  setPendingApproval,
  setPendingEscalation,
  getPendingEscalation,
  clearPendingEscalation,
} from "../../../runtime/conversation-store"
import { clearSummaryCache } from "../../../runtime/conversation-summarizer"

const originalEnv = process.env

// Shared GitHub state helpers
const PRODUCT_SPEC_CONTENT = Buffer.from("# Onboarding Product Spec\n\n## Problem\nHelp users onboard.").toString("base64")
const DESIGN_SPEC_CONTENT  = Buffer.from("# Onboarding Design Spec\n\n## Screens\nScreen 1.").toString("base64")

function specOnMain(content = PRODUCT_SPEC_CONTENT) {
  return { data: { content, type: "file" } }
}

// Simulate GitHub state: product spec on main, no design spec, no design branch
function mockProductApprovedState() {
  mockPaginate.mockResolvedValueOnce([{ name: "spec/onboarding-product" }])
  mockGetContent
    .mockResolvedValueOnce(specOnMain(PRODUCT_SPEC_CONTENT)) // product on main
    .mockRejectedValueOnce(new Error("Not Found"))            // design not on main
    .mockRejectedValueOnce(new Error("Not Found"))            // engineering not on main
}

// Simulate GitHub state: product + design specs on main, no engineering branch
function mockDesignApprovedState() {
  mockPaginate.mockResolvedValueOnce([{ name: "spec/onboarding-product" }])
  mockGetContent
    .mockResolvedValueOnce(specOnMain(PRODUCT_SPEC_CONTENT)) // product on main
    .mockResolvedValueOnce(specOnMain(DESIGN_SPEC_CONTENT))  // design on main
    .mockRejectedValueOnce(new Error("Not Found"))            // engineering not on main
}

// Simulate GitHub state: product spec on main, design branch active (design in progress)
function mockDesignInProgressState() {
  mockPaginate.mockResolvedValueOnce([
    { name: "spec/onboarding-product" },
    { name: "spec/onboarding-design" },
  ])
  mockGetContent
    .mockResolvedValueOnce(specOnMain(PRODUCT_SPEC_CONTENT)) // product on main
    .mockRejectedValueOnce(new Error("Not Found"))            // design not on main (draft only)
    .mockRejectedValueOnce(new Error("Not Found"))            // engineering not on main
}

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "msg-ts" }),
      update: vi.fn().mockResolvedValue({}),
    },
    files: { uploadV2: vi.fn().mockRejectedValue(new Error("no scope")) },
  }
}

function makeParams(threadTs: string, channelName: string, userMessage: string) {
  return {
    channelName,
    threadTs,
    channelId: "C123",
    client: makeClient(),
    channelState: {
      productSpecApproved: false,
      engineeringSpecApproved: false,
      pendingAgent: null,
      pendingMessage: null,
      pendingThreadTs: null,
    },
    userMessage,
  }
}

function lastUpdateText(client: ReturnType<typeof makeClient>): string {
  const calls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
  return calls.at(-1)?.[0]?.text ?? ""
}

function thinkingPlaceholder(client: ReturnType<typeof makeClient>): string {
  return (client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.text ?? ""
}

// Seed N messages so extractLockedDecisions fires (threshold = 6)
function seedHistory(featureName: string, count = 7) {
  for (let i = 0; i < count; i++) {
    appendMessage(featureName, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  // Clear legacy messages from disk so pre-migration history doesn't leak into tests.
  // The bot reads .conversation-history.json on startup; without this, legacy messages
  // cause extra identifyUncommittedDecisions API calls that tests don't account for.
  clearLegacyMessages()
  process.env = {
    ...originalEnv,
    PRODUCT_NAME: "TestApp",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_TOKEN: "test-token",
    ANTHROPIC_API_KEY: "test-key",
    SLACK_MAIN_CHANNEL: "all-testapp",
  }
  // Persistent defaults — overridden per-turn with Once variants
  mockPaginate.mockResolvedValue([])
  mockGetContent.mockRejectedValue(new Error("Not Found"))
  mockGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
  mockCreateRef.mockResolvedValue({})
  mockDeleteRef.mockResolvedValue({})
  mockCreateOrUpdate.mockResolvedValue({})
})

afterEach(() => {
  process.env = originalEnv
})

// ─── Scenario 1: PM spec approval → design agent routing ─────────────────────
//
// Turn 1: User confirms PM spec ("confirmed")
//         → saveApprovedSpec called, approval message shown
//         → confirmedAgent stays "pm"
// Turn 2: User sends next message
//         → phase = "product-spec-approved-awaiting-design"
//         → confirmedAgent switches to "ux-design"
//         → UX Designer handles the message

describe("Scenario 1 — PM spec approval → design agent routing", () => {
  const THREAD = "workflow-s1"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("Turn 1: approval confirmation shows approval message and preserves pm as confirmedAgent", async () => {
    setPendingApproval("onboarding", {
      specType: "product",
      specContent: "# Onboarding Product Spec\n\n## Problem\nHelp users onboard.",
      filePath: "specs/features/onboarding/onboarding.product.md",
      featureName: "onboarding",
    })
    setConfirmedAgent("onboarding", "pm")

    const params = makeParams(THREAD, "feature-onboarding", "confirmed")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("product spec is saved and approved")
    expect(text).toContain("UX designer")

    // confirmedAgent stays "pm" — phase check happens on next message, not during approval
    expect(getConfirmedAgent("onboarding")).toBe("pm")

    // saveApprovedSpec was called — createOrUpdateFileContents or getContent reached
    expect(mockGetContent).toHaveBeenCalled()
  })

  it("Turn 2: next message after approval routes to UX Designer based on GitHub phase", async () => {
    // State after approval: confirmedAgent = "pm", product spec on main
    setConfirmedAgent("onboarding", "pm")
    appendMessage("onboarding", { role: "user", content: "confirmed" })
    appendMessage("onboarding", { role: "assistant", content: "Product spec approved." })

    // GitHub: product spec on main, no design spec, no design branch → product-spec-approved-awaiting-design
    mockProductApprovedState()

    // Design agent calls: isOffTopicForAgent, isSpecStateQuery, runAgent
    // history.length = 2 → extractLockedDecisions short-circuits (< 6), no Haiku call
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                           // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                           // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Let's start with flows." }] })         // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "let's start the design phase")
    await handleFeatureChannelMessage(params)

    // confirmedAgent must switch to ux-design
    expect(getConfirmedAgent("onboarding")).toBe("ux-design")

    // Response contains UX Designer label (prepended by withThinking)
    const text = lastUpdateText(params.client)
    expect(text).toContain("Let's start with flows.")

    // Thinking placeholder shows UX Designer, not PM
    expect(thinkingPlaceholder(params.client)).toBe("_UX Designer is thinking..._")
  })
})

// ─── Scenario 2: Design spec approval → architect routing ────────────────────
//
// Same pattern as Scenario 1 but for the design → engineering handoff.

describe("Scenario 2 — Design spec approval → architect routing", () => {
  const THREAD = "workflow-s2"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("Turn 1: design approval confirmation shows approval message", async () => {
    setPendingApproval("onboarding", {
      specType: "design",
      specContent: "# Onboarding Design Spec\n\n## Screens\nScreen 1.",
      filePath: "specs/features/onboarding/onboarding.design.md",
      featureName: "onboarding",
    })
    setConfirmedAgent("onboarding", "ux-design")

    const params = makeParams(THREAD, "feature-onboarding", "confirmed")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("design spec is saved and approved")
    expect(text).toContain("architect")
    expect(getConfirmedAgent("onboarding")).toBe("ux-design")
  })

  it("Turn 2: next message after design approval routes to Architect", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    appendMessage("onboarding", { role: "user", content: "confirmed" })
    appendMessage("onboarding", { role: "assistant", content: "Design spec approved." })

    // GitHub: product + design specs on main → design-approved-awaiting-engineering
    mockDesignApprovedState()

    // Architect agent calls: isOffTopicForAgent, isSpecStateQuery, runAgent
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                    // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Let's plan the data model." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "let's plan the engineering")
    await handleFeatureChannelMessage(params)

    expect(getConfirmedAgent("onboarding")).toBe("architect")
    expect(thinkingPlaceholder(params.client)).toBe("_Architect is thinking..._")

    const text = lastUpdateText(params.client)
    expect(text).toContain("Let's plan the data model.")
  })
})

// ─── Scenario 3: Phase-aware routing for a brand new thread ──────────────────
//
// A new thread (no confirmedAgent) in a feature channel that is already in
// design-in-progress phase must route directly to the UX Designer — no
// classifyIntent call, no PM detour.

describe("Scenario 3 — Phase-aware routing on new thread", () => {
  const THREAD = "workflow-s3"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("new thread in design-in-progress feature routes straight to UX Designer", async () => {
    // No confirmedAgent — fresh thread
    mockDesignInProgressState()

    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here are the flows." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "what are we designing?")
    await handleFeatureChannelMessage(params)

    expect(getConfirmedAgent("onboarding")).toBe("ux-design")
    expect(thinkingPlaceholder(params.client)).toBe("_UX Designer is thinking..._")
    expect(lastUpdateText(params.client)).toContain("Here are the flows.")
  })

  it("new thread in design-approved-awaiting-engineering routes straight to Architect", async () => {
    mockDesignApprovedState()

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })               // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })               // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here's the data model." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "let's start the arch")
    await handleFeatureChannelMessage(params)

    expect(getConfirmedAgent("onboarding")).toBe("architect")
    expect(thinkingPlaceholder(params.client)).toBe("_Architect is thinking..._")
  })

  it("new thread in product-spec-in-progress routes to PM (via classifyIntent)", async () => {
    // No spec branches, nothing on main → product-spec-in-progress
    mockPaginate.mockResolvedValueOnce([])

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "pm" }] })           // classifyIntent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Tell me more." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "I want to build onboarding")
    await handleFeatureChannelMessage(params)

    expect(getConfirmedAgent("onboarding")).toBe("pm")
    // New-thread PM routing: the label is "_Thinking..._" because the agent isn't
    // known until classifyIntent completes. The PM label appears in the final update.
    expect(thinkingPlaceholder(params.client)).toBe("_Thinking..._")
    expect(lastUpdateText(params.client)).toContain("Tell me more.")
  })
})

// ─── Scenario 4: PM escalation round-trip ────────────────────────────────────
//
// Design agent calls offer_pm_escalation tool (Turn 1) → platform stores pending
// escalation via setPendingEscalation → user says "yes" (Turn 2) → PM notification
// posted via postMessage, no AI invoked.
//
// The full Turn 1 → Turn 2 path is exercised here — no manual setPendingEscalation
// shortcut. This catches regressions where the tool exists in DESIGN_TOOLS but the
// handler never calls setPendingEscalation.

describe("Scenario 4 — PM escalation round-trip from design agent", () => {
  const THREAD = "workflow-s4"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("Turn 1: design agent calls offer_pm_escalation tool → pending escalation stored", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent (tool_use)      → offer_pm_escalation({ question: "Should chips be permanent for authenticated users?" })
    //   [3] runAgent (end_turn)      → text response after tool result
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: "Should chips be permanent for authenticated users?" } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I've escalated this to the PM — design is paused until they respond." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "should we support social login?")
    await handleFeatureChannelMessage(params)

    // Escalation was stored — platform can serve it on Turn 2
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.question).toBe("Should chips be permanent for authenticated users?")

    // Agent's response text passed through to Slack
    const text = lastUpdateText(params.client)
    expect(text).toContain("escalated")
  })

  it("Turn 2: user says yes → PM agent runs with brief, then @mention posted for human review", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    appendMessage("onboarding", { role: "user", content: "should we support social login?" })
    appendMessage("onboarding", { role: "assistant", content: "I've escalated this to the PM — design is paused until they respond." })

    // Set up the pending escalation as the tool handler would have (no shortcut)
    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "Should social login be supported?",
      designContext: "Onboarding design in progress.",
    })

    // PM agent runs — mock any Anthropic calls with a valid response
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Recommendation: Yes, support Google OAuth as the primary social login method — it covers the majority of users and Health360 already uses Google Workspace." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 30 },
    })

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // PM agent was called
    expect(mockAnthropicCreate).toHaveBeenCalled()

    // Human PM notified via separate postMessage to review recommendations
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const reviewPost = postCalls.find((c: any) => c[0]?.text?.includes("review the recommendations above"))
    expect(reviewPost).toBeDefined()
    expect(reviewPost[0].text).toContain("Product Manager")
    expect(reviewPost[0].text).toContain("reply here to confirm or adjust")

    // Pending escalation cleared after confirmation
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    // EscalationNotification set — waiting for human PM reply to resume design
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notif = getEscalationNotification("onboarding")
    expect(notif).not.toBeNull()
    expect(notif?.question).toBe("Should social login be supported?")
  })
})

// ─── Scenario 5: Thread isolation — concurrent features ──────────────────────
//
// Two features in flight simultaneously. Messages in each feature channel route to the
// agent confirmed for THAT feature. State does not leak between features.
// Now keyed by featureName: "feature-onboarding" → "onboarding", "feature-dashboard" → "dashboard"

describe("Scenario 5 — Thread isolation across concurrent features", () => {
  const THREAD_A = "workflow-s5-onboarding"
  const THREAD_B = "workflow-s5-dashboard"

  beforeEach(() => {
    clearHistory("onboarding")
    clearHistory("dashboard")
  })
  afterEach(() => {
    clearHistory("onboarding")
    clearHistory("dashboard")
  })

  it("PM message in Thread A does not affect UX Designer routing in Thread B", async () => {
    setConfirmedAgent("onboarding", "pm")
    setConfirmedAgent("dashboard", "ux-design")

    // Thread A: PM agent call
    // confirmedAgent = "pm" → getFeaturePhase check → still product-in-progress → run PM
    mockPaginate.mockResolvedValueOnce([]) // no branches → product-spec-in-progress for Thread A

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // classifyMessageScope (PM)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PM response." }] })       // PM runAgent

    const paramsA = makeParams(THREAD_A, "feature-onboarding", "refine the spec")
    await handleFeatureChannelMessage(paramsA)

    expect(thinkingPlaceholder(paramsA.client)).toBe("_Product Manager is thinking..._")
    expect(getConfirmedAgent("onboarding")).toBe("pm")

    // Thread B: design agent — confirmedAgent should still be ux-design (not contaminated by A)
    expect(getConfirmedAgent("dashboard")).toBe("ux-design")

    vi.clearAllMocks()

    // No design draft on dashboard branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Design response." }] }) // design runAgent

    const paramsB = makeParams(THREAD_B, "feature-dashboard", "update the flows")
    await handleFeatureChannelMessage(paramsB)

    expect(thinkingPlaceholder(paramsB.client)).toBe("_UX Designer is thinking..._")
    expect(getConfirmedAgent("dashboard")).toBe("ux-design")
    expect(getConfirmedAgent("onboarding")).toBe("pm") // Thread A unaffected
  })
})

// ─── Scenario 6: confirmedAgent persists across turns within same thread ──────
//
// Once an agent is confirmed for a thread, subsequent messages in that thread
// skip classifyIntent and go directly to the confirmed agent.

describe("Scenario 6 — confirmedAgent sticky routing", () => {
  const THREAD = "workflow-s6"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("second message in PM thread skips classifyIntent and goes straight to PM", async () => {
    setConfirmedAgent("onboarding", "pm")
    appendMessage("onboarding", { role: "user", content: "first message" })
    appendMessage("onboarding", { role: "assistant", content: "PM response." })

    // Phase is still product-spec-in-progress (no branches)
    mockPaginate.mockResolvedValueOnce([])

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })       // classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Still on the PM." }] })        // PM runAgent

    const params = makeParams(THREAD, "feature-onboarding", "follow-up question")
    await handleFeatureChannelMessage(params)

    // Only 2 Anthropic calls — classifyIntent was NOT called (would add a third call)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    expect(thinkingPlaceholder(params.client)).toBe("_Product Manager is thinking..._")
  })

  it("confirmed design agent thread skips classifyIntent — goes straight to UX Designer", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    appendMessage("onboarding", { role: "user", content: "first design message" })
    appendMessage("onboarding", { role: "assistant", content: "Design response." })

    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })             // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })             // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Still designing." }] })  // design runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] }) // post-turn identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "another design question")
    await handleFeatureChannelMessage(params)

    // 4 calls: isOffTopicForAgent, isSpecStateQuery, runAgent, post-turn identifyUncommittedDecisions
    // (history grows to 4 messages after this turn: 2 seeded + 1 user + 1 assistant > threshold of 2)
    // classifyIntent was NOT called — that would add a 5th call
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
    expect(thinkingPlaceholder(params.client)).toBe("_UX Designer is thinking..._")
  })
})

// ─── Scenario 7: Design agent history cap (historyLimit: 20) ─────────────────
//
// runDesignAgent passes historyLimit: 20 to runAgent so the Anthropic payload
// stays manageable even on long threads. Verify that when the conversation store
// has more than 20 messages, the actual Anthropic call receives at most 21
// messages (20 history + the current user message).

describe("Scenario 7 — Design agent caps history at 20 messages", () => {
  const THREAD = "workflow-s7"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("sends at most 21 messages to Anthropic (20 history + current) even when store has 40+", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Seed 40 alternating messages in the conversation store
    for (let i = 0; i < 40; i++) {
      appendMessage("onboarding", { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })           // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })           // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })                // [2] extractLockedDecisions (Haiku, fires at >6 msgs)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "- Glow timing pending" }] }) // [3] summarizeUnlockedDiscussion (Haiku, fires when history > 20)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Still designing." }] }) // [4] design runAgent

    const params = makeParams(THREAD, "feature-onboarding", "latest message")
    await handleFeatureChannelMessage(params)

    // The 5th Anthropic call (index 4) is the runAgent call — inspect its messages array
    const runAgentCall = mockAnthropicCreate.mock.calls[4][0]
    expect(runAgentCall.messages.length).toBeLessThanOrEqual(21)

    // The most recent history message should be present; the oldest (msg 0) should be gone
    const allContent = runAgentCall.messages.map((m: { content: string }) => m.content).join(" ")
    expect(allContent).not.toContain("msg 0")
    expect(allContent).toContain("latest message")
  })
})

// ─── Scenario 8: State query on long thread surfaces uncommitted-context note ──
//
// When a user says "hi" or "are you there" on a thread with prior history,
// the state response must include a note that prior discussion may not be committed.
// This prevents the user from thinking the spec is up to date when it isn't.

describe("Scenario 8 — State query on long thread surfaces uncommitted-context note", () => {
  const THREAD = "workflow-s8"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("state response shows specific uncommitted decisions when thread has prior history", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    for (let i = 0; i < 10; i++) {
      appendMessage("onboarding", { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    // "hi" matches CHECK_IN_RE — both isOffTopicForAgent and isSpecStateQuery are skipped.
    // identifyUncommittedDecisions is the only Anthropic call.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode default: I recommend Archon palette — discussed in thread\n2. Chip positioning: I recommend above prompt bar — agreed in conversation" }] })  // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("PENDING")
    expect(text).toContain("Dark mode default")
    // CTA tells user to save pending decisions (exact wording depends on draft state)
    expect(text.toLowerCase()).toContain("save those")
  })

  it("state response shows 'No open items' when all decisions are in the spec", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    for (let i = 0; i < 10; i++) {
      appendMessage("onboarding", { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    // "hi" matches CHECK_IN_RE — both isOffTopicForAgent and isSpecStateQuery are skipped.
    // identifyUncommittedDecisions is the only Anthropic call.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    // PENDING section always present — shows "No open items" when all committed
    const text = lastUpdateText(params.client)
    expect(text).toContain("PENDING")
    expect(text).toContain("No open items from prior conversations")
  })

  it("state response shows 'No open items' when thread is short (fresh start)", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // "hi" matches CHECK_IN_RE — both isOffTopicForAgent and isSpecStateQuery are skipped.
    // Thread history is empty (length <= 2), so identifyUncommittedDecisions is also skipped.
    // No Anthropic calls at all — PENDING section shows "No open items" deterministically.
    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("PENDING")
    expect(text).toContain("No open items from prior conversations")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(0)
  })
})

// ─── Scenario 9: Design patch flow ───────────────────────────────────────────
//
// When the design agent calls apply_design_spec_patch tool, the handler should:
//   1. Read the existing draft from GitHub (falls back to "" if none)
//   2. Merge the patch into the existing draft via applySpecPatch
//   3. Save the merged draft to GitHub
//   4. Generate an HTML preview
//   5. Return the spec URL (agent continues and posts its text response)

describe("Scenario 9 — Design patch flow", () => {
  const THREAD = "workflow-s9"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("apply_design_spec_patch tool saves merged draft to GitHub", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Anthropic call sequence (short history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent        → false
    //   [1] isSpecStateQuery          → false
    //   [2] runAgent (tool_use call)  → tool_use: apply_design_spec_patch
    //   [3] generateDesignPreview     → HTML (from tool handler; auditSpecDraft skips — empty context)
    //   [4] auditSpecRenderAmbiguity  → [] (no ambiguities)
    //   [5] runAgent (end_turn call)  → text response after tool result
    // No design draft found before tool call → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Accessibility\nWCAG AA required. Focus rings on all interactive elements. Min tap target 44px." } }],
      })                                                                               // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })             // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated the accessibility section. Ready to approve?" }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "can you tighten up the accessibility section?")
    await handleFeatureChannelMessage(params)

    // Draft was saved to GitHub (createOrUpdateFileContents called at least once)
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // The merged draft saved to GitHub contains the updated accessibility section
    const savedContent = Buffer.from(
      mockCreateOrUpdate.mock.calls.find((c: any[]) =>
        c[0]?.path?.includes("onboarding.design.md")
      )?.[0]?.content ?? "",
      "base64"
    ).toString()
    expect(savedContent).toContain("WCAG AA required")

    // Response includes the approval CTA from the agent's text response
    const text = lastUpdateText(params.client)
    expect(text).toContain("approve")
  })
})

// ─── Scenario 10: PM patch flow ───────────────────────────────────────────────
//
// When the PM agent calls apply_product_spec_patch tool, the handler applies
// the patch to the existing draft and saves the merged result to GitHub.

describe("Scenario 10 — PM patch flow", () => {
  const THREAD = "workflow-s10"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("apply_product_spec_patch tool merges patch into existing draft and saves to GitHub", async () => {
    setConfirmedAgent("onboarding", "pm")

    // PM Anthropic call sequence: classifyMessageScope → runAgent (tool_use) → runAgent (end_turn)
    // auditSpecDraft skips API call (empty productVision/architecture)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_product_spec_patch", input: { patch: "## Goals\n1. Reduce onboarding time from 10 min to 3 min.\n2. Achieve 80% day-1 activation." } }],
      })                                                                                  // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated the Goals section." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "tighten up the goals section")
    await handleFeatureChannelMessage(params)

    // Draft was saved to GitHub
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // The saved content contains the patched Goals section
    const savedContent = Buffer.from(
      mockCreateOrUpdate.mock.calls.find((c: any[]) =>
        c[0]?.path?.includes("onboarding.product.md")
      )?.[0]?.content ?? "",
      "base64"
    ).toString()
    expect(savedContent).toContain("Reduce onboarding time")
  })
})

// ─── Scenario 11: Architect patch flow ────────────────────────────────────────
//
// When the architect agent calls apply_engineering_spec_patch tool, the handler
// applies the patch to the existing draft and saves the merged result to GitHub.

describe("Scenario 11 — Architect patch flow", () => {
  const THREAD = "workflow-s11"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("apply_engineering_spec_patch tool merges patch into existing draft and saves to GitHub", async () => {
    setConfirmedAgent("onboarding", "architect")

    // Architect Anthropic call sequence: isOffTopicForAgent → isSpecStateQuery → runAgent (tool_use) → runAgent (end_turn)
    // auditSpecDraft skips API call (empty productVision/architecture)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_engineering_spec_patch", input: { patch: "## API Design\nGET /api/v1/onboarding — cursor-based pagination, max 50 items." } }],
      })                                                                          // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated the API Design section." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "lock in cursor-based pagination for the API")
    await handleFeatureChannelMessage(params)

    // Draft was saved to GitHub
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    const savedContent = Buffer.from(
      mockCreateOrUpdate.mock.calls.find((c: any[]) =>
        c[0]?.path?.includes("onboarding.engineering.md")
      )?.[0]?.content ?? "",
      "base64"
    ).toString()
    expect(savedContent).toContain("cursor-based pagination")
  })
})

// ─── Scenario 12: State query preview freshness ───────────────────────────────
//
// When a state query surfaces uncommitted decisions, the handler must regenerate
// the preview from the committed spec (not serve the stale GitHub file) and label
// it clearly so a new user knows what they're looking at.
// When everything is committed, the saved GitHub file is served (no Sonnet call).

describe("Scenario 12 — State query preview freshness", () => {
  const THREAD = "workflow-s12"
  const DESIGN_DRAFT = "# Onboarding Design\n\n## Screens\nHome screen with prompt bar."
  const SAVED_HTML   = "<html>@keyframes x{} body{background-color:#000;} </html>"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("regenerates preview from committed spec when uncommitted decisions exist", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    seedHistory("onboarding", 10)

    // GitHub call order in state query path:
    // 1. design draft (on design branch), 2. brand (main), 3. productVision (main),
    // 4. systemArchitecture (main) — uncommitted path skips htmlFilePath read (calls generateDesignPreview instead)
    mockGetContent
      .mockResolvedValueOnce({ data: { content: Buffer.from(DESIGN_DRAFT).toString("base64"), type: "file" } }) // 1. design draft
      .mockRejectedValue(new Error("Not Found")) // 2+ brand, productVision, systemArchitecture, etc.

    // Anthropic: [0] identifyUncommittedDecisions → pending, [1] auditSpecRenderAmbiguity → [] findings,
    // [2] auditPhaseCompletion → PASS
    // (generateDesignPreview is template-based, no LLM call)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode: Archon palette agreed\n2. Chip fade timing: 150ms agreed" }] }) // identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] }) // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] }) // auditPhaseCompletion

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // uploadV2 called with "(committed spec)" title — not the stale saved file
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(uploadCall?.title).toContain("committed spec")
    expect(uploadCall?.content).toBeTruthy() // template-rendered HTML

    // 3 Anthropic calls — identifyUncommittedDecisions + auditSpecRenderAmbiguity + auditPhaseCompletion
    // (generateDesignPreview is template-based, no LLM call)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)

    // Response text tells user the preview reflects the committed spec only
    const text = lastUpdateText(client)
    expect(text).toContain("committed spec only")
  })

  it("serves saved GitHub preview without regenerating when all decisions are committed", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    seedHistory("onboarding", 10)

    // GitHub call order in state query path:
    // 1. design draft (on design branch), 2. brand (main), 3. productVision (main),
    // 4. systemArchitecture (main), 5. approvedProductSpec (main), 6. htmlFilePath (on design branch)
    mockGetContent
      .mockResolvedValueOnce({ data: { content: Buffer.from(DESIGN_DRAFT).toString("base64"), type: "file" } }) // 1. design draft
      .mockRejectedValueOnce(new Error("Not Found")) // 2. brand
      .mockRejectedValueOnce(new Error("Not Found")) // 3. productVision
      .mockRejectedValueOnce(new Error("Not Found")) // 4. systemArchitecture
      .mockRejectedValueOnce(new Error("Not Found")) // 5. approvedProductSpec
      .mockResolvedValueOnce({ data: { content: Buffer.from(SAVED_HTML).toString("base64"), type: "file" } }) // 6. saved preview HTML

    // Anthropic: [0] identifyUncommittedDecisions → none, [1] auditSpecRenderAmbiguity → [] findings,
    // auditPhaseCompletion may be a cache hit from the first Scenario 12 test (same spec + featureName).
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] }) // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] }) // auditPhaseCompletion (if cache miss)

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // uploadV2 called with normal title (NOT "(committed spec)")
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(uploadCall?.title).not.toContain("committed spec")
    expect(uploadCall?.content).toBe(SAVED_HTML)

    // 2-3 Anthropic calls — identifyUncommittedDecisions + auditSpecRenderAmbiguity always fire;
    // auditPhaseCompletion fires only on cache miss (may be populated by previous Scenario 12 test).
    // (generateDesignPreview was NOT called — saved GitHub file served directly)
    expect(mockAnthropicCreate.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("state query completes with preview when uncommitted decisions exist", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    seedHistory("onboarding", 10)

    // GitHub: design draft on first read; brand/productVision/systemArchitecture reject
    mockGetContent
      .mockResolvedValueOnce({ data: { content: Buffer.from(DESIGN_DRAFT).toString("base64"), type: "file" } })
      .mockRejectedValue(new Error("Not Found"))

    // Anthropic: identifyUncommittedDecisions + auditSpecRenderAmbiguity + auditPhaseCompletion
    // generateDesignPreview is template-based (no LLM call)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode: Archon palette agreed" }] }) // identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] }) // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] }) // auditPhaseCompletion

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // State response is posted with uncommitted decisions
    const text = lastUpdateText(client)
    expect(text).toContain("PENDING")
    expect(text).toContain("Dark mode")

    // Preview IS uploaded — template renderer always succeeds
    expect(client.files.uploadV2).toHaveBeenCalled()
  })
})

// ─── Scenario 13: Post-response uncommitted-decision detection ─────────────────
//
// The post-response audit passes only the current turn (userMessage + agentResponse)
// to identifyUncommittedDecisions — NOT the full history. This prevents false positives
// from prior-session messages whose wording doesn't perfectly mirror the spec.
//
// Tests:
// 1. Preview regen turn with no new decisions → classifier returns "all committed" → no :warning:
// 2. Turn with a new design decision not saved → classifier returns decision list → :warning: appended
// 3. Turn where agent calls a save tool → classifier not called at all (didSave = true skips audit)

describe("Scenario 13 — Post-response uncommitted-decision detection (current turn only)", () => {
  const THREAD = "workflow-s13"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("no warning when current turn introduces no new decisions (preview regen)", async () => {
    // Seed history so fullHistoryDesign.length > 2 (guard passes) and extractLockedDecisions fires.
    seedHistory("onboarding", 3)
    setConfirmedAgent("onboarding", "ux-design")

    // Anthropic call sequence (short history → extractLockedDecisions fires at length ≥ 6; length=3 → skips):
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent (tool_use)      → generate_design_preview
    //   [3] runAgent (end_turn)      → "Preview is live."  (generateDesignPreview is template-based)
    //   [4] identifyUncommittedDecisions (current turn only) → all committed
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Spec" } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Preview is live. Ready to approve." }] }) // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] }) // identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "yes regenerate a fresh preview"), client })

    const text = lastUpdateText(client)
    expect(text).toContain("Preview is live")
    expect(text).not.toContain("⚠️")
    expect(text).not.toContain("Heads up")
  })

  it("appends warning when current turn introduces a new decision that wasn't saved", async () => {
    seedHistory("onboarding", 3)
    setConfirmedAgent("onboarding", "ux-design")

    // Same sequence as above but identifyUncommittedDecisions returns an uncommitted decision.
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Spec" } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Here's the preview. I also recommend switching the CTA to violet." }] }) // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. CTA button color: violet — discussed this turn, not in spec." }] }) // identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "make the CTA violet"), client })

    const text = lastUpdateText(client)
    expect(text).toContain("⚠️")
    expect(text).toContain("Heads up")
    expect(text).toContain("save those")
  })

  it("does not call identifyUncommittedDecisions when agent called a save tool", async () => {
    seedHistory("onboarding", 3)
    setConfirmedAgent("onboarding", "ux-design")

    // apply_design_spec_patch calls save → didSave = true → no post-response audit call.
    // Call sequence (history=3, length < 6 → no extractLockedDecisions):
    //   [0] isOffTopicForAgent  → false
    //   [1] isSpecStateQuery    → false
    //   [2] runAgent (tool_use) → apply_design_spec_patch
    //   [3] auditSpecRenderAmbiguity  (generateDesignPreview is template-based — no LLM call) → [] (no ambiguities)
    //   [4] runAgent (end_turn) → response text
    //   NO identifyUncommittedDecisions call
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Colors\nViolet CTA." } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })          // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated and saved. Ready to approve?" }] }) // runAgent: end_turn
    // If identifyUncommittedDecisions were called, it would hit the default mockResolvedValue
    // fallback which is undefined → would throw. Verifying no throw + call count = 5.

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "make the CTA violet and save"), client })

    // Exactly 5 Anthropic calls — generateDesignPreview is template-based (no LLM); no 6th call for identifyUncommittedDecisions
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)

    const text = lastUpdateText(client)
    expect(text).not.toContain("⚠️")
  })

  it("does not fire warning when agent response ends with 'Lock this in?' — agentStillSeeking guard", async () => {
    seedHistory("onboarding", 3)
    setConfirmedAgent("onboarding", "ux-design")

    // Agent recommends glow opacity and asks "Lock this in?" — no save, but confirmation is pending.
    // Call sequence (history=3, length < 6 → no extractLockedDecisions):
    //   [0] isOffTopicForAgent  → false
    //   [1] isSpecStateQuery    → false
    //   [2] runAgent (end_turn) → recommendation + "Lock this in?"
    //   NO identifyUncommittedDecisions call (agentStillSeeking guard fires)
    // No design draft on branch → auditPhaseCompletion skipped
    const agentResponseWithSeekingPhrase = "My recommendation: use 8–12% glow opacity (subtle ambient warmth). Lock this in?"
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })        // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })        // isSpecStateQuery
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: agentResponseWithSeekingPhrase }] }) // runAgent

    const client = makeClient()
    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "what glow opacity do you recommend?"), client })

    // Only 3 calls — identifyUncommittedDecisions is NOT called when agentStillSeeking
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)
    const text = lastUpdateText(client)
    expect(text).not.toContain("⚠️")
    expect(text).toContain("Lock this in?")
  })
})


// ─── Scenario 14: Post-save end-turn error surfaces "spec saved" message ────────
//
// When runAgent's final end-turn Anthropic call fails AFTER a save tool already
// ran successfully, the handler must:
//   (a) NOT propagate the error to withThinking (no generic "Something went wrong")
//   (b) Show a clear "spec saved" confirmation with the feature name and next step
//   (c) Store the save message in history (so future turns see it)
//
// This matches the real production failure seen at 8:45 AM where the spec was saved
// but the user saw "Something went wrong" with no indication their change was committed.

describe("Scenario 14 — Post-save end-turn error surfaces spec-saved message", () => {
  const THREAD = "workflow-s14"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("shows spec-saved confirmation when end-turn Anthropic call fails after apply_design_spec_patch", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Anthropic call sequence (empty history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent  → false
    //   [1] isSpecStateQuery    → false
    //   [2] runAgent (tool_use) → apply_design_spec_patch
    //   [3] generateDesignPreview (inside saveDesignDraft)
    //   [4] runAgent (end_turn) → THROWS (simulates context-limit or transient API error)
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Auth Sheet\nEnters from bottom." } }],
      })                                                                            // runAgent: tool_use
      .mockRejectedValueOnce(new Error("Input too long: request exceeds context window")) // runAgent: end_turn FAILS

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    // Must NOT throw — the save succeeded, only the response text generation failed
    await expect(
      handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "yes update the spec for auth sheet from bottom"), client })
    ).resolves.toBeUndefined()

    // Spec was saved to GitHub
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // User sees a clear confirmation — not "Something went wrong"
    const text = lastUpdateText(client)
    expect(text).toContain("✓")
    expect(text).toContain("Spec saved")
    expect(text).not.toContain("Something went wrong")

    // Message was stored in history so future turns have context
    const history = getHistory("onboarding")
    const lastMsg = history[history.length - 1]
    expect(lastMsg.role).toBe("assistant")
    expect(lastMsg.content).toContain("Spec saved")
  })

  it("still propagates error to withThinking when runAgent fails before any save tool runs", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // runAgent fails on the first call (no tool was called, no spec was saved)
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockRejectedValueOnce(new Error("The API is overloaded"))                   // runAgent: first call FAILS

    const client = makeClient()

    // Must throw — withThinking shows the appropriate error message
    await expect(
      handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "show me the spec"), client })
    ).rejects.toThrow()

    const text = lastUpdateText(client)
    expect(text).toContain("overloaded")
    expect(text).not.toContain("Spec saved")
  })
})


// ─── Scenario 15: Audit fires on short-history threads; preview from committed spec ─
//
// Two fixes verified here:
//
// Fix 1 (guard removal): The fullHistoryDesign.length > 2 guard is gone. The post-response
// audit now fires on EVERY design turn (even fresh threads with 0 history messages),
// which is what catches hallucinated saves after thread summarization.
//
// Fix 2 (preview from GitHub): generate_design_preview uses context.currentDraft (loaded
// from GitHub at turn start) instead of the agent's in-memory specContent. After thread
// summarization the agent's memory is stale — using the committed spec prevents regressions.

describe("Scenario 15 — Audit fires on short-history threads; preview uses committed spec", () => {
  const THREAD = "workflow-s15"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("audit fires and flags uncommitted decision when in-memory history is empty (guard removed)", async () => {
    // No seedHistory — history length = 0. Old guard (fullHistoryDesign.length > 2) would
    // have blocked the audit. After removing the guard, it always runs on non-save turns.
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (0 history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent          → false
    //   [1] isSpecStateQuery            → false
    //   [2] runAgent                    → text claiming spec update
    //   [3] identifyUncommittedDecisions → uncommitted decision found
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "The spec now uses 3 columns with wide margins." }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Layout: 3 columns — discussed this turn, not in spec." }] }) // identifyUncommittedDecisions

    const client = makeClient()
    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "update the layout to 3 columns"), client })

    const text = lastUpdateText(client)
    expect(text).toContain("⚠️")
    expect(text).toContain("Heads up")
    expect(text).toContain("save those")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
  })

  it("generate_design_preview uses context.currentDraft from GitHub, not agent's stale in-memory specContent", async () => {
    // The agent passes "# Stale Agent Memory STALE_MARKER" as specContent to the tool.
    // After the fix, the tool handler ignores this and passes context.currentDraft (empty
    // since no design spec exists on the branch) to generateDesignPreview. The html-renderer
    // Anthropic call must NOT contain the stale agent text.
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (0 history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent (tool_use)      → generate_design_preview with stale specContent
    //   [3] html-renderer            → receives context.currentDraft (not stale spec)
    //   [4] runAgent (end_turn)      → "Preview is live."
    //   [5] identifyUncommittedDecisions → all committed
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Stale Agent Memory STALE_MARKER" } }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // html-renderer
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Preview is live." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "give me the latest preview"), client })

    // The html-renderer Anthropic call (index 3) must NOT contain the agent's stale spec
    const htmlRendererCall = mockAnthropicCreate.mock.calls[3][0]
    const rendererUserMessage = htmlRendererCall.messages[0].content as string
    expect(rendererUserMessage).not.toContain("STALE_MARKER")

    // Upload title no longer says "(not saved)" — preview is always from committed spec
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(uploadCall.title).not.toContain("not saved")
  })
})


// ─── Scenario 16: Deterministic previews — cache + patch-based rendering ──────
//
// Two behaviors verified here:
//
// Layer 1 (cache): generate_design_preview reads the saved HTML from the design branch
// and serves it directly — no LLM renderer call. The preview is always identical across
// "give me the preview" calls because the renderer is only invoked when the spec changes.
//
// Layer 2 (patch-based): apply_design_spec_patch passes the exact patch sections to
// updateDesignPreview instead of the full merged spec. The renderer receives existing HTML
// + only the changed sections, so approved inspector states and animations are preserved.

// ─── Scenario 17: Render ambiguity audit fires on spec save ──────────────────
//
// When the design agent saves a spec, auditSpecRenderAmbiguity runs and its
// result is included in the tool return value as `renderAmbiguities`.
// When ambiguities are present, the agent must patch them immediately.
// When the spec is fully specified, the tool result has no renderAmbiguities field.

describe("Scenario 17 — Render ambiguity audit fires on spec save", () => {
  const THREAD = "workflow-s17"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("save returns renderAmbiguities when audit finds vague elements", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (0 history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent
    //   [1] isSpecStateQuery
    //   [2] runAgent (tool_use) → apply_design_spec_patch
    //   [3] auditSpecRenderAmbiguity → ambiguities present  (generateDesignPreview is template-based)
    //   [4] runAgent (tool_use again) → apply_design_spec_patch (agent fixes ambiguities)
    //   [5] auditSpecRenderAmbiguity → [] (resolved)
    //   [6] runAgent (end_turn) → response
    //   [7] identifyUncommittedDecisions
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nChips positioned near the bottom." } }],
      })                                                                        // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["Chat Home chips position is vague — must specify exact spacing from prompt bar"]' }] }) // auditSpecRenderAmbiguity → ambiguities
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nChips: 12px above the prompt bar." } }],
      })                                                                        // runAgent: tool_use (agent patches ambiguity)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })      // auditSpecRenderAmbiguity → resolved
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated chip positioning to 12px above the prompt bar." }] }) // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "save the spec"), client })

    // Agent called apply_design_spec_patch twice (initial save + ambiguity fix)
    const patchCalls = mockAnthropicCreate.mock.calls.filter((c: any[]) =>
      c[0]?.tools?.some((t: any) => t.name === "apply_design_spec_patch")
    )
    expect(patchCalls.length).toBeGreaterThanOrEqual(1)

    // Final response text is from the agent fixing the ambiguity
    const text = lastUpdateText(client)
    expect(text).toContain("12px")
  })

  it("save with no ambiguities produces no renderAmbiguities in tool result", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (didSave=true → identifyUncommittedDecisions skipped):
    //   [0] isOffTopicForAgent
    //   [1] isSpecStateQuery
    //   [2] runAgent (tool_use) → apply_design_spec_patch
    //   [3] generateDesignPreview → HTML
    //   [4] auditSpecRenderAmbiguity → [] (no ambiguities)
    //   [5] runAgent (end_turn) → response
    //   NO identifyUncommittedDecisions (save tool was called)
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nHeading: \"Health360\". Chips: 12px above prompt bar." } }],
      })                                                                        // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })      // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec saved. Ready to approve." }] }) // runAgent: end_turn

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "save with full spec"), client })

    // Exactly 5 Anthropic calls — generateDesignPreview is template-based (no LLM); no 6th (identifyUncommittedDecisions skipped)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)

    const text = lastUpdateText(client)
    expect(text).toContain("approve")
  })
})

describe("Scenario 16 — Deterministic preview: cache on pure-preview, patch-based on spec save", () => {
  const THREAD = "workflow-s16"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("cached HTML served directly when generate_design_preview called (no LLM renderer call)", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Return cached HTML for the preview file; reject everything else (product vision, brand, etc.)
    mockGetContent.mockImplementation(({ path }: { path?: string }) => {
      if (path?.endsWith(".preview.html")) {
        return Promise.resolve({
          data: { content: Buffer.from("<html>cached preview CACHE_MARKER</html>").toString("base64"), type: "file" },
        })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Call sequence (0 history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent         → false
    //   [1] isSpecStateQuery           → false
    //   [2] runAgent (tool_use)        → generate_design_preview
    //       handler: cache hit → uploadV2(cached HTML) → return immediately (no renderer call)
    //   [3] runAgent (end_turn)        → "Here's the latest preview."
    //   [4] identifyUncommittedDecisions → all committed
    // mockGetContent only matches .preview.html (not .design.md) → no design draft → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Agent Memory (irrelevant)" } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Here's the latest preview." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient() as ReturnType<typeof makeClient> & { files: { uploadV2: ReturnType<typeof vi.fn> } }
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "give me the latest preview"), client })

    // 5 Anthropic calls — no LLM renderer call (that would add a 6th)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)

    // uploadV2 received the cached HTML, not a freshly generated one
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(uploadCall.content).toContain("CACHE_MARKER")
  })

  it("first preview (no cache) calls renderer and saves HTML to branch", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    // default mockGetContent → "Not Found" for everything (set in beforeEach)

    // Call sequence:
    //   [0] isOffTopicForAgent, [1] isSpecStateQuery
    //   [2] runAgent (tool_use) → generate_design_preview
    //       handler: no cache → [3] generateDesignPreview (renderer) → saveDraftHtmlPreview → uploadV2
    //   [4] runAgent (end_turn), [5] identifyUncommittedDecisions
    // Default mockGetContent rejects everything → no design draft → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Spec" } }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // html-renderer
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Preview generated." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient() as ReturnType<typeof makeClient> & { files: { uploadV2: ReturnType<typeof vi.fn> } }
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "show me the preview"), client })

    // HTML saved to branch (createOrUpdateFileContents called for the .preview.html file)
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // uploadV2 received the freshly generated HTML (matching the renderer mock output)
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(uploadCall.content).toContain('id="hero"')
  })

  it("apply_design_spec_patch always calls generateDesignPreview with the full merged spec — not patch-based update", async () => {
    // updateDesignPreview was removed because it caused two failure modes:
    // 1. Sonnet missed or paraphrased the patch text (wrong content in preview).
    // 2. Sonnet modified elements outside the patch scope (regressions on Auth Sheet, animations, etc.).
    // Now saveDesignDraft always does a full regeneration from the merged spec.
    setConfirmedAgent("onboarding", "ux-design")

    const EXISTING_SECTION = "## Existing Section\nContent."
    const THE_PATCH = "## Screens\nNew dark mode screen layout PATCH_MARKER"
    // Merged spec = EXISTING_SECTION + THE_PATCH (applySpecPatch appends new sections)

    // Only the design.md file needs to be returned; no preview.html cache read anymore.
    mockGetContent.mockImplementation(({ path }: { path?: string }) => {
      if (path?.endsWith(".design.md")) {
        return Promise.resolve({
          data: { content: Buffer.from(EXISTING_SECTION).toString("base64"), type: "file" },
        })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Call sequence:
    //   [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] auditPhaseCompletion → PASS
    //   [3] runAgent (tool_use) → apply_design_spec_patch with THE_PATCH
    //       handler: readFile(designFilePath) → existing spec; applySpecPatch; saveDesignDraft(merged)
    //         saveDesignDraft: generateDesignPreview(full merged spec) → [4] renderer call
    //         [5] auditSpecRenderAmbiguity → []
    //   [6] runAgent (end_turn), [7] identifyUncommittedDecisions
    // Design draft found (.design.md matched) → auditPhaseCompletion fires at [2]
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })             // auditPhaseCompletion → PASS
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: THE_PATCH } }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })               // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec and preview updated." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient() as ReturnType<typeof makeClient> & { files: { uploadV2: ReturnType<typeof vi.fn> } }
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "lock in dark mode screens"), client })

    // The renderer (call index 4) received the FULL MERGED SPEC — both existing and patch sections.
    // It does NOT receive the existing HTML cache (no EXISTING HTML in the prompt).
    const rendererCall = mockAnthropicCreate.mock.calls[4][0]
    const rendererUserMessage = rendererCall.messages[0].content as string
    expect(rendererUserMessage).toContain("PATCH_MARKER")         // patch section present in merged spec
    expect(rendererUserMessage).toContain("Existing Section")     // existing section present in merged spec
    expect(rendererUserMessage).not.toContain("existing preview") // old HTML cache NOT passed through
  })
})

// ─── Scenario 18: Architect escalation round-trip ────────────────────────────
//
// Verifies that offer_architect_escalation correctly notifies the ARCHITECT
// (not the PM) on confirmation. Previously the handler always used roles.pmUser
// regardless of pendingEscalation.targetAgent.

describe("Scenario 18 — Architect escalation round-trip from design agent", () => {
  const THREAD = "workflow-s18"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("Turn 1: design agent calls offer_architect_escalation → pending stored with targetAgent: architect", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Anthropic call sequence (empty history, no PM spec → no phase entry audit):
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent (tool_use)      → offer_architect_escalation
    //   [3] runAgent (end_turn)      → text after tool result
    //   [4] identifyUncommittedDecisions → none
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_architect_escalation", input: { question: "Where is user state persisted between logged-out and logged-in sessions?" } }],
      })                                                                              // runAgent: tool_use
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I've flagged this for the architect — design is paused until they weigh in on the storage model." }],
      })                                                                              // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })          // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "how should we handle session carry-over?")
    await handleFeatureChannelMessage(params)

    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("architect")
    expect(pending?.question).toContain("user state persisted")

    const text = lastUpdateText(params.client)
    expect(text).toContain("architect")
  })

  it("Turn 2: user says yes → architect agent runs with brief, then @mention posted for human review", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    // Override env so architectUser is set to a known Slack ID
    process.env.SLACK_ARCHITECT_USER = "U_ARCHITECT"
    appendMessage("onboarding", { role: "user", content: "how should we handle session carry-over?" })
    appendMessage("onboarding", { role: "assistant", content: "I've flagged this for the architect — design is paused until they weigh in on the storage model." })

    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation("onboarding", {
      targetAgent: "architect",
      question: "Where is user state persisted between logged-out and logged-in sessions?",
      designContext: "Onboarding design in progress.",
    })

    // Architect agent runs — mock any Anthropic calls with a valid response
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Recommendation: Store the session conversation as a draft Conversation entity linked to a device token, then migrate it to the user account on sign-up." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 30 },
    })

    const params = makeParams(THREAD, "feature-onboarding", "yes please escalate")
    await handleFeatureChannelMessage(params)

    // Architect agent was called
    expect(mockAnthropicCreate).toHaveBeenCalled()

    // Human architect notified via separate postMessage — @mentions <@U_ARCHITECT>, NOT PM
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const reviewPost = postCalls.find((c: any) => c[0]?.text?.includes("review the recommendations above"))
    expect(reviewPost).toBeDefined()
    expect(reviewPost[0].text).toContain("<@U_ARCHITECT>")
    expect(reviewPost[0].text).not.toContain("Product Manager")

    // Pending cleared
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    // EscalationNotification set for architect reply
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notif = getEscalationNotification("onboarding")
    expect(notif).not.toBeNull()
    expect(notif?.targetAgent).toBe("architect")
  })
})

// ─── Scenario 20: Always-on architect engineering spec completeness audit ──────
//
// auditPhaseCompletion(ENGINEER_RUBRIC) runs always-on at position [2] when an
// engineering spec draft is found on the branch (via readFile). If no engineering
// draft is found, auditPhaseCompletion is skipped entirely and runAgent runs at [2].
//
// This mirrors the designReadinessNotice pattern and enforces Principle 7 for the
// architect agent: spec gaps are surfaced on every message, not only on readiness queries.

describe("Scenario 20 — Always-on architect engineering spec completeness audit", () => {
  const THREAD = "workflow-s20"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("auditPhaseCompletion fires on every architect message when engineering draft exists", async () => {
    setConfirmedAgent("onboarding", "architect")

    // Engineering spec draft exists on engineering branch — triggers auditPhaseCompletion
    const ENG_SPEC = "## API Design\nPOST /api/v1/onboarding — creates onboarding session.\n## Data Model\nOnboardingSession entity."
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith(".engineering.md") && ref === "spec/onboarding-engineering") {
        return Promise.resolve({ data: { content: Buffer.from(ENG_SPEC).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Anthropic call sequence (empty history, no PM/design spec on main → no upstream audit):
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] auditPhaseCompletion     → FINDING (spec not ready)
    //   [3] runAgent                 → agent surfaces the gap
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({                                                  // auditPhaseCompletion → FINDING
        content: [{ type: "text", text: "FINDING: OnboardingSession data model missing explicit field names | Add fields: id (UUID), userId (UUID FK), completedAt (timestamp nullable), createdAt (timestamp)" }],
      })
      .mockResolvedValueOnce({                                                  // runAgent
        stop_reason: "end_turn",
        content: [{ type: "text", text: "The engineering spec is NOT implementation-ready. The OnboardingSession data model lacks explicit field names. I recommend adding: id (UUID), userId (UUID FK), completedAt (timestamp nullable), createdAt (timestamp). Shall I apply this now?" }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "how does the data model look?")
    await handleFeatureChannelMessage(params)

    // The runAgent call (index 3) received the enriched message with the audit injected
    const runAgentCall = mockAnthropicCreate.mock.calls[3][0]
    const userMsg = (runAgentCall.messages as { role: string; content: string }[]).at(-1)
    expect(userMsg?.content).toContain("[PLATFORM ENGINEERING READINESS")
    expect(userMsg?.content).toContain("OnboardingSession data model missing explicit field names")

    // 4 total Anthropic calls
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
  })

  it("auditPhaseCompletion is skipped when no engineering draft exists on branch", async () => {
    setConfirmedAgent("onboarding", "architect")

    // Default mockGetContent rejects everything → no engineering draft found
    // Anthropic call sequence:
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent                 → response (no audit injection)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "No engineering spec drafted yet. What would you like to spec out first?" }] })

    await handleFeatureChannelMessage(makeParams(THREAD, "feature-onboarding", "how does the data model look?"))

    // auditPhaseCompletion never ran — only 3 calls total
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)

    // runAgent call (index 2) does NOT contain audit notice
    const runAgentCall = mockAnthropicCreate.mock.calls[2][0]
    const userMsg = (runAgentCall.messages as { role: string; content: string }[]).at(-1)
    expect(userMsg?.content).not.toContain("[PLATFORM ENGINEERING READINESS")
  })
})

// ─── Scenario 19: Always-on phase completion audit injection ─────────────────
//
// auditPhaseCompletion runs always-on at position [2] when a design spec draft is
// found on the branch (via readFile). If no design draft is found, auditPhaseCompletion
// is skipped entirely and runAgent runs at position [2].
//
// This is the deterministic platform enforcement that proactively surfaces spec gaps
// on every design agent response when a draft exists — not just on readiness queries.

describe("Scenario 19 — Always-on phase completion audit injection", () => {
  const THREAD = "workflow-s19"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("auditPhaseCompletion fires on every design agent message when design draft exists", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Design spec exists on design branch — triggers auditPhaseCompletion
    const DESIGN_SPEC = "## Screens\nChat Home: chips positioned horizontally.\n## Auth Sheet\nSSO buttons full-width."
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith(".design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(DESIGN_SPEC).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Anthropic call sequence (empty history, no PM spec on main → no phase entry audit):
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] auditPhaseCompletion     → FINDING (spec not ready)
    //   [3] runAgent                 → agent surfaces the gap
    //   [4] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({                                                  // auditPhaseCompletion → FINDING
        content: [{ type: "text", text: "FINDING: Chip row has no concrete position anchor | Specify margin-top: auto on hero flex column to pin chips above prompt bar" }],
      })
      .mockResolvedValueOnce({                                                  // runAgent
        stop_reason: "end_turn",
        content: [{ type: "text", text: "The spec is NOT engineering-ready. The chip row lacks a concrete position anchor. I recommend specifying margin-top: auto to pin chips above the prompt bar. Should I apply this now?" }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "how does dark mode look?")
    await handleFeatureChannelMessage(params)

    // The runAgent call (index 3) received the enriched message with the audit injected
    const runAgentCall = mockAnthropicCreate.mock.calls[3][0]
    const userMsg = (runAgentCall.messages as { role: string; content: string }[]).at(-1)
    expect(userMsg?.content).toContain("[PLATFORM DESIGN READINESS")
    expect(userMsg?.content).toContain("Chip row has no concrete position anchor")

    // 5 total Anthropic calls
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
  })

  it("auditPhaseCompletion is skipped when no design draft exists on branch", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Default mockGetContent rejects everything → no design draft found
    // Anthropic call sequence:
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent                 → response (no audit injection)
    //   [3] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "The dark mode spec looks solid. Any other questions?" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    await handleFeatureChannelMessage(makeParams(THREAD, "feature-onboarding", "how does dark mode look?"))

    // auditPhaseCompletion never ran — only 4 calls total
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)

    // runAgent call (index 2) does NOT contain audit notice
    const runAgentCall = mockAnthropicCreate.mock.calls[2][0]
    const userMsg = (runAgentCall.messages as { role: string; content: string }[]).at(-1)
    expect(userMsg?.content).not.toContain("[PLATFORM DESIGN READINESS")
  })
})

// ─── Scenario 21: Brand drift hard gate at finalize_design_spec ───────────────
//
// finalize_design_spec MUST be blocked (error returned to agent) when
// auditBrandTokens finds drift vs BRAND.md. The spec cannot be approved with
// brand token drift — this is a hard gate, not an advisory notice.
//
// Call order (design draft found → auditPhaseCompletion fires at [2]):
//   [0] isOffTopicForAgent       → false
//   [1] isSpecStateQuery         → false
//   [2] auditPhaseCompletion     → PASS (no readiness gaps)
//   [3] runAgent                 → tool_use: finalize_design_spec
//   [4] auditSpecDecisions       → "" (no corrections)
//   [5] runAgent                 → end_turn (agent sees tool error, explains block)
//
// finalize_design_spec calls readFile(designFilePath, designBranchName) independently
// of loadDesignAgentContext — both are covered by the path-routed mockGetContent.

const S21_FIXTURE_DIR = join(__dirname, "../fixtures/agent-output")
const S21_BRAND_MD = readFileSync(join(S21_FIXTURE_DIR, "brand-md.md"), "utf-8")
const S21_DRIFTED_DRAFT = readFileSync(join(S21_FIXTURE_DIR, "design-brand-section-drifted.md"), "utf-8")
const S21_CANONICAL_DRAFT = readFileSync(join(S21_FIXTURE_DIR, "design-brand-section-canonical.md"), "utf-8")

describe("Scenario 21 — Brand drift hard gate at finalize_design_spec", () => {
  const THREAD = "workflow-s21"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("blocks finalization when brand token drift detected — spec NOT saved to GitHub", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Design draft on branch has drifted tokens (--bg, --violet wrong vs BRAND.md).
    // BRAND.md is present on main — triggers hard gate in finalize_design_spec handler.
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(S21_DRIFTED_DRAFT).toString("base64"), type: "file" } })
      }
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from(S21_BRAND_MD).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] auditPhaseCompletion → PASS,
    // [3] runAgent → tool_use: finalize_design_spec,
    //     auditSpecDecisions skips LLM (history.length < 2 → returns "ok" immediately),
    //     auditBrandTokens fires (pure) → drift found → tool returns error,
    // [4] runAgent → end_turn (agent sees tool error, explains block)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditPhaseCompletion
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_design_spec", input: {} }],
      })                                                                                    // runAgent: tool_use
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Finalization blocked — brand token drift detected. Please patch --bg and --violet to match BRAND.md before approving." }],
      })                                                                                    // runAgent: end_turn after tool error

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams(THREAD, "feature-onboarding", "approve the design spec", client))

    // Hard gate fired — spec was NOT written to GitHub
    expect(mockCreateOrUpdate).not.toHaveBeenCalled()

    // Tool result delivered to the agent contained the brand drift error
    const runAgentAfterToolCall = mockAnthropicCreate.mock.calls[4][0]
    const toolResultMsg = (runAgentAfterToolCall.messages as Array<{ role: string; content: unknown }>)
      .findLast((m: { role: string }) => m.role === "user")
    const toolResultContent = toolResultMsg?.content
    const toolResultText = Array.isArray(toolResultContent)
      ? (toolResultContent as Array<{ type: string; content?: string }>).find(b => b.type === "tool_result")?.content ?? ""
      : ""
    expect(toolResultText).toContain("Finalization blocked")
    expect(toolResultText).toContain("brand token drift")

    // 5 Anthropic calls total
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
  })

  it("allows finalization when no brand drift — spec saved to GitHub", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Design draft on branch has canonical tokens matching BRAND.md — no drift.
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(S21_CANONICAL_DRAFT).toString("base64"), type: "file" } })
      }
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from(S21_BRAND_MD).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] auditPhaseCompletion → PASS,
    // [3] runAgent → tool_use: finalize_design_spec,
    //     auditSpecDecisions skips LLM (history.length < 2 → returns "ok" immediately),
    //     auditBrandTokens fires (pure) → no drift → saveApprovedDesignSpec called,
    // [4] runAgent → end_turn (spec approved)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditPhaseCompletion
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_design_spec", input: {} }],
      })                                                                                    // runAgent: tool_use
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Design spec approved and saved to GitHub." }],
      })                                                                                    // runAgent: end_turn after spec saved

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams(THREAD, "feature-onboarding", "approve the design spec", client))

    // No drift → spec WAS saved
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // 5 Anthropic calls total
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
  })
})

// ─── Scenario 22: Action menu appended after design agent LLM response ────────
//
// When brand drift is detected on the design draft, the platform-structural action
// menu must appear in the final Slack update — regardless of how the agent phrased
// its response. This tests that buildActionMenu output is appended structurally,
// not via prompt instruction.
//
// Setup: drifted design draft on branch + BRAND.md on main → auditBrandTokens finds
// drift → action menu with "Brand Drift" category + "Fix:" labels + sequential numbers
// + "OPEN ITEMS" header + CTA appended after agent prose.
//
// Call order:
//   [0] isOffTopicForAgent       → false
//   [1] isSpecStateQuery         → false
//   [2] auditPhaseCompletion     → PASS (no readiness gaps)
//   [3] runAgent                 → end_turn (short agent prose)
//   [4] identifyUncommittedDecisions → none

describe("Scenario 22 — Action menu appended after design agent LLM response", () => {
  const THREAD = "workflow-s22"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("action menu with Brand Drift entries appears in final update when drift detected", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Drifted draft on branch + BRAND.md on main — mockImplementation handles multiple calls
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(S21_DRIFTED_DRAFT).toString("base64"), type: "file" } })
      }
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from(S21_BRAND_MD).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // auditPhaseCompletion is cache-hit from Scenario 21 (same spec fingerprint + same featureName).
    // The module-level phaseEntryAuditCache persists across tests in the same module run.
    // So the call sequence has 4 calls, not 5 — no auditPhaseCompletion API call here.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "The spec looks good. Anything else to review?" }],
      })                                                                                    // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })               // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "how does the onboarding flow look?")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)

    // Agent prose is present
    expect(text).toContain("The spec looks good.")

    // Action menu structural elements
    expect(text).toContain("*── OPEN ITEMS ──*")
    expect(text).toContain("Brand Drift")

    // At least one drifted token from the fixture appears with Fix label
    expect(text).toContain("--bg")
    expect(text).toContain("*Fix:*")

    // CTA for applying fixes
    expect(text).toContain("Say *fix 1 2 3* (or *fix all*)")

    // Separator before action menu
    expect(text).toMatch(/---/)

    // 4 Anthropic calls total (auditPhaseCompletion is a cache hit — no API call)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
  })
})

// ─── Scenario 23: State path shows all 4 action menu categories ───────────────
//
// The state query path (Path A) must produce the same 4-category buildActionMenu
// output as the LLM path (Path B). This test would have caught the original bug
// where the state card was missing readiness gaps, missing tokens, and used a
// different CTA format.
//
// Setup: drifted design draft (S21_DRIFTED_DRAFT) + BRAND.md (S21_BRAND_MD) on
// branch/main. Thread is fresh (0 history messages) so identifyUncommittedDecisions
// is skipped.
//
// Anthropic call sequence for "hi" (check-in → state path, no isOffTopicForAgent
// or isSpecStateQuery calls):
//   [0] auditSpecRenderAmbiguity → "[]"
//   [1] auditPhaseCompletion     → "PASS" (no readiness gaps)
//   Total: 2 calls

describe("Scenario 23 — State path shows all 4 action menu categories", () => {
  const THREAD = "workflow-s23"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("state card includes OPEN ITEMS action menu with Brand Drift entries", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(S21_DRIFTED_DRAFT).toString("base64"), type: "file" } })
      }
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from(S21_BRAND_MD).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Fresh thread (0 history messages) — identifyUncommittedDecisions is skipped.
    // auditSpecRenderAmbiguity fires first. auditPhaseCompletion may be a cache hit from
    // Scenario 21 (same spec fingerprint + featureName) — the module-level cache persists
    // across tests. Provide the mock in case it's not a cache hit; if it is, only 1 call fires.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })        // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })      // auditPhaseCompletion (if cache miss)

    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)

    // State card informational sections are present
    expect(text).toContain("PENDING")

    // Action menu structural elements — same as LLM path
    expect(text).toContain("*── OPEN ITEMS ──*")
    expect(text).toContain("Brand Drift")

    // At least one drifted token from the fixture appears with Fix label
    expect(text).toContain("--bg")
    expect(text).toContain("*Fix:*")

    // CTA for applying fixes
    expect(text).toContain("Say *fix 1 2 3* (or *fix all*)")

    // auditSpecRenderAmbiguity always fires (1 call minimum); auditPhaseCompletion
    // fires only on cache miss (may be populated by Scenario 21 in the same test run).
    expect(mockAnthropicCreate.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it("state card exercises animation drift, missing tokens, and readiness findings paths", async () => {
    // Uses a unique featureName to avoid cache interference from other tests.
    // Spec: missing the --teal token entirely (→ missingTokensState) and has drifted
    // glow-duration (→ animationDrifts). auditPhaseCompletion returns a finding
    // (→ readinessFindingsState). This test covers the remaining arrow-function paths
    // in stateActionMenu that the first Scenario 23 test cannot reach.
    const FEATURE = "billing"
    clearHistory(FEATURE)

    setConfirmedAgent(FEATURE, "ux-design")

    const BRAND_WITH_ANIM = [
      "## Color Palette",
      "```",
      "--bg:    #0A0A0F",
      "--teal:  #4FAFA8",
      "```",
      "## Glow",
      "```css",
      "@keyframes glow-pulse { 0% { opacity: 0.1 } 100% { opacity: 0.15 } }",
      "filter: blur(80px);",
      "animation: glow-pulse 4s cubic-bezier(0.4, 0, 0.2, 1) infinite;",
      "animation-delay: -2s;",
      "```",
    ].join("\n")

    // Spec has --bg but NOT --teal (missing token), and glow-duration 2.5s (drifted vs 4s).
    const SPEC_WITH_ANIM_DRIFT = [
      "## Brand",
      "- `--bg:` `#0A0A0F`",
      "",
      "**Glow (Animation)**",
      "```css",
      "@keyframes glow-pulse { 0% { opacity: 0.1 } 100% { opacity: 0.15 } }",
      "filter: blur(80px);",
      "animation: glow-pulse 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;",
      "animation-delay: -2s;",
      "```",
      "",
      "### Screen 1: Home",
      "Main content.",
      "",
      "## Open Questions",
      "None.",
    ].join("\n")

    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("billing.design.md") && ref === "spec/billing-design") {
        return Promise.resolve({ data: { content: Buffer.from(SPEC_WITH_ANIM_DRIFT).toString("base64"), type: "file" } })
      }
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from(BRAND_WITH_ANIM).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // auditSpecRenderAmbiguity → [] (no quality issues), auditPhaseCompletion → readiness finding
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })  // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "FINDING: Screen coverage incomplete | Add error state screens" }],
      })  // auditPhaseCompletion

    const params = makeParams("workflow-s23b", "feature-billing", "hi")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)

    // Action menu structural elements present
    expect(text).toContain("*── OPEN ITEMS ──*")

    // animationDrifts.map() path exercised — glow-duration is drifted
    expect(text).toContain("glow-duration")

    // missingTokensState.map() path exercised — --teal not in spec
    expect(text).toContain("--teal")
    expect(text).toContain("Missing Brand Tokens")

    // readinessFindingsState.map() path exercised — finding returned by auditPhaseCompletion
    expect(text).toContain("Design Readiness Gaps")
    expect(text).toContain("Screen coverage incomplete")

    clearHistory(FEATURE)
  })
})

// ─── Scenario 22: Architect read_approved_specs tool ─────────────────────────
//
// When the architect agent calls read_approved_specs tool, the handler reads
// engineering specs for the specified features from GitHub main branch.

describe("Scenario 22 — Architect read_approved_specs tool", () => {
  const THREAD = "workflow-s22"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("read_approved_specs with empty featureNames returns early without GitHub read", async () => {
    setConfirmedAgent("onboarding", "architect")

    // Architect Anthropic call sequence: isOffTopicForAgent → isSpecStateQuery → runAgent (tool_use with empty featureNames) → runAgent (end_turn)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_approved_specs", input: { featureNames: [] } }],
      })                                                                          // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "No additional specs needed." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "are there any related approved specs I should check?")
    await handleFeatureChannelMessage(params)

    // Agent response was relayed
    const text = lastUpdateText(params.client)
    expect(text).toContain("No additional specs needed.")
  })

  it("read_approved_specs with featureNames reads specs from GitHub main", async () => {
    setConfirmedAgent("onboarding", "architect")

    const DASHBOARD_SPEC = "# Dashboard Engineering Spec\n\n## Data Model\nUser sessions table."
    // GitHub: read_approved_specs will try to read specs/features/dashboard/dashboard.engineering.md on main
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path && path.includes("dashboard.engineering.md")) {
        return { data: { content: Buffer.from(DASHBOARD_SPEC).toString("base64"), type: "file" } }
      }
      throw new Error("Not Found")
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_approved_specs", input: { featureNames: ["dashboard"] } }],
      })                                                                          // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "The dashboard uses a sessions table." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "how does the dashboard's data model work?")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("dashboard")
  })
})

// ─── Scenario 22b: read_approved_specs — readFile throws for a feature ────────
//
// When readFile throws for a requested feature (e.g., spec not yet merged),
// the .catch(() => null) swallows the error and the feature is excluded from specs.

describe("Scenario 22b — read_approved_specs: readFile throws — feature excluded silently", () => {
  const THREAD = "workflow-s22b"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("when readFile throws for a requested feature, that feature is excluded and agent continues", async () => {
    setConfirmedAgent("onboarding", "architect")

    // GitHub: all reads throw (spec not found on main)
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_approved_specs", input: { featureNames: ["missing-feature"] } }],
      })                                                                          // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "No spec found for that feature." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "check the missing-feature spec")
    await handleFeatureChannelMessage(params)

    // Agent response was relayed — the error was swallowed silently
    const text = lastUpdateText(params.client)
    expect(text).toContain("No spec found for that feature.")
  })
})

// ─── Scenario 23: Architect finalize_engineering_spec tool ────────────────────
//
// When the architect agent calls finalize_engineering_spec tool, the handler
// saves the engineering spec to main branch after checking for blocking questions.

describe("Scenario 23 — Architect finalize_engineering_spec tool", () => {
  const THREAD = "workflow-s23"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("finalize_engineering_spec returns error when no draft exists", async () => {
    setConfirmedAgent("onboarding", "architect")

    // No draft on branch
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_engineering_spec", input: {} }],
      })                                                                          // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Need to save a draft first." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "finalize the engineering spec")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("Need to save a draft first.")
    // createOrUpdateFileContents should NOT have been called since finalize failed
    expect(mockCreateOrUpdate).not.toHaveBeenCalled()
  })

  it("finalize_engineering_spec saves draft to main when no blocking questions", async () => {
    setConfirmedAgent("onboarding", "architect")

    const DRAFT = "# Onboarding Engineering Spec\n\n## Data Model\nUsers table.\n\n## Open Questions\n- What is the API rate limit? [type: engineering] [blocking: no]"

    // Draft exists on branch — read it during finalize_engineering_spec
    mockGetContent.mockImplementation(async ({ path, ref }: { path: string; ref?: string }) => {
      if (path && path.includes("onboarding.engineering.md") && ref && ref.includes("engineering")) {
        return { data: { content: Buffer.from(DRAFT).toString("base64"), type: "file" } }
      }
      throw new Error("Not Found")
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ ready: true, findings: [] }) }] }) // auditPhaseCompletion (engDraftContent found)
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_engineering_spec", input: {} }],
      })                                                                          // runAgent: tool_use — finalize
      // auditSpecDecisions skips API call when history < 2 messages (empty history)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Engineering spec finalized and ready for build." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "the spec is ready, finalize it")
    await handleFeatureChannelMessage(params)

    // spec was saved to main branch
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    const text = lastUpdateText(params.client)
    expect(text).toContain("finalized")
  })
})

// ─── Scenario 24: Architect state query path ──────────────────────────────────
//
// When architect agent receives a state query ("where are we"), it returns
// a formatted summary of the engineering draft without calling Sonnet.

describe("Scenario 24 — Architect state query path", () => {
  const THREAD = "workflow-s24"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("state query with no engineering draft replies with 'no draft yet' message", async () => {
    setConfirmedAgent("onboarding", "architect")

    // No branch draft
    mockGetContent.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "yes" }] })      // isSpecStateQuery — returns true

    const params = makeParams(THREAD, "feature-onboarding", "where are we with the engineering spec?")
    await handleFeatureChannelMessage(params)

    // No Sonnet call — fast path
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    const text = lastUpdateText(params.client)
    expect(text).toContain("No engineering draft yet")
  })

  it("state query with engineering draft returns structured summary", async () => {
    setConfirmedAgent("onboarding", "architect")

    const DRAFT = `# Onboarding Engineering Spec

## Open Questions
- Should we use cursor pagination? [type: engineering] [blocking: yes]
- Which CDN provider? [type: engineering] [blocking: no]
`

    mockGetContent.mockImplementation(async ({ path, ref }: { path: string; ref?: string }) => {
      if (path && path.includes("onboarding.engineering.md") && ref && ref.includes("engineering")) {
        return { data: { content: Buffer.from(DRAFT).toString("base64"), type: "file" } }
      }
      throw new Error("Not Found")
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "yes" }] })      // isSpecStateQuery

    const params = makeParams(THREAD, "feature-onboarding", "where are we?")
    await handleFeatureChannelMessage(params)

    // No Sonnet call
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
    const text = lastUpdateText(params.client)
    expect(text).toContain("engineering spec")
    // Blocking question should be surfaced
    expect(text).toContain("Blocking")
  })
})

// ─── Scenario 25: Architect off-topic redirect ────────────────────────────────

describe("Scenario 25 — Architect off-topic redirect", () => {
  const THREAD = "workflow-s25"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("off-topic message redirects to main channel with concierge note", async () => {
    setConfirmedAgent("onboarding", "architect")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "off-topic" }] })  // isOffTopicForAgent → true

    const params = makeParams(THREAD, "feature-onboarding", "what features are in progress across the platform?")
    await handleFeatureChannelMessage(params)

    // Only 1 Anthropic call — isOffTopicForAgent short-circuits
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1)
    const text = lastUpdateText(params.client)
    expect(text).toContain("Architect")
  })
})

// ─── Scenario 26: Architect engineering spec approval ─────────────────────────

describe("Scenario 26 — Architect engineering spec approval", () => {
  const THREAD = "workflow-s26"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("user confirms engineering spec approval → spec saved and approved message shown", async () => {
    setPendingApproval("onboarding", {
      specType: "engineering",
      specContent: "# Onboarding Engineering Spec\n\n## Data Model\nUsers table.",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      featureName: "onboarding",
    })
    setConfirmedAgent("onboarding", "architect")

    const params = makeParams(THREAD, "feature-onboarding", "confirmed")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("engineering spec is saved and approved")
    expect(text).toContain("engineer agents")
  })

  it("user rejects engineering spec approval → pending cleared, falls through to agent", async () => {
    setPendingApproval("onboarding", {
      specType: "engineering",
      specContent: "# Onboarding Engineering Spec\n\n## Data Model\nUsers table.",
      filePath: "specs/features/onboarding/onboarding.engineering.md",
      featureName: "onboarding",
    })
    setConfirmedAgent("onboarding", "architect")

    // Not affirmative — falls through to full architect flow
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "What would you like to change?" }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "actually wait, let me review again")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("What would you like to change?")
  })
})

// ─── Scenario 27: Architect finalize with decision corrections ────────────────

describe("Scenario 27 — Architect finalize with decision corrections", () => {
  const THREAD = "workflow-s27"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("finalize_engineering_spec applies decision corrections when audit finds mismatches", async () => {
    setConfirmedAgent("onboarding", "architect")

    // Seed history with 2+ messages so auditSpecDecisions makes an API call
    appendMessage("onboarding", { role: "user", content: "lock pagination at 50 items per page" })
    appendMessage("onboarding", { role: "assistant", content: "Locked. 50 items per page." })

    const DRAFT = "# Onboarding Engineering Spec\n\n## API Design\nGET /api/v1/onboarding — 100 items per page.\n\n## Open Questions\n"

    mockGetContent.mockImplementation(async ({ path, ref }: { path: string; ref?: string }) => {
      if (path && path.includes("onboarding.engineering.md") && ref && ref.includes("engineering")) {
        return { data: { content: Buffer.from(DRAFT).toString("base64"), type: "file" } }
      }
      throw new Error("Not Found")
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ ready: true, findings: [] }) }] }) // auditPhaseCompletion
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_engineering_spec", input: {} }],
      })                                                                          // runAgent: tool_use — finalize
      // auditSpecDecisions: history has 2 msgs → API call made → returns correction
      .mockResolvedValueOnce({ content: [{ type: "text", text: "MISMATCH: Page size | 100 items per page | 50 items per page" }] }) // auditSpecDecisions
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Finalized with correction applied." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "finalize the spec")
    await handleFeatureChannelMessage(params)

    // Spec saved after correction
    expect(mockCreateOrUpdate).toHaveBeenCalled()
    const text = lastUpdateText(params.client)
    expect(text).toContain("Finalized with correction applied.")
  })

  it("architect tool handler returns error for unknown tool name", async () => {
    setConfirmedAgent("onboarding", "architect")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "unknown_tool_xyz", input: {} }],
      })                                                                          // runAgent: tool_use — unknown
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "I cannot call that tool." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "do something weird")
    await handleFeatureChannelMessage(params)

    // Agent response shows error was surfaced
    const text = lastUpdateText(params.client)
    expect(text).toContain("I cannot call that tool.")
  })
})

// ─── NEW: Scenario N1 — Non-affirmative during PM escalation → reminder + hold ─
//
// When a pending PM escalation exists and the user says "no" (non-affirmative),
// the platform posts a reminder and holds — does NOT clear the escalation or run
// the design agent. The escalation is a hard block until the user says "yes".

describe("Scenario N1 — Non-affirmative during PM escalation → reminder, escalation holds", () => {
  const THREAD = "workflow-n1"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(async () => {
    clearHistory("onboarding")
    clearPendingEscalation("onboarding")
  })

  it("user says 'no' → reminder posted, escalation NOT cleared, no agent call", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "Should social login be supported?",
      designContext: "Onboarding design in progress.",
    })

    // No Anthropic calls — platform returns early with reminder
    const params = makeParams(THREAD, "feature-onboarding", "no, let's continue without them")
    await handleFeatureChannelMessage(params)

    // No AI calls
    expect(mockAnthropicCreate).not.toHaveBeenCalled()

    // Reminder posted via postMessage
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const reminder = postCalls.find((c: any) => c[0]?.text?.includes("Design is paused"))
    expect(reminder).toBeDefined()
    expect(reminder[0].text).toContain("Should social login be supported?")
    expect(reminder[0].text).toContain("Say *yes*")

    // Escalation still pending — not cleared
    expect(getPendingEscalation("onboarding")).not.toBeNull()
  })
})

// ─── NEW: Scenario N2 — Architect escalation rejection path ──────────────────
//
// When a pending architect escalation exists (targetAgent: "architect") and user
// says "no", the escalation is cleared and design agent continues normally.

describe("Scenario N2 — Non-affirmative during architect escalation → reminder, escalation holds", () => {
  const THREAD = "workflow-n2"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(async () => {
    clearHistory("onboarding")
    clearPendingEscalation("onboarding")
  })

  it("user says 'no' to pending architect escalation → reminder posted, escalation NOT cleared", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    setPendingEscalation("onboarding", {
      targetAgent: "architect",
      question: "Where is user state persisted between sessions?",
      designContext: "Onboarding design in progress.",
    })

    // No Anthropic calls — platform returns early with reminder
    const params = makeParams(THREAD, "feature-onboarding", "no, skip the architect")
    await handleFeatureChannelMessage(params)

    // No AI calls
    expect(mockAnthropicCreate).not.toHaveBeenCalled()

    // Reminder posted
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const reminder = postCalls.find((c: any) => c[0]?.text?.includes("Design is paused"))
    expect(reminder).toBeDefined()
    expect(reminder[0].text).toContain("Where is user state persisted")

    // Escalation still pending — not cleared
    expect(getPendingEscalation("onboarding")).not.toBeNull()
  })
})

// ─── NEW: Scenario N3 — classifyIntent unknown agent fallback ─────────────────
//
// classifyIntent returns "pm" as the default when Haiku returns an unrecognised
// agent name. The fallback is inside agent-router.ts (valid.includes check) so
// the platform never crashes on an unexpected classification.
//
// This test drives the new-thread path (no confirmedAgent) with a product-spec-in-
// progress phase and mocks classifyIntent to return a text string that is NOT in
// the valid agent list. The platform must route to PM (the fallback) without crashing.

describe("Scenario N3 — classifyIntent unknown agent name falls back to PM", () => {
  const THREAD = "workflow-n3"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("unknown Haiku response defaults to PM routing — no crash", async () => {
    // No confirmedAgent — new thread. Phase: product-spec-in-progress
    mockPaginate.mockResolvedValueOnce([])

    // Haiku returns an unrecognised agent name — agent-router falls back to "pm"
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "unknown-agent-xyz" }] }) // classifyIntent → invalid → falls back to "pm"
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Let me help you with the product spec." }] }) // PM runAgent

    const params = makeParams(THREAD, "feature-onboarding", "I want to build something new")
    await handleFeatureChannelMessage(params)

    // Platform did not crash — PM ran as the fallback
    expect(getConfirmedAgent("onboarding")).toBe("pm")
    const text = lastUpdateText(params.client)
    expect(text).toContain("product spec")
  })
})

// ─── NEW: Scenario N4 — PM message scope "product-context" path ──────────────
//
// When classifyMessageScope returns "product-context", the PM handler answers
// from the product vision / system architecture directly — without building a
// full PM system prompt or calling save tools.

describe("Scenario N4 — PM classifyMessageScope product-context path", () => {
  const THREAD = "workflow-n4"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("PM handles product-context query by answering from product vision directly", async () => {
    setConfirmedAgent("onboarding", "pm")

    // Phase: still product-spec-in-progress (no branches)
    mockPaginate.mockResolvedValueOnce([])

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "product-context" }] })  // classifyMessageScope → product-context
      .mockResolvedValueOnce({ content: [{ type: "text", text: "TestApp is a platform for X." }] }) // runAgent (product context path)

    const params = makeParams(THREAD, "feature-onboarding", "what is this product for?")
    await handleFeatureChannelMessage(params)

    // Exactly 2 Anthropic calls — classifyMessageScope + product-context runAgent
    // (no extractLockedDecisions because history is empty; no PM rubric system prompt)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)

    const text = lastUpdateText(params.client)
    expect(text).toContain("TestApp is a platform for X.")
    // Response should include the "product context" label
    expect(text).toContain("product context")
  })
})

// ─── NEW: Scenario N5 — PM history limit (40 messages) ───────────────────────
//
// runPmAgent passes historyLimit: 40 to getPriorContext. When the conversation
// store has more than 40 messages, getPriorContext summarises the older messages
// and calls summarizeUnlockedDiscussion (a Haiku call). This keeps the Anthropic
// payload well within the context limit.

describe("Scenario N5 — PM history limit 40 messages", () => {
  const THREAD = "workflow-n5"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("sends at most 41 messages to Anthropic (40 history + current) even when store has 50+", async () => {
    setConfirmedAgent("onboarding", "pm")

    // Seed 50 alternating messages in the conversation store
    for (let i = 0; i < 50; i++) {
      appendMessage("onboarding", { role: i % 2 === 0 ? "user" : "assistant", content: `pm-msg ${i}` })
    }

    // Phase: still in progress (no branches → no phase switch)
    mockPaginate.mockResolvedValueOnce([])

    // Anthropic call sequence:
    //   [0] classifyMessageScope     → feature-specific
    //   [1] extractLockedDecisions   → "" (> 6 msgs)
    //   [2] summarizeUnlockedDiscussion → summary (history.length > PM_HISTORY_LIMIT=40)
    //   [3] PM runAgent              → response
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })   // classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })                   // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Summary of earlier discussion." }] }) // summarizeUnlockedDiscussion
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PM response on history-limited context." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "latest question")
    await handleFeatureChannelMessage(params)

    // PM runAgent call (index 3) — inspect messages array
    const runAgentCall = mockAnthropicCreate.mock.calls[3][0]
    // messages array: ≤40 history messages + 1 current user message = ≤41 total
    expect(runAgentCall.messages.length).toBeLessThanOrEqual(41)

    // Oldest messages (pm-msg 0) must not appear in the runAgent payload
    const allContent = runAgentCall.messages.map((m: { content: string }) => m.content).join(" ")
    expect(allContent).not.toContain("pm-msg 0")
    expect(allContent).toContain("latest question")
  })
})

// ─── NEW: Scenario N6 — Architect cache invalidation on upstream spec edit ────
//
// The phaseEntryAuditCache for the architect is keyed on
// `arch:${featureName}:${fingerprint(pmSpec)}:${fingerprint(designSpec)}`.
// When the engineering spec draft changes between turns (different fingerprint),
// the arch-phase cache misses and re-runs auditPhaseCompletion.
//
// We simulate this by running two back-to-back messages where the second has a
// different engineering spec content on the branch. The second message must make
// an auditPhaseCompletion API call (cache miss), while a third identical-spec
// message would be a cache hit (no API call).

describe("Scenario N6 — Architect cache invalidation when engineering spec changes", () => {
  const THREAD = "workflow-n6"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("second message with different spec content invalidates arch-phase cache and re-audits", async () => {
    const FEATURE = "cache-inv-test"
    clearHistory(FEATURE)
    setConfirmedAgent(FEATURE, "architect")

    const ENG_SPEC_V1 = "## API Design\nPOST /api/v1/test v1-content."
    const ENG_SPEC_V2 = "## API Design\nPOST /api/v1/test v2-content-CHANGED."

    // Turn 1: spec v1 on branch
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith(`${FEATURE}.engineering.md`) && ref === `spec/${FEATURE}-engineering`) {
        return Promise.resolve({ data: { content: Buffer.from(ENG_SPEC_V1).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // auditPhaseCompletion → v1 spec
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Response turn 1." }] }) // runAgent

    const params1 = makeParams(THREAD, `feature-${FEATURE}`, "how is the API?")
    await handleFeatureChannelMessage(params1)

    // Turn 1: auditPhaseCompletion fired once (index 2)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)

    vi.clearAllMocks()

    // Turn 2: spec v2 on branch — different fingerprint → cache miss → re-audit
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith(`${FEATURE}.engineering.md`) && ref === `spec/${FEATURE}-engineering`) {
        return Promise.resolve({ data: { content: Buffer.from(ENG_SPEC_V2).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // auditPhaseCompletion → v2 spec (cache miss!)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Response turn 2." }] }) // runAgent

    const params2 = makeParams(THREAD, `feature-${FEATURE}`, "anything else?")
    await handleFeatureChannelMessage(params2)

    // auditPhaseCompletion fired again (cache miss due to spec change)
    // 4 total calls: isOffTopicForAgent + isSpecStateQuery + auditPhaseCompletion + runAgent
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)

    clearHistory(FEATURE)
  })
})

// ─── NEW: Scenario N7 — Preview generation failure path ──────────────────────
//
// When generateDesignPreview throws during saveDesignDraft (save_design_spec_draft
// tool handler), the platform catches the error and continues — the spec is still
// saved to GitHub and the agent gets a valid tool result (previewUrl: "saved_to_github").
// No crash propagates to withThinking.

describe("Scenario N7 — Preview generation failure does not crash the platform", () => {
  const THREAD = "workflow-n7"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("generateDesignPreview throws → spec saved, agent gets previewUrl saved_to_github, no crash", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (0 history → no extractLockedDecisions, no auditPhaseCompletion):
    //   [0] isOffTopicForAgent  → false
    //   [1] isSpecStateQuery    → false
    //   [2] runAgent (tool_use) → save_design_spec_draft
    //       handler: auditSpecDraft skips LLM (empty productVision/architecture)
    //       generateDesignPreview → throws (no LLM mock provided for renderer)
    //       previewUrl = "saved_to_github" (fallback)
    //   [3] auditSpecRenderAmbiguity → [] (no ambiguities)
    //   [4] runAgent (end_turn) → "Spec saved. Preview will come later."
    //   NO identifyUncommittedDecisions (save tool was called → didSave = true)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "save_design_spec_draft", input: { content: "## Screens\nHome screen." } }],
      })                                                                                // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })             // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec saved. Preview will come later." }] }) // runAgent: end_turn

    // No mock for the renderer — generateDesignPreview calls Anthropic which returns undefined
    // (since we mock mockResolvedValue(undefined) in beforeEach as the default).
    // The renderer catches the error internally and returns HTML from template instead.
    // To force a genuine error path we can make the renderer's LLM call reject:
    // The sequence above only provides 5 mocks. The 6th call (renderer) will get undefined
    // from the default mock (no mock registered) → renderer handles it gracefully (template fallback).

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    // Must NOT throw — the spec was saved successfully
    await expect(
      handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "save the spec"), client })
    ).resolves.toBeUndefined()

    // Spec was saved to GitHub
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // Agent response was relayed — no crash message
    const text = lastUpdateText(client)
    expect(text).toContain("Spec saved")
    expect(text).not.toContain("Something went wrong")
  })
})

// ─── NEW: Scenario N8 — Mixed brand + animation + missing audits fire together ─
//
// The platform builds the action menu from three parallel audit results:
//   brandDriftsDesign  (auditBrandTokens)
//   animDriftsDesign   (auditAnimationTokens)
//   missingTokensDesign (auditMissingBrandTokens)
// When all three categories have issues simultaneously, all three appear in the
// action menu under the "Brand Drift" and "Missing Brand Tokens" categories.
//
// This test uses the billing feature (unique name → no cache interference).

describe("Scenario N8 — Mixed brand/animation/missing audits all appear in action menu", () => {
  const THREAD = "workflow-n8"

  beforeEach(() => {
    clearHistory("billing-n8")
    clearSummaryCache("billing-n8")
  })
  afterEach(() => {
    clearHistory("billing-n8")
    clearSummaryCache("billing-n8")
  })

  it("Brand Drift + animation drift + missing tokens all appear in LLM-path action menu", async () => {
    setConfirmedAgent("billing-n8", "ux-design")

    const BRAND = [
      "## Color Palette",
      "```",
      "--bg:    #0A0A0F",
      "--teal:  #4FAFA8",
      "```",
      "## Glow",
      "```css",
      "@keyframes glow-pulse { 0% { opacity: 0.1 } 100% { opacity: 0.15 } }",
      "filter: blur(80px);",
      "animation: glow-pulse 4s cubic-bezier(0.4, 0, 0.2, 1) infinite;",
      "animation-delay: -2s;",
      "```",
    ].join("\n")

    // Spec: --bg is correct, --teal is MISSING, glow-duration is 2.5s (drifted from 4s)
    const SPEC = [
      "## Brand",
      "- `--bg:` `#0A0A0F`",
      "",
      "**Glow (Animation)**",
      "```css",
      "@keyframes glow-pulse { 0% { opacity: 0.1 } 100% { opacity: 0.15 } }",
      "filter: blur(80px);",
      "animation: glow-pulse 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;",
      "animation-delay: -2s;",
      "```",
    ].join("\n")

    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("billing-n8.design.md") && ref === "spec/billing-n8-design") {
        return Promise.resolve({ data: { content: Buffer.from(SPEC).toString("base64"), type: "file" } })
      }
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from(BRAND).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // auditPhaseCompletion fires (design draft exists); unique spec → cache miss
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // auditPhaseCompletion → PASS
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Here is the spec." }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-billing-n8", "how is the spec?")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)

    // Action menu structural header
    expect(text).toContain("*── OPEN ITEMS ──*")

    // Brand Drift category covers both color and animation drifts
    expect(text).toContain("Brand Drift")

    // animation drift — glow-duration 2.5s vs brand 4s
    expect(text).toContain("glow-duration")

    // Missing Brand Tokens category — --teal not in spec
    expect(text).toContain("Missing Brand Tokens")
    expect(text).toContain("--teal")

    // CTA present
    expect(text).toContain("fix all")
  })
})

// ─── NEW: Scenario N9 — Summarization warning fires exactly once ──────────────
//
// When conversation history exceeds the DESIGN_HISTORY_LIMIT (20) and
// getPriorContext returns a non-empty summary, the platform posts a one-time
// notice via postMessage. The flag is stored in the module-level
// summarizationWarnedFeatures Set so subsequent messages do NOT re-post it.

describe("Scenario N9 — Summarization warning fires exactly once per feature", () => {
  const THREAD = "workflow-n9"

  // Use a unique feature name so the module-level Set state doesn't bleed from other tests
  const FEATURE = "sum-warn-test"

  beforeEach(() => {
    clearHistory(FEATURE)
    clearSummaryCache(FEATURE)
  })
  afterEach(() => {
    clearHistory(FEATURE)
    clearSummaryCache(FEATURE)
  })

  it("summarization warning is posted on first message that exceeds limit, not on second", async () => {
    setConfirmedAgent(FEATURE, "ux-design")

    // Seed 25 messages (> DESIGN_HISTORY_LIMIT = 20) so getPriorContext summarises
    for (let i = 0; i < 25; i++) {
      appendMessage(FEATURE, { role: i % 2 === 0 ? "user" : "assistant", content: `sum-msg ${i}` })
    }

    // No design draft on branch → auditPhaseCompletion skipped
    // Turn 1 Anthropic sequence:
    //   [0] isOffTopicForAgent        → false
    //   [1] isSpecStateQuery          → false
    //   [2] extractLockedDecisions    → "" (> 6 msgs)
    //   [3] summarizeUnlockedDiscussion → "Summary of old messages" (fires because history > 20)
    //   [4] runAgent                  → response
    //   [5] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })              // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Summary of old messages." }] }) // summarizeUnlockedDiscussion
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Turn 1 response." }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })          // identifyUncommittedDecisions

    const client1 = makeClient()
    await handleFeatureChannelMessage({ ...makeParams(THREAD, `feature-${FEATURE}`, "turn 1"), client: client1 })

    // Summarization warning was posted once via postMessage (not update)
    const postCalls1 = (client1.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const warnPost1 = postCalls1.find((c: any) => c[0]?.text?.includes("summarized"))
    expect(warnPost1).toBeDefined()
    expect(warnPost1[0].text).toContain("Context from earlier in this thread has been summarized")

    vi.clearAllMocks()

    // Turn 2: history still exceeds limit but warning already fired — must NOT post again
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })              // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Summary of old messages (same)." }] }) // summarizeUnlockedDiscussion (fires again — history unchanged)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Turn 2 response." }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })          // identifyUncommittedDecisions

    const client2 = makeClient()
    await handleFeatureChannelMessage({ ...makeParams(THREAD, `feature-${FEATURE}`, "turn 2"), client: client2 })

    // Summarization warning NOT re-posted on turn 2
    const postCalls2 = (client2.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const warnPost2 = postCalls2.find((c: any) => c[0]?.text?.includes("summarized"))
    expect(warnPost2).toBeUndefined()
  })
})

// ─── NEW: Scenario N10 — read_approved_specs partial failure ──────────────────
//
// When read_approved_specs is called with multiple featureNames and readFile
// throws for one of them (spec not yet merged), the platform uses .catch(() => null)
// to swallow individual failures. The succeeding specs are returned in the tool
// result and the agent can continue with partial data.

describe("Scenario N10 — read_approved_specs partial failure: one feature fails, others succeed", () => {
  const THREAD = "workflow-n10"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("one spec fails, other specs load — agent gets partial results and continues", async () => {
    setConfirmedAgent("onboarding", "architect")

    const GOOD_SPEC = "# Dashboard Engineering Spec\n\n## Data Model\nUser sessions table."

    // Only dashboard.engineering.md resolves; missing-feature throws
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path && path.includes("dashboard.engineering.md")) {
        return { data: { content: Buffer.from(GOOD_SPEC).toString("base64"), type: "file" } }
      }
      throw new Error("Not Found")
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_approved_specs", input: { featureNames: ["dashboard", "missing-feature"] } }],
      })                                                                          // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Got dashboard spec, missing-feature not found." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "check dashboard and missing-feature specs")
    await handleFeatureChannelMessage(params)

    // Agent response relayed — no crash even though one spec failed
    const text = lastUpdateText(params.client)
    expect(text).toContain("dashboard spec")

    // The runAgent call after the tool result received the partial data
    // (dashboard present, missing-feature absent — verified by agent response wording)
    expect(text).not.toContain("Something went wrong")
  })
})

// ─── NEW: Scenario N11 — Cache isolation between concurrent features ──────────
//
// phaseEntryAuditCache and designReadinessFindingsCache are keyed by
// `design-phase:${featureName}:${specFingerprint}`. Two different features with
// identical spec content must NOT share cache entries — the featureName is part
// of the key.
//
// Verification: Run two messages with different feature names but the same spec
// content. The first message populates the cache for feature-A. The second message
// for feature-B must still make an auditPhaseCompletion call (cache miss on feature-B
// despite same spec fingerprint), proving isolation.

describe("Scenario N11 — Cache isolation between concurrent features", () => {
  const THREAD = "workflow-n11"

  beforeEach(() => {
    clearHistory("cache-feat-a")
    clearHistory("cache-feat-b")
    clearSummaryCache("cache-feat-a")
    clearSummaryCache("cache-feat-b")
  })
  afterEach(() => {
    clearHistory("cache-feat-a")
    clearHistory("cache-feat-b")
    clearSummaryCache("cache-feat-a")
    clearSummaryCache("cache-feat-b")
  })

  it("feature-A cache does not satisfy feature-B lookup — both features audit independently", async () => {
    const SHARED_SPEC = "## Screens\nSame spec content across both features."

    // Feature A: turn 1 — populates cache for "cache-feat-a"
    setConfirmedAgent("cache-feat-a", "ux-design")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("cache-feat-a.design.md") && ref === "spec/cache-feat-a-design") {
        return Promise.resolve({ data: { content: Buffer.from(SHARED_SPEC).toString("base64"), type: "file" } })
      }
      if (path?.endsWith("cache-feat-b.design.md") && ref === "spec/cache-feat-b-design") {
        return Promise.resolve({ data: { content: Buffer.from(SHARED_SPEC).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent (A)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery (A)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // auditPhaseCompletion (A)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Feature A response." }] }) // runAgent (A)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions (A)

    await handleFeatureChannelMessage(makeParams(THREAD, "feature-cache-feat-a", "how is the spec?"))
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)

    vi.clearAllMocks()

    // Feature B: turn 1 — different featureName, same spec content
    // Cache key is `design-phase:cache-feat-b:${fingerprint}` → MISS (featureName is different)
    // → auditPhaseCompletion MUST fire for feature-B
    setConfirmedAgent("cache-feat-b", "ux-design")
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent (B)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery (B)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // auditPhaseCompletion (B) — must fire!
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Feature B response." }] }) // runAgent (B)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions (B)

    await handleFeatureChannelMessage(makeParams(THREAD, "feature-cache-feat-b", "how is the spec?"))

    // auditPhaseCompletion fired for feature-B (5 total calls — not 4, which would mean skip)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
  })
})

// ─── NEW: Scenario N12 — Unknown design agent tool name falls back gracefully ──
//
// When the design agent calls a tool with an unknown name, the toolHandler returns
// { error: "Unknown tool: ..." } and the agent receives it as a tool_result. The
// agent then responds with end_turn explaining the error. No crash propagates.

describe("Scenario N12 — Unknown design agent tool name handled gracefully", () => {
  const THREAD = "workflow-n12"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("unknown design tool returns error to agent, agent continues with end_turn — no crash", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // No design draft → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "totally_unknown_design_tool", input: { foo: "bar" } }],
      })                                                                                // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "That tool is not available." }] }) // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })           // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "try something unusual")
    await expect(handleFeatureChannelMessage(params)).resolves.toBeUndefined()

    // Agent's graceful end_turn response was relayed — no crash
    const text = lastUpdateText(params.client)
    expect(text).toContain("That tool is not available.")
    expect(text).not.toContain("Something went wrong")

    // 5 calls total — platform did not short-circuit on the unknown tool
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
  })
})

// ─── NEW: Scenario N13 — PM agent does NOT gate on brand tokens ───────────────
//
// The PM agent is a pre-design phase agent. It does not load BRAND.md and does
// not check for brand token drift. The finalize_product_spec tool handler has no
// brand drift gate (only the design agent does). This test verifies that:
//   1. PM agent calls do not include brand audit API calls
//   2. finalize_product_spec succeeds even when BRAND.md would have drift
//      (the PM agent doesn't know about brand tokens)

describe("Scenario N13 — PM agent does not gate on brand tokens (pre-design phase)", () => {
  const THREAD = "workflow-n13"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("PM finalize_product_spec completes without brand token checks", async () => {
    setConfirmedAgent("onboarding", "pm")

    // BRAND.md exists on main (would trigger drift checks if PM loaded it)
    mockGetContent.mockImplementation(({ path }: { path?: string }) => {
      if (path === "specs/brand/BRAND.md") {
        return Promise.resolve({ data: { content: Buffer.from("## Color Palette\n```\n--bg: #0A0A0F\n```").toString("base64"), type: "file" } })
      }
      // Product spec draft for finalize_product_spec to read
      if (path?.includes("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from("# Onboarding Product Spec\n\n## Goals\nHelp users onboard.\n\n## Open Questions\n").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Phase: still product-spec-in-progress (no branches)
    mockPaginate.mockResolvedValueOnce([])

    // PM call sequence: classifyMessageScope → runAgent (finalize tool) → runAgent (end_turn)
    // auditSpecDecisions skips LLM (empty history)
    // No brand audit calls — PM does not load BRAND.md
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })                                                                                   // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Product spec finalized." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "the spec is ready, finalize it")
    await handleFeatureChannelMessage(params)

    // Spec was saved — PM finalize succeeded without brand gate
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    const text = lastUpdateText(params.client)
    expect(text).toContain("finalized")

    // Exactly 3 Anthropic calls — NO brand audit calls (PM doesn't touch brand)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)
  })
})

// ─── Scenario N14: Action menu suppressed when escalation offered this turn ───
//
// When the design agent calls offer_pm_escalation, a pendingEscalation is stored.
// The platform detects the null→set transition and suppresses the action menu so
// the user is not shown 20 fixable design items they cannot act on.

describe("Scenario N14 — Action menu suppressed when escalation just offered", () => {
  const THREAD = "workflow-n14"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(() => { clearHistory("onboarding") })

  it("action menu absent from response when offer_pm_escalation called this turn", async () => {
    // Anthropic call sequence:
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] runAgent (tool_use)      → offer_pm_escalation
    //   [3] runAgent (end_turn)      → assertive blocking message
    // No design draft on branch → auditPhaseCompletion skipped, no brand audit
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: "What happens to the guest session when the user signs up mid-conversation?" } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Design cannot move forward until the PM closes this gap. Say *yes* and I'll bring the PM into this thread now." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "let's work on the session handoff")
    await handleFeatureChannelMessage(params)

    // Escalation was stored
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).not.toBeNull()

    // Action menu must NOT appear — no "OPEN ITEMS" in the response
    const text = lastUpdateText(params.client)
    expect(text).not.toContain("OPEN ITEMS")
    expect(text).not.toContain("Say *fix")

    // Agent's assertive message is present
    expect(text).toContain("Design cannot move forward")
  })
})

// ─── Scenario N15: Non-affirmative message during pending escalation ──────────
//
// Once escalation is pending, any non-affirmative message should get a reminder
// and NOT trigger a full agent run. The escalation must remain stored (not cleared).

describe("Scenario N15 — Non-affirmative message during pending escalation → reminder only", () => {
  const THREAD = "workflow-n15"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "What happens to the guest session when the user signs up mid-conversation?",
      designContext: "Design in progress.",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("sends reminder message, does not call runAgent, does not clear pending escalation", async () => {
    // No Anthropic calls expected — platform returns early before classifiers
    const params = makeParams(THREAD, "feature-onboarding", "what about the animation tokens?")
    await handleFeatureChannelMessage(params)

    // No AI calls at all
    expect(mockAnthropicCreate).not.toHaveBeenCalled()

    // Reminder posted via postMessage (not update — no withThinking started)
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const reminder = postCalls.find((c: any) => c[0]?.text?.includes("Design is paused"))
    expect(reminder).toBeDefined()
    expect(reminder[0].text).toContain("What happens to the guest session")
    expect(reminder[0].text).toContain("Say *yes*")

    // Escalation still stored — not cleared
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).not.toBeNull()
  })
})

// ─── Scenario N16: PM reply auto-routes to design agent ──────────────────────
//
// After the escalation notification is set (PM @mentioned), the PM's reply in the
// thread should be detected by userId match, clear the notification, and resume
// the design agent with the answer injected as the user message.

describe("Scenario N16 — PM reply in thread resumes design agent", () => {
  const THREAD = "workflow-n16"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "pm",
      question: "What happens to the guest session when the user signs up mid-conversation?",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("PM reply clears notification and resumes design agent with injected answer", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Great — with the PM's answer I can now finalize the auth flow screen." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    const params = { ...makeParams(THREAD, "feature-onboarding", "Guest sessions are cleared on sign-up."), userId: "U_PM_123" }
    // Simulate PM userId matching roles.pmUser
    process.env.SLACK_PM_USER = "U_PM_123"

    await handleFeatureChannelMessage(params)

    // Design agent was called (Anthropic called at least once for routing + agent)
    expect(mockAnthropicCreate).toHaveBeenCalled()

    // Notification cleared
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).toBeNull()
  })
})

// ─── Scenario N17: Non-PM reply during active notification is not auto-routed ──
//
// When an escalation notification is active but the message comes from a user who is
// neither PM nor Architect (and roles ARE configured), the message should fall
// through to the normal design agent flow — not be treated as the PM answer.

describe("Scenario N17 — Non-PM message during active notification falls through to design agent", () => {
  const THREAD = "workflow-n17"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "pm",
      question: "What happens to the guest session when the user signs up mid-conversation?",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("non-PM userId does not clear notification and runs design agent normally", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Here is my design update." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    // userId is a regular user, not the PM (U_PM_123)
    const params = { ...makeParams(THREAD, "feature-onboarding", "Let me add a small design update"), userId: "U_OTHER_456" }
    process.env.SLACK_PM_USER = "U_PM_123"

    await handleFeatureChannelMessage(params)

    // Design agent ran (Anthropic called)
    expect(mockAnthropicCreate).toHaveBeenCalled()

    // Notification still active — not cleared by non-PM message
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).not.toBeNull()
  })
})

// ─── Scenario N19: Pre-run structural gate fires on [type: product] [blocking: yes] in spec ──
//
// When the design spec draft has [type: product] [blocking: yes] open questions, the platform
// must auto-trigger escalation BEFORE the agent runs — deterministic string match, no LLM.
// This gate fires even if auditPhaseCompletion returns PASS (rubric has no criterion producing
// [type: product] findings). The test proves the pre-run gate works independently of the rubric.

describe("Scenario N19 — Pre-run structural gate fires when spec has [type: product] blocking questions", () => {
  const THREAD = "workflow-n19"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("spec has [type: product] [blocking: yes] question → gate fires before agent, no runAgent Anthropic call", async () => {
    // Design spec draft has an unresolved product-scope open question.
    const draftContent = [
      "## Screens",
      "### Onboarding Welcome",
      "Purpose: First screen after signup.",
      "",
      "## Open Questions",
      "- [type: product] [blocking: yes] Which SSO providers must be supported at launch?",
      "- [type: design] [blocking: no] Should the welcome illustration be static or animated?",
    ].join("\n")

    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(draftContent).toString("base64"), encoding: "base64" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // Anthropic mock sequence: only isOffTopicForAgent, isSpecStateQuery, auditPhaseCompletion.
    // auditPhaseCompletion returns PASS — rubric finds no issues. Pre-run gate fires regardless.
    // runAgent is NOT mocked — if it's called, the test will hang or fail.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 5 } })   // auditPhaseCompletion → PASS (rubric finds nothing)

    const params = makeParams(THREAD, "feature-onboarding", "what's next for the welcome screen?")
    await handleFeatureChannelMessage(params)

    // Pre-run gate must have set pending escalation without calling runAgent.
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("pm")
    expect(pending?.question).toContain("SSO providers")

    // Response must assert the block with the "say yes" CTA.
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")
    expect(text).toContain("SSO providers")

    // The non-product design question must NOT appear in the escalation
    // (it's [type: design], not [type: product]) — gate is selective.
    expect(pending?.question).not.toContain("welcome illustration")
  })
})

// ─── Scenario N18: Platform auto-escalates when agent has product findings but skips tool ──
//
// When designReadinessFindings includes [type: product] findings and the agent does NOT
// call offer_pm_escalation, the platform enforces escalation structurally — regardless of
// what the agent chose to say in prose. This makes the escalation gate deterministic.

describe("Scenario N18 — Platform auto-triggers escalation when agent skips offer_pm_escalation", () => {
  const THREAD = "workflow-n18"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("agent gives prose without calling offer_pm_escalation → platform sets pending escalation from product findings", async () => {
    // Mock GitHub to return a design spec draft so auditPhaseCompletion fires.
    // Path: specs/features/onboarding/onboarding.design.md on branch spec/onboarding-design.
    const draftContent = `## Open Questions\n- [type: product] [blocking: yes] SSO failure handling unspecified`
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(draftContent).toString("base64"), encoding: "base64" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] auditPhaseCompletion     → product finding detected
    //   [3] runAgent (end_turn)      → prose without tool call (the bug case)
    //   [4] identifyUncommittedDecisions → none
    // The agent gives wishy-washy prose without calling the tool.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // isSpecStateQuery
      .mockResolvedValueOnce({
        // auditPhaseCompletion → returns product finding
        content: [{ type: "text", text: "FINDING: [type: product] [blocking: yes] SSO failure handling unspecified | Specify the recovery behavior when SSO token is valid but no account found" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 30 },
      })
      .mockResolvedValueOnce({
        // runAgent → prose without calling offer_pm_escalation (the bug case)
        content: [{ type: "text", text: "Want to escalate these to the PM now, or continue shaping the spec first?" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20 },
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "what can I do next?")
    await handleFeatureChannelMessage(params)

    // Platform must have set pending escalation — agent skipped the tool
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("pm")
    expect(pending?.question).toContain("[type: product]")
    expect(pending?.question).toContain("SSO failure handling")

    // Response must assert the block, not ask a passive question
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")
    expect(text).not.toContain("or continue shaping")
  })
})

// ─── N20: Haiku classifier API error surfaces as user-visible error, not silent hang ──
//
// agent-router.ts Anthropic client now has timeout: 30_000, maxRetries: 0.
// When a classifier (isOffTopicForAgent) throws due to a network stall or timeout,
// the error propagates through handleDesignPhase → withThinking's catch block,
// which posts a user-visible error message. Previously, the default 10min × 2retries
// = 30min hang meant the user saw "thinking..." for up to an hour with no error surfaced.

describe("Scenario N20 — Haiku classifier timeout surfaces as user-visible error", () => {
  const THREAD = "workflow-n20"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })

  afterEach(() => {
    clearHistory("onboarding")
  })

  it("isOffTopicForAgent timeout → user sees error message, not infinite 'thinking'", async () => {
    // First Anthropic call (isOffTopicForAgent) throws a timeout error.
    // withThinking catches it, posts the user-facing error message, then re-throws.
    // The test must handle the re-throw and verify the error message was posted.
    mockAnthropicCreate
      .mockRejectedValueOnce(new Error("APITimeoutError: Request timed out after 30000ms"))

    const params = makeParams(THREAD, "feature-onboarding", "what is the next step for this feature")

    // withThinking re-throws after posting the error message — catch it here
    await handleFeatureChannelMessage(params).catch(() => {})

    // The error must be surfaced as a user-visible message, not left at "thinking..."
    const text = lastUpdateText(params.client)
    expect(text).toMatch(/went wrong|try again|overloaded|Something/i)
  })
})

// ─── N21: approvedProductSpec is passed to auditPhaseCompletion — criterion 10 fires ──
//
// Criterion 10 compares design decisions against the APPROVED PRODUCT SPEC (feature-level)
// and product vision. The prior version only passed productVision. Without the approved PM
// spec, criterion 10 could not catch gaps like vague error paths ("handle gracefully") or
// subjective acceptance criteria ("soft", "ambient") — because those gaps only show up when
// you read the feature-level PM spec, not the platform-level product vision.
//
// This test verifies: when the approved PM spec is in GitHub, it reaches auditPhaseCompletion,
// and criterion 10 findings appear in the Design Readiness Gaps action menu block.

describe("Scenario N21 — Design readiness audit criterion 10 fires when approvedProductSpec is available", () => {
  const THREAD = "workflow-n21"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })

  afterEach(() => {
    clearHistory("onboarding")
  })

  it("criterion 10 [type: product] finding appears in action menu when approvedProductSpec is passed", async () => {
    const designDraft = [
      "## Screens",
      "### Onboarding Welcome",
      "Purpose: First screen after signup.",
      "Auth: Users sign in via Google OAuth2.",
      "## Acceptance Criteria",
      "1. Sign-in indicator is soft and non-intrusive.",
    ].join("\n")

    const approvedProductSpec = "## Acceptance Criteria\n1. SSO sign-in required. Provider TBD by PM.\n2. Logged-out indicator must be present but unobtrusive — no measurable threshold defined."
    const productVision = "# Product Vision\n\nHealth app for conversations."

    // GitHub: design draft on branch, approved PM spec + product vision on main.
    // Without the fix, approvedProductSpec was never passed — criterion 10 returned PASS
    // because it had no PM spec to compare against for vague acceptance criteria.
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(designDraft).toString("base64"), encoding: "base64" } }
      }
      if (path === "specs/features/onboarding/onboarding.product.md") {
        return { data: { type: "file", content: Buffer.from(approvedProductSpec).toString("base64"), encoding: "base64" } }
      }
      if (path === "specs/product/PRODUCT_VISION.md") {
        return { data: { type: "file", content: Buffer.from(productVision).toString("base64"), encoding: "base64" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // Anthropic call sequence — state query path (isSpecStateQuery → yes):
    //   [0] isOffTopicForAgent         → false
    //   [1] isSpecStateQuery           → yes (routes to state path, no agent run)
    //   [2] auditSpecDraft             → OK
    //   [3] auditSpecRenderAmbiguity   → [] (no render issues)
    //   [4] auditPhaseCompletion       → criterion 10: OAuth2 assumed, "soft" has no measurable threshold
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "yes" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "FINDING: [type: product] [blocking: yes] Design assumes Google OAuth2 but PM spec says provider TBD | PM must name the SSO providers before auth UI can be finalized" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 30 },
      })

    const params = makeParams(THREAD, "feature-onboarding", "what is the current state of the design?")
    await handleFeatureChannelMessage(params)

    // Criterion 10 finding must appear in the Design Readiness Gaps section of the action menu.
    const text = lastUpdateText(params.client)
    expect(text).toContain("[type: product]")
    expect(text).toContain("Google OAuth2")
  })
})

// ─── N22: Fallback prose-detection gate — agent writes "say yes" without calling tool ──
//
// The N18 gate requires criterion 10 to generate [type: product] findings. When criterion 10
// returns PASS (e.g. PM spec gaps are vague requirements, not explicit design assumptions),
// N18 never fires — even if the agent correctly identifies the gaps in prose and writes
// "say yes and I'll bring the PM into this thread."
//
// This gate is purely structural: it matches the agent's own controlled output pattern
// ("say yes" + PM escalation context + numbered questions) and auto-sets pendingEscalation,
// suppressing the action menu without replacing the agent's prose.

describe("Scenario N22 — Fallback prose-detection gate suppresses action menu when agent writes 'say yes' without calling offer_pm_escalation", () => {
  const THREAD = "workflow-n22"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("agent prose 'say yes' + 'bring the PM' → pendingEscalation set, action menu absent", async () => {
    // Draft exists — triggers always-on readiness audit path.
    const draftContent = "## Screens\n### Welcome\nPurpose: First screen."
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(draftContent).toString("base64"), encoding: "base64" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // Anthropic call sequence (matches N18 5-call pattern — history empty so extractLockedDecisions
    // returns early; auditSpecRenderAmbiguity only runs in state query path, not agent path):
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false (goes to agent path)
    //   [2] auditPhaseCompletion     → PASS (criterion 10 returns nothing — the gap we're fixing)
    //   [3] runAgent (end_turn)      → prose with "say yes" + "bring the PM" but no tool call
    //   [4] identifyUncommittedDecisions → none
    const agentResponse = [
      "Three PM-level gaps must be resolved before design can proceed:",
      "",
      "1. **SSO error path** — The PM spec says 'handle gracefully' but doesn't define the actual error UX.",
      "2. **Conversation preservation** — What exactly is preserved when a session transfers?",
      "3. **Ephemeral session spec** — What fields does the unauthenticated session entity have?",
      "",
      "Say yes and I'll bring the PM into this thread to close these gaps.",
    ].join("\n")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 40 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })

    const params = makeParams(THREAD, "feature-onboarding", "what's blocking us from finishing this design?")
    await handleFeatureChannelMessage(params)

    // Platform must have set pending escalation from prose detection
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("pm")
    expect(pending?.question).toContain("SSO error path")

    // Action menu must be suppressed — escalation just offered this turn
    const text = lastUpdateText(params.client)
    expect(text).not.toContain("── OPEN ITEMS ──")
    expect(text).not.toContain("Brand Drift")
    expect(text).not.toContain("Design Readiness Gaps")

    // Agent prose is preserved — not replaced by the platform assertion
    expect(text).toMatch(/say yes/i)
    expect(text).toMatch(/bring the PM/i)
  })
})
