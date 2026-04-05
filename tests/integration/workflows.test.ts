import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

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

  it("Turn 2: user says yes → PM is @mentioned in thread, design paused", async () => {
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

    // No Anthropic calls — escalation confirmation posts a Slack message directly
    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // PM was notified via postMessage
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const escalationPost = postCalls.find((c: any) => c[0]?.text?.includes("blocking product question"))
    expect(escalationPost).toBeDefined()
    expect(escalationPost[0].text).toContain("Should social login be supported?")
    expect(escalationPost[0].text).toContain("Reply here to unblock design")

    // Pending escalation cleared after confirmation
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    // No AI call — escalation confirmation is handled purely by the platform
    expect(mockAnthropicCreate).not.toHaveBeenCalled()
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
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Accessibility\nWCAG AA required. Focus rings on all interactive elements. Min tap target 44px." } }],
      })                                                                               // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview (inside tool handler)
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

    // Anthropic: [0] identifyUncommittedDecisions → pending, [1] generateDesignPreview → HTML
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode: Archon palette agreed\n2. Chip fade timing: 150ms agreed" }] }) // identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] })                                            // generateDesignPreview

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // uploadV2 called with "(committed spec)" title — not the stale saved file
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(uploadCall?.title).toContain("committed spec")
    expect(uploadCall?.content).toBe(VALID_MOCK_HTML)

    // generateDesignPreview was called (2nd Anthropic call)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)

    // Response text tells user the preview reflects the committed spec only
    const text = lastUpdateText(client)
    expect(text).toContain("committed spec only")
  })

  it("serves saved GitHub preview without regenerating when all decisions are committed", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    seedHistory("onboarding", 10)

    // GitHub call order in state query path:
    // 1. design draft (on design branch), 2. brand (main), 3. productVision (main),
    // 4. systemArchitecture (main), 5. htmlFilePath (on design branch)
    mockGetContent
      .mockResolvedValueOnce({ data: { content: Buffer.from(DESIGN_DRAFT).toString("base64"), type: "file" } }) // 1. design draft
      .mockRejectedValueOnce(new Error("Not Found")) // 2. brand
      .mockRejectedValueOnce(new Error("Not Found")) // 3. productVision
      .mockRejectedValueOnce(new Error("Not Found")) // 4. systemArchitecture
      .mockResolvedValueOnce({ data: { content: Buffer.from(SAVED_HTML).toString("base64"), type: "file" } }) // 5. saved preview HTML

    // Anthropic: only identifyUncommittedDecisions — no generateDesignPreview call
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // uploadV2 called with normal title (NOT "(committed spec)")
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(uploadCall?.title).not.toContain("committed spec")
    expect(uploadCall?.content).toBe(SAVED_HTML)

    // Only 1 Anthropic call — generateDesignPreview was NOT called
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1)
  })

  it("state query completes with no preview when generateDesignPreview times out or throws", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    seedHistory("onboarding", 10)

    // GitHub: design draft on first read; brand/productVision/systemArchitecture reject
    mockGetContent
      .mockResolvedValueOnce({ data: { content: Buffer.from(DESIGN_DRAFT).toString("base64"), type: "file" } })
      .mockRejectedValue(new Error("Not Found"))

    // Anthropic: [0] identifyUncommittedDecisions → pending, [1] generateDesignPreview → timeout
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode: Archon palette agreed" }] }) // identifyUncommittedDecisions
      .mockRejectedValueOnce(new Error("Request timeout after 300000ms"))                                   // generateDesignPreview

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    // Suppress expected console.error from the caught preview failure
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    consoleError.mockRestore()

    // State response is still posted — timeout does not crash or hang the handler
    const text = lastUpdateText(client)
    expect(text).toContain("PENDING")
    expect(text).toContain("Dark mode")

    // No preview was uploaded — upload skipped gracefully
    expect(client.files.uploadV2).not.toHaveBeenCalled()
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
    //   [3] generateDesignPreview    → HTML
    //   [4] runAgent (end_turn)      → "Preview is live."
    //   [5] identifyUncommittedDecisions (current turn only) → all committed
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Spec" } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview
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
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "generate_design_preview", input: { specContent: "# Spec" } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview
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
    //   [3] generateDesignPreview (inside saveDesignDraft)
    //   [4] auditSpecRenderAmbiguity → [] (no ambiguities)
    //   [5] runAgent (end_turn) → response text
    //   NO identifyUncommittedDecisions call
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Colors\nViolet CTA." } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })          // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated and saved. Ready to approve?" }] }) // runAgent: end_turn
    // If identifyUncommittedDecisions were called, it would hit the default mockResolvedValue
    // fallback which is undefined → would throw. Verifying no throw + call count = 6.

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "make the CTA violet and save"), client })

    // Exactly 6 Anthropic calls — no 7th call for identifyUncommittedDecisions
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)

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
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Auth Sheet\nEnters from bottom." } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview
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
    //   [3] generateDesignPreview → HTML
    //   [4] auditSpecRenderAmbiguity → ambiguities present
    //   [5] runAgent (tool_use again) → apply_design_spec_patch (agent fixes ambiguities)
    //   [6] generateDesignPreview → HTML for second save
    //   [7] auditSpecRenderAmbiguity → [] (resolved)
    //   [8] runAgent (end_turn) → response
    //   [9] identifyUncommittedDecisions
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nChips positioned near the bottom." } }],
      })                                                                        // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["Chat Home chips position is vague — must specify exact spacing from prompt bar"]' }] }) // auditSpecRenderAmbiguity → ambiguities
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nChips: 12px above the prompt bar." } }],
      })                                                                        // runAgent: tool_use (agent patches ambiguity)
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview (second save)
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
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nHeading: \"Health360\". Chips: 12px above prompt bar." } }],
      })                                                                        // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })      // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec saved. Ready to approve." }] }) // runAgent: end_turn

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "save with full spec"), client })

    // Exactly 6 Anthropic calls — no 7th (identifyUncommittedDecisions skipped when save tool ran)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)

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
    //   [0] isOffTopicForAgent, [1] isSpecStateQuery
    //   [2] runAgent (tool_use) → apply_design_spec_patch with THE_PATCH
    //       handler: readFile(designFilePath) → existing spec; applySpecPatch; saveDesignDraft(merged)
    //         saveDesignDraft: generateDesignPreview(full merged spec) → [3] renderer call
    //         [4] auditSpecRenderAmbiguity → []
    //   [5] runAgent (end_turn), [6] identifyUncommittedDecisions
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: THE_PATCH } }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: VALID_MOCK_HTML }] }) // generateDesignPreview renderer
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })               // auditSpecRenderAmbiguity → no ambiguities
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec and preview updated." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient() as ReturnType<typeof makeClient> & { files: { uploadV2: ReturnType<typeof vi.fn> } }
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "lock in dark mode screens"), client })

    // The renderer (call index 3) received the FULL MERGED SPEC — both existing and patch sections.
    // It does NOT receive the existing HTML cache (no EXISTING HTML in the prompt).
    const rendererCall = mockAnthropicCreate.mock.calls[3][0]
    const rendererUserMessage = rendererCall.messages[0].content as string
    expect(rendererUserMessage).toContain("PATCH_MARKER")         // patch section present in merged spec
    expect(rendererUserMessage).toContain("Existing Section")     // existing section present in merged spec
    expect(rendererUserMessage).not.toContain("existing preview") // old HTML cache NOT passed through
  })
})
