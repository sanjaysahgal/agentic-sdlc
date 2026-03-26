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
function seedHistory(threadTs: string, count = 7) {
  for (let i = 0; i < count; i++) {
    appendMessage(threadTs, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
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

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("Turn 1: approval confirmation shows approval message and preserves pm as confirmedAgent", async () => {
    setPendingApproval(THREAD, {
      specType: "product",
      specContent: "# Onboarding Product Spec\n\n## Problem\nHelp users onboard.",
      filePath: "specs/features/onboarding/onboarding.product.md",
      featureName: "onboarding",
    })
    setConfirmedAgent(THREAD, "pm")

    const params = makeParams(THREAD, "feature-onboarding", "confirmed")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("product spec is saved and approved")
    expect(text).toContain("UX designer")

    // confirmedAgent stays "pm" — phase check happens on next message, not during approval
    expect(getConfirmedAgent(THREAD)).toBe("pm")

    // saveApprovedSpec was called — createOrUpdateFileContents or getContent reached
    expect(mockGetContent).toHaveBeenCalled()
  })

  it("Turn 2: next message after approval routes to UX Designer based on GitHub phase", async () => {
    // State after approval: confirmedAgent = "pm", product spec on main
    setConfirmedAgent(THREAD, "pm")
    appendMessage(THREAD, { role: "user", content: "confirmed" })
    appendMessage(THREAD, { role: "assistant", content: "Product spec approved." })

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
    expect(getConfirmedAgent(THREAD)).toBe("ux-design")

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

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("Turn 1: design approval confirmation shows approval message", async () => {
    setPendingApproval(THREAD, {
      specType: "design",
      specContent: "# Onboarding Design Spec\n\n## Screens\nScreen 1.",
      filePath: "specs/features/onboarding/onboarding.design.md",
      featureName: "onboarding",
    })
    setConfirmedAgent(THREAD, "ux-design")

    const params = makeParams(THREAD, "feature-onboarding", "confirmed")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("design spec is saved and approved")
    expect(text).toContain("architect")
    expect(getConfirmedAgent(THREAD)).toBe("ux-design")
  })

  it("Turn 2: next message after design approval routes to Architect", async () => {
    setConfirmedAgent(THREAD, "ux-design")
    appendMessage(THREAD, { role: "user", content: "confirmed" })
    appendMessage(THREAD, { role: "assistant", content: "Design spec approved." })

    // GitHub: product + design specs on main → design-approved-awaiting-engineering
    mockDesignApprovedState()

    // Architect agent calls: isOffTopicForAgent, isSpecStateQuery, runAgent
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                    // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Let's plan the data model." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "let's plan the engineering")
    await handleFeatureChannelMessage(params)

    expect(getConfirmedAgent(THREAD)).toBe("architect")
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

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("new thread in design-in-progress feature routes straight to UX Designer", async () => {
    // No confirmedAgent — fresh thread
    mockDesignInProgressState()

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here are the flows." }] }) // runAgent

    const params = makeParams(THREAD, "feature-onboarding", "what are we designing?")
    await handleFeatureChannelMessage(params)

    expect(getConfirmedAgent(THREAD)).toBe("ux-design")
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

    expect(getConfirmedAgent(THREAD)).toBe("architect")
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

    expect(getConfirmedAgent(THREAD)).toBe("pm")
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

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("Turn 1: design agent response with escalation offer stores pending escalation", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: [
        "This is a product decision — want me to pull the PM in?",
        "",
        "OFFER_PM_ESCALATION_START",
        "Should social login be supported?",
        "OFFER_PM_ESCALATION_END",
      ].join("\n") }] })  // runAgent with escalation offer

    const params = makeParams(THREAD, "feature-onboarding", "should we support social login?")
    await handleFeatureChannelMessage(params)

    // User-visible response strips the marker but keeps the offer text
    const text = lastUpdateText(params.client)
    expect(text).toContain("want me to pull the PM in")
    expect(text).not.toContain("OFFER_PM_ESCALATION_START")
  })

  it("Turn 2: user says yes → PM is @mentioned in thread, design paused", async () => {
    setConfirmedAgent(THREAD, "ux-design")
    appendMessage(THREAD, { role: "user", content: "should we support social login?" })
    appendMessage(THREAD, { role: "assistant", content: "This is a product decision — want me to pull the PM in?" })

    // Set up the pending escalation as if Turn 1 already ran
    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation(THREAD, {
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
// Two features in flight simultaneously. Messages in each thread route to the
// agent confirmed for THAT thread. State does not leak between threads.

describe("Scenario 5 — Thread isolation across concurrent features", () => {
  const THREAD_A = "workflow-s5-onboarding"
  const THREAD_B = "workflow-s5-dashboard"

  beforeEach(() => {
    clearHistory(THREAD_A)
    clearHistory(THREAD_B)
  })
  afterEach(() => {
    clearHistory(THREAD_A)
    clearHistory(THREAD_B)
  })

  it("PM message in Thread A does not affect UX Designer routing in Thread B", async () => {
    setConfirmedAgent(THREAD_A, "pm")
    setConfirmedAgent(THREAD_B, "ux-design")

    // Thread A: PM agent call
    // confirmedAgent = "pm" → getFeaturePhase check → still product-in-progress → run PM
    mockPaginate.mockResolvedValueOnce([]) // no branches → product-spec-in-progress for Thread A

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // classifyMessageScope (PM)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PM response." }] })       // PM runAgent

    const paramsA = makeParams(THREAD_A, "feature-onboarding", "refine the spec")
    await handleFeatureChannelMessage(paramsA)

    expect(thinkingPlaceholder(paramsA.client)).toBe("_Product Manager is thinking..._")
    expect(getConfirmedAgent(THREAD_A)).toBe("pm")

    // Thread B: design agent — confirmedAgent should still be ux-design (not contaminated by A)
    expect(getConfirmedAgent(THREAD_B)).toBe("ux-design")

    vi.clearAllMocks()

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Design response." }] }) // design runAgent

    const paramsB = makeParams(THREAD_B, "feature-dashboard", "update the flows")
    await handleFeatureChannelMessage(paramsB)

    expect(thinkingPlaceholder(paramsB.client)).toBe("_UX Designer is thinking..._")
    expect(getConfirmedAgent(THREAD_B)).toBe("ux-design")
    expect(getConfirmedAgent(THREAD_A)).toBe("pm") // Thread A unaffected
  })
})

// ─── Scenario 6: confirmedAgent persists across turns within same thread ──────
//
// Once an agent is confirmed for a thread, subsequent messages in that thread
// skip classifyIntent and go directly to the confirmed agent.

describe("Scenario 6 — confirmedAgent sticky routing", () => {
  const THREAD = "workflow-s6"

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("second message in PM thread skips classifyIntent and goes straight to PM", async () => {
    setConfirmedAgent(THREAD, "pm")
    appendMessage(THREAD, { role: "user", content: "first message" })
    appendMessage(THREAD, { role: "assistant", content: "PM response." })

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
    setConfirmedAgent(THREAD, "ux-design")
    appendMessage(THREAD, { role: "user", content: "first design message" })
    appendMessage(THREAD, { role: "assistant", content: "Design response." })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })             // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })             // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Still designing." }] })  // design runAgent

    const params = makeParams(THREAD, "feature-onboarding", "another design question")
    await handleFeatureChannelMessage(params)

    // 3 calls: isOffTopicForAgent, isSpecStateQuery, runAgent — no classifyIntent
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)
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

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("sends at most 21 messages to Anthropic (20 history + current) even when store has 40+", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    // Seed 40 alternating messages in the conversation store
    for (let i = 0; i < 40; i++) {
      appendMessage(THREAD, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })           // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })           // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })                // extractLockedDecisions (Haiku, fires at >6 msgs)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "- Glow timing pending" }] }) // summarizeUnlockedDiscussion (Haiku, fires when history > 20)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Still designing." }] }) // design runAgent

    const params = makeParams(THREAD, "feature-onboarding", "latest message")
    await handleFeatureChannelMessage(params)

    // The 5th Anthropic call is the runAgent call — inspect its messages array
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

  beforeEach(() => { clearHistory(THREAD); clearSummaryCache(THREAD) })
  afterEach(() => { clearHistory(THREAD); clearSummaryCache(THREAD) })

  it("state response shows specific uncommitted decisions when thread has prior history", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    for (let i = 0; i < 10; i++) {
      appendMessage(THREAD, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    // "hi" matches CHECK_IN_RE — both isOffTopicForAgent and isSpecStateQuery are skipped.
    // identifyUncommittedDecisions is the only Anthropic call.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode default: I recommend Archon palette — discussed in thread\n2. Chip positioning: I recommend above prompt bar — agreed in conversation" }] })  // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    const text = lastUpdateText(params.client)
    expect(text).toContain("not yet committed to GitHub")
    expect(text).toContain("Dark mode default")
    expect(text).toContain("Reply with the numbers")

    // uncommittedNote must appear BEFORE the committed state response
    expect(text.indexOf("not yet committed")).toBeLessThan(text.indexOf("No design draft yet") !== -1 ? text.indexOf("No design draft yet") : text.length)
    // More precise: uncommitted section comes before the spec link or "No design draft" section
    const uncommittedIdx = text.indexOf("not yet committed")
    const committedStateIdx = text.indexOf("---\n\n")
    expect(uncommittedIdx).toBeLessThan(committedStateIdx)
  })

  it("state response skips uncommitted section when all decisions are in the spec", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    for (let i = 0; i < 10; i++) {
      appendMessage(THREAD, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    // "hi" matches CHECK_IN_RE — both isOffTopicForAgent and isSpecStateQuery are skipped.
    // identifyUncommittedDecisions is the only Anthropic call.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All discussed decisions appear to be in the committed spec." }] })

    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    expect(lastUpdateText(params.client)).not.toContain("not yet committed to GitHub")
  })

  it("state response has no uncommitted section when thread is short (fresh start)", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    // "hi" matches CHECK_IN_RE — both isOffTopicForAgent and isSpecStateQuery are skipped.
    // Thread history is empty (length <= 6), so identifyUncommittedDecisions is also skipped.
    // No Anthropic calls at all.
    const params = makeParams(THREAD, "feature-onboarding", "hi")
    await handleFeatureChannelMessage(params)

    expect(lastUpdateText(params.client)).not.toContain("not yet committed to GitHub")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(0)
  })
})

// ─── Scenario 9: Design patch flow ───────────────────────────────────────────
//
// When the design agent emits a DESIGN_PATCH_START block instead of a full
// DRAFT_DESIGN_SPEC_START block, the handler should:
//   1. Read the existing draft from GitHub (falls back to "" if none)
//   2. Merge the patch into the existing draft via applySpecPatch
//   3. Save the merged draft to GitHub
//   4. Generate an HTML preview
//   5. Respond with a CTA to approve or refine

describe("Scenario 9 — Design patch flow", () => {
  const THREAD = "workflow-s9"

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("patch block is applied to existing draft and merged draft is saved to GitHub", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    const patchResponse = [
      "Updated the accessibility section based on your feedback.",
      "DESIGN_PATCH_START",
      "## Accessibility",
      "WCAG AA required. Focus rings on all interactive elements. Min tap target 44px.",
      "DESIGN_PATCH_END",
    ].join("\n")

    // Anthropic call sequence (short history → no extractLockedDecisions call):
    //   1. isOffTopicForAgent → false
    //   2. isSpecStateQuery   → false
    //   3. runAgent           → patch response
    //   4. generateDesignPreview → HTML (productVision + systemArchitecture are empty → auditSpecDraft skips API call)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: patchResponse }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "<html>preview</html>" }] }) // generateDesignPreview

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

    // Response includes the approval CTA
    const text = lastUpdateText(params.client)
    expect(text).toContain("approved")
  })
})

// ─── Scenario 10: PM patch flow ───────────────────────────────────────────────
//
// When the PM agent emits a PRODUCT_PATCH_START block instead of a full
// DRAFT_SPEC_START block, the handler applies the patch and saves the merged draft.

describe("Scenario 10 — PM patch flow", () => {
  const THREAD = "workflow-s10"

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("PRODUCT_PATCH block is merged into existing draft and saved to GitHub", async () => {
    setConfirmedAgent(THREAD, "pm")

    const patchResponse = [
      "Updated the Goals section based on your feedback.",
      "PRODUCT_PATCH_START",
      "## Goals",
      "1. Reduce onboarding time from 10 min to 3 min.",
      "2. Achieve 80% day-1 activation.",
      "PRODUCT_PATCH_END",
    ].join("\n")

    // PM Anthropic call sequence: classifyMessageScope → runAgent
    // (no extractLockedDecisions — short history; no audit API call — empty productVision/architecture)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: patchResponse }] })       // runAgent

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
// When the architect agent emits an ENGINEERING_PATCH_START block, the handler
// applies the patch and saves the merged draft.

describe("Scenario 11 — Architect patch flow", () => {
  const THREAD = "workflow-s11"

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("ENGINEERING_PATCH block is merged into existing draft and saved to GitHub", async () => {
    setConfirmedAgent(THREAD, "architect")

    const patchResponse = [
      "Updated the API Design section based on the agreed pagination strategy.",
      "ENGINEERING_PATCH_START",
      "## API Design",
      "GET /api/v1/onboarding — cursor-based pagination, max 50 items.",
      "ENGINEERING_PATCH_END",
    ].join("\n")

    // Architect Anthropic call sequence: isOffTopicForAgent → isSpecStateQuery → runAgent
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: patchResponse }] }) // runAgent

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

// ─── Scenario 12: Auto-retry on truncated DRAFT — design agent ────────────────
//
// When the design agent emits a truncated DRAFT block (start marker but no end marker)
// and a draft already exists, the handler auto-retries with a forced PATCH instruction.
// The user never sees an error — they just see the spec update.

describe("Scenario 12 — Auto-retry on truncated DRAFT (design agent)", () => {
  const THREAD = "workflow-s12"

  beforeEach(() => { clearHistory(THREAD) })
  afterEach(() => { clearHistory(THREAD) })

  it("retries with forced PATCH when DRAFT block is truncated and existing draft exists", async () => {
    setConfirmedAgent(THREAD, "ux-design")

    // Use a path-aware mock so any getContent call for the design spec path returns
    // the existing draft — regardless of which call number it is in the sequence.
    // Context-loading calls (productVision, systemArchitecture, etc.) all hit the default
    // rejected value; only calls for the onboarding.design.md path resolve successfully.
    const existingDraftContent = "# Onboarding — Design Spec\n\n## Design Direction\nLight mode.\n\n## Screens\nScreen 1."
    mockGetContent.mockImplementation((params: any) => {
      if (params?.path?.includes("onboarding.design.md")) {
        return Promise.resolve({ data: { content: Buffer.from(existingDraftContent).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    const truncatedResponse = "Updating the spec with all changes.\nDRAFT_DESIGN_SPEC_START\n# Onboarding — Design Spec\n\n## Design Direction\nDark mode."
    // No DRAFT_DESIGN_SPEC_END — simulates truncation

    const patchRetryResponse = [
      "Applied all changes as section patches.",
      "DESIGN_PATCH_START",
      "## Design Direction",
      "Dark mode. Archon Labs aesthetic.",
      "DESIGN_PATCH_END",
    ].join("\n")

    // Anthropic call sequence:
    //   1. isOffTopicForAgent → false
    //   2. isSpecStateQuery   → false
    //   3. runAgent (main)    → truncated DRAFT (no DRAFT_DESIGN_SPEC_END)
    //   4. runAgent (retry)   → PATCH block (auto-retry transparently)
    //   5. generateDesignPreview → HTML
    //   (auditSpecDraft skipped — empty productVision/systemArchitecture)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: truncatedResponse }] })  // runAgent (truncated)
      .mockResolvedValueOnce({ content: [{ type: "text", text: patchRetryResponse }] }) // runAgent (retry)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "<html>preview</html>" }] }) // generateDesignPreview

    const params = makeParams(THREAD, "feature-onboarding", "apply all the changes we discussed")
    await handleFeatureChannelMessage(params)

    // Draft was saved (retry succeeded)
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // No error message shown to user — they see the CTA
    const text = lastUpdateText(params.client)
    expect(text).not.toContain("too long")
    expect(text).not.toContain("cut off")
    expect(text).toContain("approved")
  })
})
