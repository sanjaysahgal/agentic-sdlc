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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Still designing." }] }) // design runAgent

    const params = makeParams(THREAD, "feature-onboarding", "latest message")
    await handleFeatureChannelMessage(params)

    // The 4th Anthropic call is the runAgent call — inspect its messages array
    const runAgentCall = mockAnthropicCreate.mock.calls[3][0]
    expect(runAgentCall.messages.length).toBeLessThanOrEqual(21)

    // The most recent history message should be present; the oldest (msg 0) should be gone
    const allContent = runAgentCall.messages.map((m: { content: string }) => m.content).join(" ")
    expect(allContent).not.toContain("msg 0")
    expect(allContent).toContain("latest message")
  })
})
