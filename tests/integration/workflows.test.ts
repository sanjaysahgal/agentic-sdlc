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
// Design agent surfaces a blocking product question (OFFER_PM_ESCALATION marker).
// User says "yes" → PM agent handles the question in the same thread.
// The PM response appears under the PM label, not UX Designer.

describe("Scenario 4 — PM escalation round-trip from design agent", () => {
  const THREAD = "workflow-s4"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("Turn 1: design agent response with escalation offer passes through to Slack", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // In the tool-based system, the design agent outputs a plain-text escalation offer.
    // There are no OFFER_PM_ESCALATION_START/END markers — those were removed with the
    // text-block protocol. The agent says "want me to pull the PM in?" in plain text.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "This is a product decision — want me to pull the PM in?" }] })  // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "should we support social login?")
    await handleFeatureChannelMessage(params)

    // The escalation offer text passes through to Slack unmodified
    const text = lastUpdateText(params.client)
    expect(text).toContain("want me to pull the PM in")
  })

  it("Turn 2: user says yes → PM is @mentioned in thread, design paused", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    appendMessage("onboarding", { role: "user", content: "should we support social login?" })
    appendMessage("onboarding", { role: "assistant", content: "This is a product decision — want me to pull the PM in?" })

    // Set up the pending escalation as if Turn 1 already ran
    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "Should social login be supported?",
      designContext: "Onboarding design in progress.",
    })

    // No Anthropic calls — escalation posts a Slack message directly, no AI invoked
    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // PM was notified via postMessage, not via AI agent
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const escalationPost = postCalls.find((c: any) => c[0]?.text?.includes("blocking product question"))
    expect(escalationPost).toBeDefined()
    expect(escalationPost[0].text).toContain("Should social login be supported?")
    expect(escalationPost[0].text).toContain("Reply here to unblock design")

    // No AI thinking placeholder — PM agent was NOT invoked
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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All discussed decisions appear to be in the committed spec." }] }) // post-turn identifyUncommittedDecisions

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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All discussed decisions appear to be in the committed spec." }] })

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
    //   [4] runAgent (end_turn call)  → text response after tool result
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Accessibility\nWCAG AA required. Focus rings on all interactive elements. Min tap target 44px." } }],
      })                                                                               // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "<html>preview</html>" }] }) // generateDesignPreview (inside tool handler)
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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "<html>fresh-preview</html>" }] })                                            // generateDesignPreview

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // uploadV2 called with "(committed spec)" title — not the stale saved file
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(uploadCall?.title).toContain("committed spec")
    expect(uploadCall?.content).toBe("<html>fresh-preview</html>")

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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All discussed decisions appear to be in the committed spec." }] })

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
})

