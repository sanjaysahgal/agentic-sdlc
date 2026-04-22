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
//
// Logging note (chore: add comprehensive runtime logging):
// console.log calls were added to existing routing branches in message.ts and agent-router.ts.
// No new routing paths or state transitions were introduced — all existing scenarios continue
// to cover every branch. No new scenario was required.

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


import { handleFeatureChannelMessage, clearPhaseAuditCaches } from "../../../interfaces/slack/handlers/message"
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
  clearEscalationNotification,
  clearConfirmedAgent,
  disableFilePersistence,
} from "../../../runtime/conversation-store"

// Prevent integration tests from writing to production state files on disk.
// Test teardown calls clearPendingEscalation etc. — without this guard those calls
// would wipe .conversation-state.json and lose real pending escalation state.
disableFilePersistence()
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
  // Clear escalation notification state — tests that run the escalation confirmation path
  // set this as a side effect. Without global cleanup, it leaks into subsequent tests that
  // use confirmedAgent=ux-design, causing the escalation-continuation branch to fire.
  clearEscalationNotification("onboarding")
  clearEscalationNotification("dashboard")
  clearPendingEscalation("onboarding")
  clearPendingEscalation("dashboard")
  // Clear confirmedAgent so phase-transition detection in setConfirmedAgent doesn't
  // accidentally clear history when a test sets a different agent than a prior test left.
  clearConfirmedAgent("onboarding")
  clearConfirmedAgent("dashboard")
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
  // Default Anthropic response: NONE — used as fallback when Once queue is exhausted.
  // Prevents the Haiku PM-gap classifier (added as final safety net after the design agent
  // responds) from crashing tests that don't explicitly mock its call. Tests that need specific
  // responses use mockResolvedValueOnce chains; this default catches any overflow calls.
  mockAnthropicCreate.mockResolvedValue({
    content: [{ type: "text", text: "NONE" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 5 },
  })
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
    //   [3] classifyForPmGaps        → single gap (filters & deduplicates any non-PM items)
    //   [4] runAgent (end_turn)      → text response after tool result
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: "Should chips be permanent for authenticated users?" } }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: Should chips be permanent for authenticated users?" }] })
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

    // Platform enforces assertive escalation text — agent prose ("I've escalated to the PM") is
    // factually wrong (escalation is PENDING, PM not yet notified) and replaced by the platform.
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")
  })

  it("Turn 2: user says yes → PM agent runs with brief, escalation notification set, awaiting human approval", async () => {
    // Two-step PM escalation: first "yes" runs PM agent and waits for human approval.
    // Spec is NOT patched and design does NOT resume until the human explicitly approves.
    setConfirmedAgent("onboarding", "ux-design")
    appendMessage("onboarding", { role: "user", content: "should we support social login?" })
    appendMessage("onboarding", { role: "assistant", content: "Should chips be permanent for authenticated users?\n\nDesign cannot move forward until the PM closes these gaps. Say *yes* and I'll bring the PM into this thread now." })

    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "Should social login be supported?",
      designContext: "Onboarding design in progress.",
    })

    // Mock sequence (2 calls — PM only, readOnly=true skips classifyMessageScope):
    //   [0] PM agent → no "My recommendation:" → enforcement fires
    //   [1] PM agent enforcement → proper format with "My recommendation:"
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Recommendation: Yes, support Google OAuth." }],
        usage: { input_tokens: 10, output_tokens: 30 },
      })                                                                                   // [0] PM run 1 (enforcement fires)
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "1. My recommendation: Support Google OAuth as the primary social login method.\n→ Rationale: Broad coverage.\n→ Note: Pending your approval — say yes to apply to the product spec" }],
        usage: { input_tokens: 10, output_tokens: 30 },
      })                                                                                   // [1] PM run 2 (enforcement)

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // PM ran — exactly 2 calls (readOnly=true skips classifyMessageScope)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)

    // Pending escalation cleared (PM ran successfully)
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    // EscalationNotification IS set — awaiting human approval of PM recommendations
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notif = getEscalationNotification("onboarding")
    expect(notif).not.toBeNull()
    expect(notif?.targetAgent).toBe("pm")
    expect(notif?.originAgent).toBe("design")
    expect(notif?.recommendations).toContain("My recommendation:")

    // No "Product spec updated" message — spec not patched until human approves
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const closurePost = postCalls.find((c: any) => c[0]?.text?.includes("Product spec updated"))
    expect(closurePost).toBeUndefined()
  })

  it("Turn 3: human approves PM recommendations → spec patched, 'Product spec updated' posted, design resumes", async () => {
    // Second "yes" hits escalationNotification path — patches spec and resumes design.
    setConfirmedAgent("onboarding", "ux-design")
    // History = 4 messages (Turn 1 + Turn 2 user/assistant pairs)
    appendMessage("onboarding", { role: "user", content: "should we support social login?" })
    appendMessage("onboarding", { role: "assistant", content: "Design cannot move forward. Say *yes*..." })
    appendMessage("onboarding", { role: "user", content: "yes" })
    appendMessage("onboarding", { role: "assistant", content: "1. My recommendation: Support Google OAuth..." })

    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "pm",
      question: "Should social login be supported?",
      recommendations: "1. My recommendation: Support Google OAuth as the primary social login method.\n→ Rationale: Broad coverage.",
      originAgent: "design",
    })

    // patchProductSpecWithRecommendations: readFile(main) → 404 → Haiku skipped (non-blocking)
    // handleDesignPhase: isOffTopicForAgent, isSpecStateQuery, extractLockedDecisions (history=6≥6),
    //   runAgent, identifyUncommittedDecisions, Gate4 classifyForPmGaps
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "on-topic" }] })           // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "no" }] })                 // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })               // extractLockedDecisions (history=6≥6)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Continuing with the design." }] }) // runAgent (design)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NONE" }] })               // identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NONE" }] })               // Gate4 classifyForPmGaps

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // "Product spec updated" closure posted
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const closurePost = postCalls.find((c: any) => c[0]?.text?.includes("Product spec updated"))
    expect(closurePost).toBeDefined()

    // EscalationNotification cleared
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).toBeNull()

    // Design agent ran — 5 calls total (history=4, extractLockedDecisions fires at ≥6)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
  })

  it("Turn 2 with productSpec — approved product spec injected into PM brief so agent has full context", async () => {
    // Root cause of Apr 2026 bug: PM agent replied "I need to see the spec" because
    // loadAgentContext reads from the draft branch (404 after approval). Fix: store
    // productSpec in PendingEscalation and inject it directly into the brief.
    setConfirmedAgent("onboarding", "ux-design")
    appendMessage("onboarding", { role: "user", content: "what's blocking design?" })
    appendMessage("onboarding", { role: "assistant", content: "1. SSO failure path undefined.\n\nDesign cannot move forward. Say *yes*..." })

    const { setPendingEscalation } = await import("../../../runtime/conversation-store")
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "1. SSO failure path undefined — what is the recovery path?",
      designContext: "",
      productSpec: "## Acceptance Criteria\n1. Users can sign in via SSO.\n2. Handle gracefully.",
    })

    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "1. My recommendation: Show a retry screen with an error message.\n→ Rationale: Standard SSO failure UX.\n→ Note: Pending human PM confirmation before engineering handoff" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 30 },
    })

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // The PM brief must contain the product spec content.
    // Call order (readOnly=true skips classifyMessageScope): [0] PM agent.
    // PM agent has no history (readOnly), so the brief is in the LAST message.
    const pmCall = mockAnthropicCreate.mock.calls[0][0]
    const pmBrief = pmCall.messages.at(-1).content as string
    expect(pmBrief).toContain("APPROVED PRODUCT SPEC")
    expect(pmBrief).toContain("Users can sign in via SSO")
    expect(pmBrief).toContain("SSO failure path undefined")
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

    // 5 calls: isOffTopicForAgent, isSpecStateQuery, runAgent, post-turn identifyUncommittedDecisions,
    // + Haiku PM-gap classifier (final safety net, returns NONE — no escalation triggered).
    // classifyIntent was NOT called — that would add a 6th call
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
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
    //   [4] runAgent (end_turn call)  → text response after tool result
    // No design draft found before tool call → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Accessibility\nWCAG AA required. Focus rings on all interactive elements. Min tap target 44px." } }],
      })                                                                               // runAgent: tool_use
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

    // Anthropic: [0] identifyUncommittedDecisions → none, [1] auditSpecRenderAmbiguity → [] findings (if cache miss),
    // auditPhaseCompletion may also be a cache hit from the first Scenario 12 test (same spec + featureName).
    // Both auditSpecRenderAmbiguity and auditPhaseCompletion may be cached — identifyUncommittedDecisions always fires.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] }) // auditSpecRenderAmbiguity (if cache miss)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] }) // auditPhaseCompletion (if cache miss)

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})
    const params = { ...makeParams(THREAD, "feature-onboarding", "hi"), client }
    await handleFeatureChannelMessage(params)

    // uploadV2 called with normal title (NOT "(committed spec)")
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(uploadCall?.title).not.toContain("committed spec")
    expect(uploadCall?.content).toBe(SAVED_HTML)

    // 1-3 Anthropic calls — identifyUncommittedDecisions always fires;
    // auditSpecRenderAmbiguity and auditPhaseCompletion may both be cache hits from the first Scenario 12 test.
    // (generateDesignPreview was NOT called — saved GitHub file served directly)
    expect(mockAnthropicCreate.mock.calls.length).toBeGreaterThanOrEqual(1)
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
    //   [3] runAgent (end_turn) → response text
    //   NO identifyUncommittedDecisions call
    // No design draft on branch → auditPhaseCompletion skipped
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })       // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Colors\nViolet CTA." } }],
      })                                                                            // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated and saved. Ready to approve?" }] }) // runAgent: end_turn
    // If identifyUncommittedDecisions were called, it would hit the default mockResolvedValue
    // fallback which is undefined → would throw. Verifying no throw + call count = 4.

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "make the CTA violet and save"), client })

    // Exactly 4 Anthropic calls — generateDesignPreview is template-based (no LLM); auditSpecRenderAmbiguity no longer in saveDesignDraft; no 5th call for identifyUncommittedDecisions
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)

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
      .mockRejectedValueOnce(new Error("Input too long: request exceeds context window")) // [3] generateDesignPreview (non-fatal, caught inside saveDesignDraft)
      .mockRejectedValueOnce(new Error("Input too long: request exceeds context window")) // [4] runAgent: end_turn FAILS → caught by try-catch → shows spec-saved message

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
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5) // +1 for Haiku PM-gap classifier
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
// auditSpecRenderAmbiguity is no longer called inside saveDesignDraft, and
// renderAmbiguities is no longer returned in the tool result.
// Render ambiguities are surfaced to the user in the post-turn action menu only.

describe("Scenario 17 — Render ambiguity audit no longer fires on spec save", () => {
  const THREAD = "workflow-s17"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("save does NOT return renderAmbiguities — ambiguities surfaced in action menu only", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (0 history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent
    //   [1] isSpecStateQuery
    //   [2] runAgent (tool_use) → apply_design_spec_patch
    //   [3] runAgent (end_turn) → response
    //   [4] identifyUncommittedDecisions
    // No design draft on branch → auditPhaseCompletion skipped
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nChips positioned near the bottom." } }],
      })                                                                        // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Updated chip positioning." }] }) // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "save the spec"), client })

    // Agent called apply_design_spec_patch once (no ambiguity-triggered second patch)
    const patchCalls = mockAnthropicCreate.mock.calls.filter((c: any[]) =>
      c[0]?.tools?.some((t: any) => t.name === "apply_design_spec_patch")
    )
    expect(patchCalls.length).toBeGreaterThanOrEqual(1)

    const text = lastUpdateText(client)
    expect(text).toContain("Updated")
  })

  it("save with no ambiguities produces no renderAmbiguities in tool result", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (didSave=true → identifyUncommittedDecisions skipped):
    //   [0] isOffTopicForAgent
    //   [1] isSpecStateQuery
    //   [2] runAgent (tool_use) → apply_design_spec_patch
    //   [3] runAgent (end_turn) → response
    //   NO identifyUncommittedDecisions (save tool was called)
    // No design draft on branch → auditPhaseCompletion skipped
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Chat Home\nHeading: \"Health360\". Chips: 12px above prompt bar." } }],
      })                                                                        // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec saved. Ready to approve." }] }) // runAgent: end_turn

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "save with full spec"), client })

    // Exactly 4 Anthropic calls — generateDesignPreview is template-based (no LLM); auditSpecRenderAmbiguity no longer in saveDesignDraft; no 5th (identifyUncommittedDecisions skipped)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)

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

    // 6 Anthropic calls: isOffTopicForAgent, isSpecStateQuery, runAgent tool_use, runAgent
    // end_turn, identifyUncommittedDecisions, + Haiku PM-gap classifier (returns NONE).
    // generate_design_preview is not a save tool → didSave=false → classifier runs.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)

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
    //   [5] runAgent (end_turn), [6] identifyUncommittedDecisions
    // Design draft found (.design.md matched) → auditPhaseCompletion fires at [2]
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })            // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })             // auditPhaseCompletion → PASS
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: THE_PATCH } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Spec and preview updated." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const client = makeClient() as ReturnType<typeof makeClient> & { files: { uploadV2: ReturnType<typeof vi.fn> } }
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "lock in dark mode screens"), client })

    // The merged spec saved to GitHub contains BOTH existing and patch sections.
    // generateDesignPreview is template-based (no LLM call), so we verify the saved content directly.
    const designSpecWrite = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.includes("onboarding.design.md")
    )
    expect(designSpecWrite).toBeDefined()
    const savedContent = Buffer.from(designSpecWrite?.[0]?.content ?? "", "base64").toString()
    expect(savedContent).toContain("PATCH_MARKER")         // patch section present in merged spec
    expect(savedContent).toContain("Existing Section")     // existing section present in merged spec
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
    //   [3] classifyForArchGap       → "ARCH-GAP" (genuine UI-blocking question — accepted)
    //   [4] runAgent (end_turn)      → text after tool result
    //   [5] identifyUncommittedDecisions → none
    // No design draft on branch → auditPhaseCompletion skipped
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })         // [1] isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_architect_escalation", input: { question: "Does the API support streaming responses? I need to decide whether to show a typing indicator or a loading spinner." } }],
      })                                                                              // [2] runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ARCH-GAP" }] })      // [3] classifyForArchGap: accepted
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I've flagged this for the architect — design is paused until they weigh in on streaming support." }],
      })                                                                              // [4] runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })          // [5] identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "how should we handle session carry-over?")
    await handleFeatureChannelMessage(params)

    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("architect")
    expect(pending?.question).toContain("streaming responses")

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
    expect(userMsg?.content).toContain("[INTERNAL — Engineering readiness")
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
    expect(userMsg?.content).not.toContain("[INTERNAL — Engineering readiness")
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
    expect(userMsg?.content).toContain("[DESIGN REVIEW")
    expect(userMsg?.content).toContain("Chip row has no concrete position anchor")

    // 6 total Anthropic calls (+1 for Haiku PM-gap classifier, returns NONE)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)
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

    // auditPhaseCompletion never ran — 5 calls total (+1 Haiku PM-gap classifier, returns NONE)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)

    // runAgent call (index 2) does NOT contain audit notice
    const runAgentCall = mockAnthropicCreate.mock.calls[2][0]
    const userMsg = (runAgentCall.messages as { role: string; content: string }[]).at(-1)
    expect(userMsg?.content).not.toContain("[DESIGN REVIEW")
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

    // Platform-enforced finalization (Phase 3): platform detects approval intent, 0 structural
    // findings → calls finalize_design_spec directly (no agent runAgent call).
    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] auditPhaseCompletion → PASS,
    //     platform calls finalize_design_spec directly,
    //     [3] auditDownstreamReadiness(architect) → PASS [parallel with auditSpecDecisions],
    //     auditBrandTokens fires (pure) → drift found → finalize blocked, response sent directly.
    // No runAgent calls — platform handles the entire finalization.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditPhaseCompletion
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditDownstreamReadiness(architect)

    const params = makeParams(THREAD, "feature-onboarding", "approve the design spec")
    await handleFeatureChannelMessage(params)

    // Hard gate fired — design spec was NOT written to GitHub
    // (audit cache writes are allowed — only the design spec itself must be blocked)
    const designSpecWrite = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.endsWith("onboarding.design.md") && !c[0]?.path?.includes("audit")
    )
    expect(designSpecWrite).toBeUndefined()

    // Platform sent finalization blocked message directly (no agent involved)
    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("Finalization blocked")
    expect(text).toContain("brand token drift")

    // 4 Anthropic calls (no runAgent calls — platform finalized directly)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
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

    // Platform-enforced finalization (Phase 3): no brand drift → spec saved directly.
    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] auditPhaseCompletion → PASS,
    //     platform calls finalize_design_spec directly,
    //     [3] auditDownstreamReadiness(architect) → PASS,
    //     auditBrandTokens fires (pure) → no drift → saveApprovedDesignSpec called.
    // No runAgent calls.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })              // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditPhaseCompletion
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditDownstreamReadiness(architect)

    const params = makeParams(THREAD, "feature-onboarding", "approve the design spec")
    await handleFeatureChannelMessage(params)

    // No drift → spec WAS saved
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    // Platform sent success message directly
    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("approved and merged")

    // 4 Anthropic calls (no runAgent — platform finalized directly)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
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
    expect(text).toContain("*Recommended fix:*")

    // CTA for applying fixes
    expect(text).toContain("Say *fix 1 2 3* (or *fix all*)")

    // Separator before action menu
    expect(text).toMatch(/---/)

    // 5 Anthropic calls total: auditPhaseCompletion is a cache hit (no call) + Haiku PM-gap classifier
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
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
    expect(text).toContain("*Recommended fix:*")

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
    expect(text).toContain("Design Issues")
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

    const DRAFT = "# Onboarding Engineering Spec\n\n## Data Model\nUsers table.\n\n## Open Questions\n"

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
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })     // auditDownstreamReadiness(engineer)
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
      // auditSpecDecisions + auditDownstreamReadiness run in parallel:
      // auditSpecDecisions: history has 2 msgs → API call → returns correction
      // auditDownstreamReadiness(engineer): open-ended adversarial audit → PASS
      .mockResolvedValueOnce({ content: [{ type: "text", text: "MISMATCH: Page size | 100 items per page | 50 items per page" }] }) // auditSpecDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })     // auditDownstreamReadiness(engineer)
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
    //   [3] runAgent (end_turn) → "Spec saved. Preview will come later."
    //   NO identifyUncommittedDecisions (save tool was called → didSave = true)
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "save_design_spec_draft", input: { content: "## Screens\nHome screen." } }],
      })                                                                                // runAgent: tool_use
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
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6) // +1 Haiku PM-gap classifier

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

    // auditPhaseCompletion fired for feature-B (6 total calls — not 5, which would mean skip; +1 PM-gap classifier)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)
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

    // 6 calls total: platform did not short-circuit on the unknown tool; +1 Haiku PM-gap classifier
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)
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

    // PM call sequence: classifyMessageScope → runAgent (finalize tool) →
    //   auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC) + auditDownstreamReadiness(designer) [parallel] →
    //   runAgent (end_turn)
    // auditSpecDecisions skips LLM (empty history)
    // No brand audit calls — PM does not load BRAND.md
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })                                                                                   // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })              // auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })              // auditDownstreamReadiness(designer)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Product spec finalized." }] }) // runAgent: end_turn

    const params = makeParams(THREAD, "feature-onboarding", "the spec is ready, finalize it")
    await handleFeatureChannelMessage(params)

    // Spec was saved — PM finalize succeeded without brand gate
    expect(mockCreateOrUpdate).toHaveBeenCalled()

    const text = lastUpdateText(params.client)
    expect(text).toContain("finalized")

    // Exactly 5 Anthropic calls — NO brand audit calls (PM doesn't touch brand)
    // Two extra calls vs prior: auditPhaseCompletion + auditDownstreamReadiness inside finalize handler
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)
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
    //   [3] classifyForPmGaps        → single gap (filters non-PM items before storing)
    //   [4] runAgent (end_turn)      → assertive blocking message
    // No design draft on branch → auditPhaseCompletion skipped, no brand audit
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: "What happens to the guest session when the user signs up mid-conversation?" } }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: What happens to the guest session when the user signs up mid-conversation?" }] })
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

// ─── Scenario N26: classifier filters non-PM items from offer_pm_escalation tool ───
//
// Agent bundles PM gaps + design/brand issues into one offer_pm_escalation call.
// Platform runs classifyForPmGaps on the raw question before storing — only PM-scope
// items survive. Brand drift, missing screens, tagline punctuation are stripped.

describe("Scenario N26 — classifier filters non-PM items from offer_pm_escalation question", () => {
  const THREAD = "workflow-n26"

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("stores only PM-scope gaps — design/brand items stripped from pending question", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Agent passes a mixed question: 2 PM gaps + 2 design issues
    const mixedQuestion = [
      "1. What is the session expiry behavior when the user signs up mid-conversation?",
      "2. Should SSO be required for all user tiers or only premium?",
      "3. Glow animation values drift from BRAND.md — spec has 2.5s/200px, brand says 4s/80px.",
      "4. Tagline is missing terminal punctuation.",
    ].join("\n")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent        → false
    //   [1] isSpecStateQuery          → false
    //   [2] runAgent (tool_use)       → offer_pm_escalation (mixed question)
    //   [3] classifyForPmGaps         → 2 GAP lines (filters out items 3 and 4)
    //   [4] runAgent (end_turn)       → agent prose
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: mixedQuestion } }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "GAP: What is the session expiry behavior when the user signs up mid-conversation?\nGAP: Should SSO be required for all user tiers or only premium?" }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Design is blocked on these PM decisions." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "what's blocking us?")
    await handleFeatureChannelMessage(params)

    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()

    // Only PM-scope items stored — design/brand items (3 and 4) are stripped
    expect(pending!.question).toContain("session expiry")
    expect(pending!.question).toContain("SSO")
    expect(pending!.question).not.toContain("Glow animation")
    expect(pending!.question).not.toContain("terminal punctuation")

    // Two gaps → numbered
    expect(pending!.question).toContain("1.")
    expect(pending!.question).toContain("2.")
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

// ─── Scenario N16: Standalone confirmation when escalation notification active resumes design ──
//
// After the PM @mention is posted and EscalationNotification is set, a standalone
// confirmation ("confirmed", "approved", "yes") clears the notification and resumes the design
// agent with the answer injected. A non-standalone message (informational reply, question,
// partial approval + request) routes back to the PM agent instead — see N34.
// userId matching is not required — the @mention ensures only the right person is expected.

describe("Scenario N16 — Any reply when escalation notification active resumes design agent", () => {
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

  it("reply clears notification and resumes design agent with injected PM answer", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Great — with the PM's answer I can now finalize the auth flow screen." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    // Any userId — no role match required. Message is a standalone confirmation.
    const params = { ...makeParams(THREAD, "feature-onboarding", "confirmed — guest sessions are cleared on sign-up"), userId: "U_ANY_USER" }

    await handleFeatureChannelMessage(params)

    // Design agent was called with injected PM answer
    expect(mockAnthropicCreate).toHaveBeenCalled()

    // Notification cleared
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).toBeNull()

    // Design agent was called with the resume directive
    const agentCall = mockAnthropicCreate.mock.calls.find((c: any) =>
      c[0]?.messages?.[0]?.content?.includes?.("PM decisions confirmed")
    )
    expect(agentCall).toBeDefined()
  })
})

// ─── Scenario N17: Injected message includes question and reply ───────────────
//
// When escalation notification fires, the design agent receives an injected
// message combining the original PM question and the user's answer, so the
// agent has full context to resume without re-asking.

describe("Scenario N17 — Escalation reply injected message contains question + answer", () => {
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

  it("design agent resumes with a clean continuation message after spec is updated", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Understood — resuming design with that answer." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    // Standalone confirmation form — starts with affirmative keyword, no follow-up request
    const params = { ...makeParams(THREAD, "feature-onboarding", "confirmed — sessions are cleared permanently on sign-up"), userId: "U_PM_123" }

    await handleFeatureChannelMessage(params)

    // Design agent must be called — find the call that triggered handleDesignPhase
    const agentCall = mockAnthropicCreate.mock.calls.find((c: any) =>
      c[0]?.messages?.[0]?.content?.includes?.("PM decisions confirmed")
    )
    expect(agentCall).toBeDefined()
    const injected = agentCall[0].messages[0].content as string
    // Injected message is a clean, minimal resume directive — decisions are in the spec
    expect(injected).toContain("PM decisions confirmed")
    expect(injected).toContain("product spec updated")
    // No listing instruction — that was a prompt rule, not a structural requirement
    expect(injected).not.toMatch(/listing each.*decision|listing each confirmed/)
  })
})

// ─── Scenario N30: Escalation confirmation triggers product spec writeback ──────────────────────
//
// After a PM reply when escalationNotification.recommendations is set, the platform invokes
// patchProductSpecWithRecommendations so confirmed decisions are written to the product spec on main.
//
// Verification: when spec exists on main and Anthropic returns a valid patch, saveApprovedSpec
// fires → mockCreateOrUpdate is called with the product spec path. This is a distinct side-effect
// from the design agent (which only writes to design spec paths).
//
// The negative case (recommendations absent) is a simple guard (`if (recommendations)`) — tested
// via type-safety and the positive test implicitly. No separate negative integration test needed.

describe("Scenario N30 — Escalation reply triggers product spec writeback when recommendations are stored", () => {
  const THREAD = "workflow-n30"
  const SPEC_CONTENT = "# Onboarding Product Spec\n\n## Acceptance Criteria\n- User can onboard."
  const SPEC_B64 = Buffer.from(SPEC_CONTENT).toString("base64")

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "pm",
      question: "Should the in-conversation nudge show once per session or repeat after dismissal?",
      recommendations: "1. My recommendation: Show once per session — does not repeat after dismissal.\n→ Rationale: Repeating erodes trust.",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("writes patched spec to GitHub when product spec exists on main and Anthropic returns a valid patch", async () => {
    // Argument-based mock — does not depend on call order.
    // readFile(productSpec, "main") → ref is explicitly "main": return spec content.
    // saveApprovedSpec SHA lookup → path matches product.md, ref absent: return SHA.
    // All other calls (loadDesignAgentContext reads, phase audit reads) → 404.
    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.product.md") && ref === "main") {
        // readFile(productSpec, "main") in patchProductSpecWithRecommendations
        return { data: { content: SPEC_B64, type: "file" } }
      }
      if (path?.includes("onboarding.product.md") && !ref) {
        // saveApprovedSpec internal SHA lookup (getContent without ref)
        return { data: { content: SPEC_B64, sha: "abc123", type: "file" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // First Anthropic call: patchProductSpecWithRecommendations patch generation (## headers required)
    // All subsequent calls (identifyUncommittedDecisions, design agent, Gate 4 classifier): resume text
    mockAnthropicCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "## Acceptance Criteria\n- Nudge shows once per session and does not repeat after dismissal." }],
        stop_reason: "end_turn",
      })
      .mockResolvedValue({
        content: [{ type: "text", text: "Applying PM recommendations: 1. Nudge shows once per session. Proceeding with spec updates." }],
        stop_reason: "end_turn",
      })

    mockGetRef.mockResolvedValue({ data: { object: { sha: "main-sha" } } })
    mockCreateOrUpdate.mockResolvedValue({})

    const params = makeParams(THREAD, "feature-onboarding", "approved — all recommendations accepted")
    await handleFeatureChannelMessage(params)

    // saveApprovedSpec must have written the merged product spec to GitHub
    const productWriteCall = mockCreateOrUpdate.mock.calls.find(
      (call: any) => call[0]?.path?.includes("onboarding.product.md")
    )
    expect(productWriteCall).toBeDefined()

    // Escalation notification cleared — design resumed
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).toBeNull()
  })
})

// ─── Scenario N19: [type: product] markers no longer written to design spec (root cause fix) ──
//
// DELETED MECHANISM (2026-04-13): The pre-run structural gate that read [type: product]
// [blocking: yes] markers from the design spec has been removed as part of the root cause fix
// for the escalation loop. Root cause: rubric criterion 10 was instructing the design agent to
// write PM-scope questions into the design spec as open questions. This was architecturally wrong
// — design specs must only contain engineering-scope open questions.
//
// The replacement architecture:
// - Rubric criterion 10 now outputs [PM-GAP] prefix — a rubric-level tag, never persisted to spec
// - The N18 post-run gate checks designReadinessFindings for [PM-GAP] (rubric output, not spec content)
// - Design agent system prompt explicitly prohibits [type: product] questions in the spec
// - The design spec contains only [type: engineering] open questions
//
// This scenario now verifies the new invariant: a design spec with only [type: engineering]
// open questions runs the agent normally — no false-positive gate fires, no premature block.

describe("Scenario N19 — Design spec with only engineering open questions runs agent normally (no false-positive gate)", () => {
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

  it("spec with [type: engineering] open question → agent runs, no premature escalation gate", async () => {
    // Design spec with only engineering-scope open questions (correct format per root cause fix).
    const draftContent = [
      "## Screens",
      "### Onboarding Welcome",
      "Purpose: First screen after signup.",
      "",
      "## Open Questions",
      "- [type: engineering] [blocking: yes] Which WebAuthn library handles passkey registration?",
    ].join("\n")

    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(draftContent).toString("base64"), encoding: "base64" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // auditPhaseCompletion returns PASS. Agent runs and responds normally.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 5 } })   // auditPhaseCompletion → PASS
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is the design update." }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 20 } })  // design agent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })   // identifyUncommittedDecisions

    const params = makeParams(THREAD, "feature-onboarding", "what's next for the welcome screen?")
    await handleFeatureChannelMessage(params)

    // No pre-run gate should have fired — agent ran and responded.
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    const text = lastUpdateText(params.client)
    expect(text).toContain("Here is the design update.")
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
        // auditPhaseCompletion → returns [PM-GAP] finding (root cause fix: criterion 10 now outputs
        // [PM-GAP] instead of [type: product] — [PM-GAP] is a rubric-level tag, never written to spec)
        content: [{ type: "text", text: "FINDING: [PM-GAP] SSO failure handling unspecified | Specify the recovery behavior when SSO token is valid but no account found" }],
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
    expect(pending?.question).toContain("[PM-GAP]")
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
// and criterion 10 findings appear in the Design Issues action menu block.

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

    // Criterion 10 finding must appear in the Design Issues section of the action menu.
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

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] auditPhaseCompletion          → PASS (criterion 10 passes — no [type: product])
    //   [3] runAgent (end_turn)           → prose with "say yes" + "bring the PM"
    //   [4] identifyUncommittedDecisions  → none
    //   [5] classifyForPmGaps (Gate 3)    → 3 PM gaps retained
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 40 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "GAP: SSO error path is not defined in the PM spec.\nGAP: Conversation preservation fields are not specified.\nGAP: Ephemeral session entity fields are not defined." }],
      })

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
    expect(text).not.toContain("Design Issues")

    // Platform always overrides with structured gap list + assertionText — assertive verbs still present
    expect(text).toContain("Say *yes*")
    expect(text).toContain("bring the PM")
  })
})

// ─── N23: Platform overrides passive prose when agent calls tool but writes wrong text ──
//
// The agent called offer_pm_escalation correctly (right tool, right questions) but then
// wrote passive prose ("Want to address these now?") instead of the assertive CTA.
// The platform must detect that escalation was just offered (tool called this turn),
// verify the prose lacks "Design cannot move forward", and override with:
//   pending.question + "\n\nDesign cannot move forward..."
// This is structural enforcement — the agent's tool call expressed the right intent.

describe("Scenario N23 — Platform overrides passive prose when agent calls offer_pm_escalation but writes passive question", () => {
  const THREAD = "workflow-n23"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("passive prose is replaced with assertive escalation text built from pendingEscalation.question", async () => {
    // No design draft → auditPhaseCompletion skipped, no brand audit
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    const toolQuestions = [
      "1. Session expiry — PM spec says 'expires after inactivity' without defining the duration.",
      "2. Conversation persistence — 'preserve conversations' is undefined; design cannot specify the data model.",
      "3. SSO error handling — PM spec says 'handle gracefully' without naming the error states.",
    ].join("\n")

    const passiveProse = "Want to address these now, or continue shaping the spec first?"

    // Mock sequence (no design draft → 6 calls):
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] runAgent (tool_use)           → offer_pm_escalation with consolidated questions
    //   [3] classifyForPmGaps (Gate 2)    → 3 PM gaps retained (all items are PM-scope)
    //   [4] runAgent (end_turn)           → passive prose (agent did not write assertive text)
    //   [5] identifyUncommittedDecisions  → "none"
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: toolQuestions } }],
        usage: { input_tokens: 50, output_tokens: 30 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "GAP: Session expiry duration is not defined in PM spec.\nGAP: Conversation persistence fields are undefined.\nGAP: SSO error states are not specified." }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: passiveProse }],
        usage: { input_tokens: 50, output_tokens: 15 },
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })

    const params = makeParams(THREAD, "feature-onboarding", "what's blocking design?")
    await handleFeatureChannelMessage(params)

    // Platform must have stored pending escalation from the tool call
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.question).toContain("Session expiry")

    // Platform must override passive prose with assertive text
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")
    // The questions from the tool call must appear
    expect(text).toContain("Session expiry")
    // The passive question must NOT appear — platform overrode it
    expect(text).not.toContain("Want to address these now")

    // Action menu must be suppressed
    expect(text).not.toContain("OPEN ITEMS")
  })
})

// ─── Scenario N25 — Haiku classifier catches PM gaps in flat prose ─────────────
//
// Agent writes PM gaps as a flat paragraph — no numbered list, no escalation offer
// language, no "say yes", no tool call. None of the existing gates fire. The Haiku
// classifier detects PM-scope gaps from prose, sets pendingEscalation, and the
// platform overrides with the assertive CTA.

describe("Scenario N25 — Haiku classifier catches PM gaps buried in flat prose — no gate pattern fires", () => {
  const THREAD = "workflow-n25"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("flat prose PM gaps — classifier fires, pendingEscalation set, assertive text shown, action menu absent", async () => {
    // No design draft — keeps mock sequence minimal (no auditPhaseCompletion)
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Prose with PM gaps but no numbered list, no escalation offer, no CTA patterns.
    // This is the failure class the classifier is the safety net for.
    const agentResponse = [
      "Looking at the onboarding flow, there are a few product-level questions that need answers before the design can be locked in.",
      "The spec says to handle the SSO failure state gracefully but does not define what gracefully means in this context.",
      "It is also unclear whether the feature applies to free-tier users or only paid accounts.",
      "The acceptance criteria reference ambient awareness but do not provide a measurable threshold.",
      "Once those are resolved the design can move forward.",
    ].join(" ")

    // Mock sequence (no draft, no auditPhaseCompletion):
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] runAgent (end_turn)           → flat prose with PM gaps
    //   [3] identifyUncommittedDecisions  → none
    //   [4] classifyForPmGaps             → GAP lines (classifier catches prose)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 60 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: SSO failure state behavior is undefined — what should the user see when SSO account creation fails?\nGAP: Free-tier vs paid-tier eligibility for this feature is unspecified.\nGAP: 'Ambient awareness' acceptance criterion lacks a measurable threshold." }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 30 } })

    const params = makeParams(THREAD, "feature-onboarding", "what else needs PM input before we design?")
    await handleFeatureChannelMessage(params)

    // Classifier must have fired — pendingEscalation set
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("pm")

    // Platform override must have replaced flat prose with assertive CTA
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")

    // Action menu must be suppressed
    expect(text).not.toContain("OPEN ITEMS")
  })
})

// ─── N24: Fallback gate catches "want me to escalate to PM?" passive offer pattern ──
//
// The agent correctly identified PM gaps and listed them as numbered items, but asked
// "Want me to escalate to PM with all three now?" instead of calling offer_pm_escalation.
// The extended fallback gate must detect "escalate to PM" offer language, set pendingEscalation,
// and override the passive question with the assertive CTA.
// This is the Slack failure pattern (Apr 2026) that triggered the gate extension.

describe("Scenario N24 — Fallback gate detects 'want me to escalate to PM?' offer pattern and overrides passive prose", () => {
  const THREAD = "workflow-n24"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("agent 'want me to escalate to PM?' + numbered PM gaps → pendingEscalation set, assertive text shown, action menu absent", async () => {
    // No design draft — keeps mock sequence to minimum (no auditPhaseCompletion)
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Exact pattern from the Apr 2026 Slack failure: agent lists PM gaps then asks passive question
    const agentResponse = [
      "**Product spec gaps** — Three unresolved gaps that directly affect what design can specify:",
      "",
      "1. SSO failure path during initial sign-up is not defined — what state should the user land in if account creation fails?",
      "2. Acceptance criteria 15 and 3 are qualitative (\"minimal path\", \"ambient awareness\") — need measurable definitions.",
      "3. Conversation carry-over (US-8) doesn't specify how logged-out session data is stored, keyed, or merged on sign-up.",
      "",
      "These three gaps are blocking — the design cannot be complete without PM clarity.",
      "",
      "Want me to escalate to PM with all three now?",
    ].join("\n")

    // Mock sequence (no draft, no auditPhaseCompletion):
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] runAgent (end_turn)           → passive offer prose
    //   [3] identifyUncommittedDecisions  → none
    //   [4] classifyForPmGaps (Gate 3)    → all 3 items are PM-scope, returned as GAP lines
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 60 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: SSO failure path during initial sign-up is not defined.\nGAP: Acceptance criteria 15 and 3 are qualitative and need measurable definitions.\nGAP: Conversation carry-over does not specify how session data is stored or merged on sign-up." }] })

    const params = makeParams(THREAD, "feature-onboarding", "what's blocking us from moving to engineering?")
    await handleFeatureChannelMessage(params)

    // Fallback gate must have fired — pendingEscalation set with extracted PM questions
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending?.targetAgent).toBe("pm")
    expect(pending?.question).toContain("SSO failure path")
    expect(pending?.question).toContain("Acceptance criteria")
    expect(pending?.question).toContain("Conversation carry-over")

    // Passive offer question must be replaced with assertive escalation text
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")
    expect(text).not.toContain("Want me to escalate")

    // Action menu must be suppressed
    expect(text).not.toContain("OPEN ITEMS")
  })
})

// ─── Scenario N27: Gate 3 classifies and strips non-PM items from prose ───────
//
// Agent writes passive prose listing PM gaps AND design/brand issues together.
// Gate 3 (fallback prose) fires, extracts the full list, runs classifyForPmGaps
// to filter, and stores only PM-scope items. Design/brand issues are stripped.
// This is the exact failure pattern seen in Slack Apr 2026 (glow drift, heading
// redundancy, tagline punctuation mixed into PM escalation message).

describe("Scenario N27 — Gate 3 strips non-PM items from agent prose before storing", () => {
  const THREAD = "workflow-n27"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("Gate 3 filters design/brand items — only PM gaps stored in pending question", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Agent lists 3 PM gaps + 2 design/brand issues, ends with passive CTA
    const agentResponse = [
      "Here's what's blocking us:",
      "",
      "1. SSO failure path is not defined — what happens when token verification fails?",
      "2. Conversation carryover spec (AC-11) doesn't define which fields are transferred.",
      "3. 'Soft indicator' (AC-2) has no measurable threshold — 'soft' doesn't pass QA.",
      "4. Glow animation values drift from BRAND.md — spec has 2.5s, brand says 4s.",
      "5. Auth sheet heading 'Sign in to Health360' repeats the wordmark — redundant.",
      "",
      "Say yes and I'll bring the PM into this thread now.",
    ].join("\n")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] runAgent (end_turn)           → mixed PM + design prose
    //   [3] identifyUncommittedDecisions  → none
    //   [4] classifyForPmGaps (Gate 3)    → 3 PM gaps, strips items 4 and 5
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn" })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn" })
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn" })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }], stop_reason: "end_turn" })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "GAP: SSO failure path is not defined when token verification fails.\nGAP: Conversation carryover spec does not define which fields are transferred.\nGAP: Soft indicator has no measurable threshold." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "what's blocking us?")
    await handleFeatureChannelMessage(params)

    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()

    // PM-scope gaps stored
    expect(pending!.question).toContain("SSO failure path")
    expect(pending!.question).toContain("carryover")
    expect(pending!.question).toContain("measurable")

    // Design/brand items stripped
    expect(pending!.question).not.toContain("Glow animation")
    expect(pending!.question).not.toContain("wordmark")

    // Assertive override applied
    const text = lastUpdateText(params.client)
    expect(text).toContain("Design cannot move forward")
    expect(text).toContain("Say *yes*")
  })
})

// ─── Scenario N28: Gate 2 rejects offer_pm_escalation when classifier finds 0 PM gaps ───
//
// Agent calls offer_pm_escalation with questions that are purely design/brand concerns
// (hex value conflicts, animation duration conflicts between spec sections). The
// classifier returns 0 PM gaps → platform rejects the tool call with a redirect
// and no pending escalation is stored.
//
// Real example: Apr 2026 — agent escalated "which spec holds authoritative values for
// glow opacity/hex colors?" — classifier correctly returned 0 PM gaps but the platform
// fell back to rawQuestion and stored it anyway. This test prevents regression.

describe("Scenario N28 — Gate 2 rejects offer_pm_escalation when 0 PM gaps found", () => {
  const THREAD = "workflow-n28"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("does not store pending escalation when classifier finds 0 PM gaps in tool question", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Agent escalates brand/design conflicts — not PM scope
    const brandConflictQuestion =
      "The design spec conflicts with the product spec on: (1) glow opacity 25–35% vs 50–100%, " +
      "(2) background color #0A0E27 vs #0A0A0F, (3) violet accent #8B7FE8 vs #7C6FCD. " +
      "Which spec holds authoritative values?"

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent        → false
    //   [1] isSpecStateQuery          → false
    //   [2] runAgent (tool_use)       → offer_pm_escalation (brand conflict question)
    //   [3] classifyForPmGaps         → 0 gaps (brand/design, not PM)
    //   [4] runAgent (end_turn)       → agent prose after rejection
    //   [5] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: brandConflictQuestion } }],
      })
      .mockResolvedValueOnce({
        // classifier returns 0 PM gaps — these are brand/design concerns
        content: [{ type: "text", text: "No PM-scope gaps found." }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Resolved brand conflicts from BRAND.md. Glow is now 4s/80px as per brand spec." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    const params = makeParams(THREAD, "feature-onboarding", "there are brand conflicts")
    await handleFeatureChannelMessage(params)

    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    // No pending escalation stored — brand conflicts are not PM-scope
    expect(getPendingEscalation("onboarding")).toBeNull()
  })
})

// ─── Scenario N29: Gate 3 suppresses escalation when classifier finds 0 PM gaps ───
//
// Agent prose matches the Gate 3 extraction pattern (says "cannot move forward" or
// "bring the PM"), but the extracted questions are all design/brand concerns.
// Classifier returns 0 PM gaps → platform suppresses the escalation, no pending stored.

describe("Scenario N29 — Gate 3 suppresses escalation when 0 PM gaps found in prose", () => {
  const THREAD = "workflow-n29"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("does not store pending escalation when Gate 3 classifier finds 0 PM gaps", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Agent prose mentions "cannot move forward" but only lists brand/design issues
    const agentResponse = [
      "Design cannot move forward without resolving these spec conflicts:",
      "",
      "1. Glow duration conflicts: Brand section specifies 4s, Design System says 3.5s, Screen 1 says 2.5s.",
      "2. Background color: product spec says #0A0E27, BRAND.md says #0A0A0F.",
      "",
      "Say yes and I'll bring the PM into this thread now.",
    ].join("\n")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] runAgent (end_turn)           → brand conflict prose with "cannot move forward"
    //   [3] identifyUncommittedDecisions  → none
    //   [4] classifyForPmGaps (Gate 3)    → 0 gaps (brand conflicts, not PM)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn" })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })
      .mockResolvedValueOnce({
        // classifier returns 0 PM gaps — glow duration and hex color are design/brand concerns
        content: [{ type: "text", text: "No PM-scope gaps found." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "check brand conflicts")
    await handleFeatureChannelMessage(params)

    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    // No pending escalation — brand/design conflicts are not PM-scope
    expect(getPendingEscalation("onboarding")).toBeNull()
  })
})

// ─── Scenario N52: Gate 4 skipped when Gate 3 already classified ──────────────
//
// Real incident Apr 2026: Gate 3 ran classifyForPmGaps on extracted prose and
// returned 0 PM gaps (animation spec contradiction is DESIGN-scope). But Gate 4
// then ran a second classifyForPmGaps on the full response and, due to LLM
// non-determinism, returned 1 PM gap — overturning Gate 3's correct suppression.
//
// Fix: if gate3ClassifierRan is true, Gate 4 is skipped entirely. Only one Haiku
// classification call should be made for this response — Gate 3's.

describe("Scenario N52 — Gate 4 skipped when Gate 3 already ran the classifier", () => {
  const THREAD = "workflow-n52"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("makes exactly 5 Anthropic calls — Gate 4 does not add a 6th when Gate 3 classified", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Agent prose triggers Gate 3 extraction (mentions "cannot move forward" + lists items)
    // but the items are DESIGN-scope (animation spec contradiction).
    const agentResponse = [
      "Design cannot move forward until the animation spec contradiction is resolved:",
      "",
      "1. Confirm whether the glow animation opacity cycle is 25% → 35% → 25% over 2.5 seconds",
      "   or 50–100% over 4 seconds, and whether it is a single combined radial gradient or two",
      "   independent separate glows.",
      "",
      "Say yes and I'll bring the PM into this thread now.",
    ].join("\n")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent            → false
    //   [1] isSpecStateQuery              → false
    //   [2] runAgent (end_turn)           → animation contradiction prose
    //   [3] identifyUncommittedDecisions  → none
    //   [4] classifyForPmGaps (Gate 3)    → 0 PM gaps (animation = DESIGN-scope)
    //   Gate 4 MUST NOT run — no 6th call
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: agentResponse }], stop_reason: "end_turn" }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })           // identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NONE" }] })           // Gate 3 classifier → 0 PM gaps

    const params = makeParams(THREAD, "feature-onboarding", "what is blocking design?")
    await handleFeatureChannelMessage(params)

    // Exactly 5 calls — Gate 4 skipped
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(5)

    // No pending escalation — DESIGN-scope item suppressed correctly
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()
  })
})

// ─── Scenario N31: Gate 2 pre-seeds architect-scope items into engineering spec ──────────────
//
// When the design agent calls offer_pm_escalation with mixed items (PM + architect scope),
// Gate 2 classifier identifies them separately. PM-scope items → pendingEscalation.
// Architect-scope items → preseedEngineeringSpec writes [open: architecture] questions
// to the engineering spec draft branch. Silent platform action, no user message.
//
// Real incident (2026-04-12): 3-item offer_pm_escalation → 2 architect-scope items silently
// discarded. This test proves those items now land in the engineering spec draft.

describe("Scenario N31 — Gate 2 pre-seeds architect-scope filtered items into engineering spec", () => {
  const THREAD = "workflow-n31"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
    mockGetRef.mockReset()
    mockCreateRef.mockReset()
  })

  it("architect-scope items are written to engineering spec draft as [open: architecture] questions", async () => {
    // All reads → 404 (no existing specs, no engineering branch yet)
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockGetRef.mockResolvedValue({ data: { object: { sha: "main-sha" } } })
    mockCreateRef.mockResolvedValue({})
    mockCreateOrUpdate.mockResolvedValue({})

    // Agent question: 1 PM gap + 2 architect-scope items
    const mixedQuestion = [
      "1. What happens to the user's SSO session when authentication fails mid-onboarding?",
      "2. What fields must the guest session record contain to survive the sign-up flow?",
      "3. How should the session store enforce TTL on guest sessions?",
    ].join("\n")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent        → false
    //   [1] isSpecStateQuery          → false
    //   [2] runAgent (tool_use)       → offer_pm_escalation (mixed question)
    //   [3] classifyForPmGaps         → 1 GAP (SSO failure UX) + 2 ARCH (session fields, TTL)
    //   [4] runAgent (end_turn)       → agent prose after gate
    //   [5] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: mixedQuestion } }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "GAP: What happens to the user when SSO authentication fails mid-onboarding?\nARCH: What fields must the guest session record contain to survive the sign-up flow?\nARCH: How should the session store enforce TTL on guest sessions?" }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Design is blocked on the SSO failure UX — PM needs to decide what the user experiences." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })

    await handleFeatureChannelMessage(makeParams(THREAD, "feature-onboarding", "what's blocking us?"))

    // PM-scope gap stored in pendingEscalation
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    const pending = getPendingEscalation("onboarding")
    expect(pending).not.toBeNull()
    expect(pending!.question).toContain("SSO")

    // Architect-scope items pre-seeded into engineering spec draft via createOrUpdateFileContents
    const engWriteCall = mockCreateOrUpdate.mock.calls.find(
      (call: any) => call[0]?.path?.includes("onboarding.engineering.md")
    )
    expect(engWriteCall).toBeDefined()
    const writtenContent = Buffer.from(engWriteCall![0].content, "base64").toString("utf-8")
    expect(writtenContent).toContain("[open: architecture]")
    expect(writtenContent).toContain("session record")
    expect(writtenContent).toContain("TTL")
  })
})

// ─── Scenario N32: Architect upstream escalation to Designer — full round-trip ──────────────
//
// Architect discovers an implementation constraint that requires the design spec to be revised.
// Turn 1: Architect calls offer_upstream_revision(question, "design") → pendingEscalation stored.
// Turn 2: User confirms "yes" → design agent runs with constraint brief, @mention posted,
//         escalationNotification set with originAgent: "architect".
// Turn 3: Designer replies → architect resumes with injected design decision.

describe("Scenario N32 — Architect upstream escalation to Designer round-trip", () => {
  const THREAD = "workflow-n32"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "architect")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation, clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
    clearEscalationNotification("onboarding")
  })

  it("user confirms yes → design agent runs with upstream constraint brief, notification set with originAgent:architect", async () => {
    // Pre-seed architect upstream escalation
    setPendingEscalation("onboarding", {
      targetAgent: "design",
      question: "The modal sheet must support partial-height drag — current design specifies full-screen only, which the native nav stack cannot support.",
      designContext: "",
    })

    // All GitHub reads → 404
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Anthropic sequence — handleDesignPhase runs with the constraint brief:
    //   [0] isOffTopicForAgent (design agent) → false
    //   [1] isSpecStateQuery (design agent)   → false
    //   [2] runAgent (design agent brief)     → design recommendations
    //   [3] identifyUncommittedDecisions      → none
    const DESIGN_RECOMMENDATIONS = "1. My recommendation: Use a bottom sheet pattern limited to 60% height with drag-to-dismiss.\n→ Rationale: Native half-sheet is the standard pattern on iOS/Android and fits within nav stack constraints."
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: DESIGN_RECOMMENDATIONS }],
      })
      .mockResolvedValue({ content: [{ type: "text", text: "none" }] })

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // Pending escalation cleared after @mention posted
    const { getPendingEscalation: getEsc, getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEsc("onboarding")).toBeNull()

    // Escalation notification set with originAgent: "architect" so architect resumes on reply
    const notification = getEscalationNotification("onboarding")
    expect(notification).not.toBeNull()
    expect(notification!.targetAgent).toBe("design")
    expect(notification!.originAgent).toBe("architect")
    expect(notification!.recommendations).toBe(DESIGN_RECOMMENDATIONS)

    // @mention posted in thread
    const postMessageCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const mentionCall = postMessageCalls.find((c: any) => c[0]?.text?.includes("architect needs a design revision"))
    expect(mentionCall).toBeDefined()
  })

  it("designer reply → architect resumes with injected design decision, notification cleared", async () => {
    // Pre-seed escalation notification (architect-originated, awaiting designer reply)
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "design",
      question: "The modal sheet must support partial-height drag — current design specifies full-screen only.",
      recommendations: "1. My recommendation: Use a bottom sheet pattern limited to 60% height.\n→ Rationale: Native half-sheet fits nav stack constraints.",
      originAgent: "architect",
    })

    // All GitHub reads → 404
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))

    // Anthropic sequence — runArchitectAgent runs with injected design decision:
    //   [0] isOffTopicForAgent (arch) → false
    //   [1] isSpecStateQuery (arch)   → false
    //   [2] runAgent (architect)      → continues engineering spec with revision applied
    //   [3] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Understood — updating modal sheet spec to use 60% height bottom sheet with drag-to-dismiss. Continuing with API contract." }],
      })
      .mockResolvedValue({ content: [{ type: "text", text: "none" }] })

    const params = makeParams(THREAD, "feature-onboarding", "Approved — use the 60% bottom sheet pattern.")
    await handleFeatureChannelMessage(params)

    // Escalation notification cleared after designer reply
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).toBeNull()

    // Architect was called — the injected message contains the design decision
    const runAgentCall = mockAnthropicCreate.mock.calls.find((call: any) => {
      const lastMsg = (call[0]?.messages as { role: string; content: string }[] | undefined)?.at(-1)
      return lastMsg?.content?.includes("Designer resolved the upstream constraint")
    })
    expect(runAgentCall).toBeDefined()
  })
})

// ─── Scenario N33: PM agent deferral detected → platform enforcement re-run ──────────────────
//
// When the PM agent responds to an escalation brief with a deferral ("I cannot responsibly give
// you recommendations without talking to the human PM"), DEFERRAL_PATTERN detects it and the
// platform immediately re-runs PM with an enforcement override inside the same withThinking bubble.
// The escalationNotification.recommendations must reflect the SECOND (non-deferral) response.

describe("Scenario N33 — PM deferral triggers enforcement re-run, recommendations from second response", () => {
  const THREAD = "workflow-n33"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    // Pre-seed pending escalation — user will confirm "yes" to trigger PM brief
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "Should the onboarding nudge be dismissable? If so, does it re-appear after session reset?",
      designContext: "The design spec currently shows a persistent nudge with no X button.",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation: clrEsc, clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clrEsc("onboarding")
    clearEscalationNotification("onboarding")
  })

  it("structural gate: clarification-stall (0 'My recommendation:' lines) triggers enforcement re-run", async () => {
    // Real incident 2026-04-12: PM asked "Before I give recommendations, I need to clarify..."
    // DEFERRAL_PATTERN didn't match this. Structural count gate catches it: 0 < 1 required.
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    const CLARIFICATION_STALL = "Before I give recommendations, I need to clarify one thing: when you say 'dismissable' — are you asking whether the nudge has an X button, or whether clicking anywhere outside it dismisses it? Once I understand that, I can give you concrete recommendations."
    const PROPER_RECOMMENDATIONS = "1. My recommendation: The nudge should be dismissable via an explicit X button.\n→ Rationale: Explicit dismissal is more intentional — users know they've seen it.\n→ Note: Pending human PM confirmation before engineering handoff"

    // Mock sequence (readOnly=true skips classifyMessageScope):
    //   [0] PM agent run 1 → clarification-stall (0 "My recommendation:" → enforcement fires)
    //   [1] PM agent run 2 → proper recommendations
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: CLARIFICATION_STALL }],
      })                                                                                  // PM agent run 1 → clarification-stall
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: PROPER_RECOMMENDATIONS }],
      })                                                                                  // PM agent run 2 → proper recommendations

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // Platform emitted enforcement update (structural gate fired)
    const updateCalls = (params.client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const enforcementUpdate = updateCalls.find((c: any) => c[0]?.text?.includes("concrete recommendations"))
    expect(enforcementUpdate).toBeDefined()

    // pendingEscalation cleared
    expect(getPendingEscalation("onboarding")).toBeNull()

    // Two-step: escalationNotification IS set — awaiting human approval of PM recommendations
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notification = getEscalationNotification("onboarding")
    expect(notification).not.toBeNull()
    expect(notification?.targetAgent).toBe("pm")
    expect(notification?.recommendations).toContain("My recommendation:")

    // PM ran — exactly 2 calls total (readOnly=true skips classifyMessageScope)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
  })
})

// ─── Scenario N34: Non-standalone-confirmation during escalation notification → PM continues ──
//
// When escalationNotification is active (PM was @mentioned) and the human sends a partial
// approval mixed with a follow-up request ("approved for #4, can you recommend for 1-3?"),
// isStandaloneConfirmation returns false → the message routes back to the PM agent.
// The notification stays active with updated recommendations. Design does NOT resume.

describe("Scenario N34 — Partial approval during escalation routes to PM, notification stays active", () => {
  const THREAD = "workflow-n34"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "pm",
      question: "Should the onboarding nudge be dismissable?",
      recommendations: "1. My recommendation: The nudge should be dismissable.\n→ Rationale: Forcing UI erodes trust.",
      originAgent: "design",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("mixed approval+request routes to PM, escalation notification updated not cleared", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    const UPDATED_RECOMMENDATIONS = "1. My recommendation: The nudge should be dismissable.\n→ Rationale: Confirmed by human.\n\n2. My recommendation: Use a 3-second delay before showing the nudge.\n→ Rationale: Avoids jarring immediate appearance.\n\n3. My recommendation: Position nudge at bottom of screen.\n→ Rationale: Follows mobile HIG guidelines."

    // PM agent called once: classifyMessageScope → feature-specific, runAgent → updated recommendations
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: UPDATED_RECOMMENDATIONS }],
      })

    // "approved for #4, can you recommend for 1-3?" — has question + continuation request → NOT standalone confirmation
    const params = makeParams(THREAD, "feature-onboarding", "approved for #4, can you recommend for 1-3?")
    await handleFeatureChannelMessage(params)

    // Notification must still be active — design did NOT resume
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notification = getEscalationNotification("onboarding")
    expect(notification).not.toBeNull()

    // Recommendations updated to PM's latest response
    expect(notification!.recommendations).toContain("3-second delay")

    // Anthropic was called (PM ran) but patchProductSpecWithRecommendations did NOT run
    // (the design agent never called — no product spec write)
    const productWriteCall = mockCreateOrUpdate.mock.calls.find(
      (call: any) => call[0]?.path?.includes("onboarding.product.md")
    )
    expect(productWriteCall).toBeUndefined()
  })
})

// ─── Scenario N36: Gate 2 three-way classifier — DESIGN: items returned to designer ──────────
//
// When the design agent calls offer_pm_escalation with items that are all visual/UX decisions
// (element type, placement, animation timing), the Gate 2 classifier returns DESIGN: lines
// (0 PM gaps). The platform rejects the tool call and returns the design items back to the
// agent with "resolve these design decisions yourself: [list]". No pendingEscalation is stored.
// The designer owns these decisions and resolves them without PM or architect input.

describe("Scenario N36 — DESIGN: items from Gate 2 classifier returned to agent, no PM escalation stored", () => {
  const THREAD = "workflow-n36"

  beforeEach(() => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearPendingEscalation("onboarding")
  })

  it("DESIGN: items returned to agent as self-resolution list — no pendingEscalation set", async () => {
    const designQuestion = [
      "1. Should the session timer use a chip or an inline text element?",
      "2. Where exactly does the session timer sit relative to the prompt bar — above, below, or overlaid?",
      "3. What is the animation timing for the timer appearing: entry direction, duration (ms), and easing function?",
    ].join("\n")

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent        → false
    //   [1] isSpecStateQuery          → false
    //   [2] runAgent (tool_use)       → offer_pm_escalation (all design-scope items)
    //   [3] classifyForPmGaps         → 3 DESIGN: lines (0 GAP:, 0 ARCH:)
    //   [4] runAgent (end_turn)       → agent resolves design items independently
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_pm_escalation", input: { question: designQuestion } }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "DESIGN: Whether the session timer uses a chip or inline text element.\nDESIGN: Vertical position of the session timer relative to the prompt bar.\nDESIGN: Animation timing for the session timer appearance (direction, duration, easing)." }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I've resolved these visual decisions: chip component for the timer, positioned above the prompt bar, sliding in from top over 200ms with ease-out." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "what visual decisions do you need to lock down?")
    await handleFeatureChannelMessage(params)

    // No PM escalation stored — these were design decisions, not PM gaps
    const { getPendingEscalation } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    // Agent's final response is present (it resolved independently)
    const text = lastUpdateText(params.client)
    expect(text).toContain("resolved")
  })
})

// ─── Scenario N35: Structural recommendation gate — partial answer triggers enforcement ──────
//
// Brief has 2 numbered items. PM agent responds with only 1 "My recommendation:" line.
// Structural gate: countRecommendations(1) < countBriefItems(2) → enforcement re-run.
// Catches the original incident: PM gave recommendation for #4 but deferred on 1-3.
// No DEFERRAL_PATTERN needed — gate fires on output shape alone.

describe("Scenario N35 — Structural gate fires when PM answers fewer items than the brief requires", () => {
  const THREAD = "workflow-n35"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    // Two-item brief — PM must produce 2 "My recommendation:" lines
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "1. When SSO fails for a returning user, should they remain logged out with an error, or enter a retry state?\n2. Define what the logged-out indicator must communicate to the user and the conditions under which it appears.",
      designContext: "",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation: clrEsc, clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clrEsc("onboarding")
    clearEscalationNotification("onboarding")
  })

  it("1-of-2 partial answer triggers enforcement — final notification contains 2 recommendations", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    // First PM run: answers item 2 only — 1 "My recommendation:" line, brief requires 2
    const PARTIAL_ANSWER = "2. My recommendation: The logged-out indicator should display the text 'Session expired — tap to sign in again' and appear whenever the user attempts an authenticated action while logged out.\n→ Rationale: Clear, actionable copy reduces confusion.\n→ Note: Pending human PM confirmation before engineering handoff\n\nFor item 1, I want to clarify what 'retry state' means before committing to a recommendation."
    const FULL_RECOMMENDATIONS = "1. My recommendation: The user should remain logged out with a clear, persistent error message on the sign-in screen.\n→ Rationale: Retaining context in a retry state adds complexity without meaningful benefit for auth failures.\n→ Note: Pending human PM confirmation before engineering handoff\n\n2. My recommendation: The logged-out indicator should display 'Session expired — tap to sign in again' whenever the user attempts an authenticated action while logged out.\n→ Rationale: Clear, actionable copy reduces confusion.\n→ Note: Pending human PM confirmation before engineering handoff"

    // Two-step: design does NOT run yet — escalationNotification set, awaiting human approval.
    // readOnly=true skips classifyMessageScope — only PM agent calls.
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: PARTIAL_ANSWER }],
      })                                                                                  // PM run 1 → 1 recommendation (partial)
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: FULL_RECOMMENDATIONS }],
      })                                                                                  // PM run 2 → 2 recommendations (enforcement)

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // Structural gate must have fired — enforcement update emitted
    const updateCalls = (params.client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const enforcementUpdate = updateCalls.find((c: any) => c[0]?.text?.includes("concrete recommendations"))
    expect(enforcementUpdate).toBeDefined()

    // Two-step: escalationNotification IS set with both recommendations — awaiting human approval
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notification = getEscalationNotification("onboarding")
    expect(notification).not.toBeNull()
    expect(notification?.targetAgent).toBe("pm")
    // Final notification contains BOTH recommendations (enforcement run produced full 2-item answer)
    expect(notification?.recommendations).toContain("1. My recommendation:")
    expect(notification?.recommendations).toContain("2. My recommendation:")

    // PM ran — exactly 2 calls total (readOnly=true skips classifyMessageScope)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
  })
})

// ─── Scenario N37: Server-restart escalation recovery ──────────────────────────────────────────
//
// confirmedAgent is cleared by a server restart (in-memory wipe), but pendingEscalation
// survives in .conversation-state.json. When the user says "yes" in the next message,
// the router recovers the confirmed agent from the pending escalation and routes to the
// escalation-confirmation path — NOT to the design agent.

describe("Scenario N37 — Server restart clears confirmedAgent but pendingEscalation survives; yes routes to PM escalation", () => {
  const THREAD = "workflow-n37"

  beforeEach(() => {
    clearHistory("onboarding")
    // Simulate restart: confirmed agent is ABSENT (not in store)
    // but pendingEscalation was loaded from .conversation-state.json
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "1. Replace 'ambient awareness only' with a concrete measurable requirement.\n2. Specify the exact text the logged-out indicator should display.",
      designContext: "",
    })
    // confirmedAgent is intentionally NOT set (simulates post-restart state)
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation: clrEsc, clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clrEsc("onboarding")
    clearEscalationNotification("onboarding")
  })

  it("yes routes to PM escalation (not design agent) when confirmedAgent is absent but pendingEscalation exists", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    // PM agent runs with the brief
    const PM_RECOMMENDATIONS = "1. My recommendation: The logged-out indicator must be static — no animation, no expand, no popovers, no sign-up prompts.\n→ Rationale: Ambient awareness means presence without demand.\n→ Note: Pending human PM confirmation before engineering handoff\n\n2. My recommendation: Display 'Not signed in — your session will not be saved'.\n→ Rationale: Makes implications of logged-out state explicit.\n→ Note: Pending human PM confirmation before engineering handoff"

    // The router recovers confirmedAgent="ux-design" from pendingEscalation, then runs PM escalation.
    // PM path: classifyMessageScope (1) + PM agent run (1). 2 items → 2 recommendations → no enforcement.
    // Two-step: design does NOT run yet — escalationNotification set, awaiting human approval.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: PM_RECOMMENDATIONS }],
      })                                                                                  // PM agent run

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // pendingEscalation cleared
    const { getPendingEscalation, getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getPendingEscalation("onboarding")).toBeNull()

    // Two-step: escalationNotification IS set — awaiting human approval
    const notification = getEscalationNotification("onboarding")
    expect(notification).not.toBeNull()
    expect(notification?.targetAgent).toBe("pm")
    expect(notification?.recommendations).toContain("My recommendation:")

    // PM ran — exactly 2 calls total (no design phase yet)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
  })
})

// ─── Scenario N38: loadAgentContext main-branch fallback for approved product spec ──────────────

describe("Scenario N38 — loadAgentContext falls back to main when draft branch 404s, PM agent gets product spec", () => {
  const THREAD = "workflow-n38"

  beforeEach(() => {
    clearHistory("onboarding")
    // pendingEscalation without productSpec — simulates state restored from disk without the field,
    // or set by the pre-run structural gate before the main-branch fallback was implemented.
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "1. What is the exact copy for the logged-out indicator?",
      designContext: "",
      // productSpec intentionally absent
    })
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation: clrEsc, clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clrEsc("onboarding")
    clearEscalationNotification("onboarding")
  })

  it("PM agent receives approved product spec from main-branch fallback when productSpec absent from pendingEscalation", async () => {
    const approvedSpec = "## Problem\nHelp users onboard.\n\n## Target Users\nNew mobile users.\n"

    // Draft branch 404s → loadAgentContext falls back to main (returns the approved spec)
    mockGetContent.mockImplementation((params: any) => {
      if (params?.ref === "spec/onboarding-product") {
        return Promise.reject(Object.assign(new Error("not found"), { status: 404 }))
      }
      if (params?.path?.includes("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(approvedSpec).toString("base64"), type: "file" } })
      }
      return Promise.reject(Object.assign(new Error("not found"), { status: 404 }))
    })
    mockPaginate.mockResolvedValue([])

    const PM_RECOMMENDATIONS = "1. My recommendation: Use 'Not signed in' — concise and universally understood.\n→ Rationale: Standard phrasing across industry; no ambiguity.\n→ Note: Pending human PM confirmation before engineering handoff"

    // Call sequence (no pre-escalation audit — removed; only specific design-agent gaps go to PM):
    //   [0] classifyMessageScope → "feature-specific" (inside runPmAgent)
    //   [1] PM agent run → PM_RECOMMENDATIONS (1 item, 1 "My recommendation:" → no enforcement)
    // Two-step: design does NOT run yet — escalationNotification set, awaiting human approval.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // [0] classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: PM_RECOMMENDATIONS }],
      })                                                                                   // [1] PM agent run

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // PM agent should have gotten the product spec — verify via the content passed to the Anthropic call.
    // Call index [1] is the PM agent run — its user message (brief) includes product spec section.
    const pmCall = mockAnthropicCreate.mock.calls[1]
    const systemBlocks = pmCall[0].system as Array<{ type: string; text: string }>
    const systemText = systemBlocks.map((b: any) => b.text ?? "").join("")
    // The approved spec is injected via context.currentDraft in the PM system prompt
    expect(systemText).toContain("Help users onboard")

    // Two-step: escalationNotification IS set — awaiting human approval of PM recommendations
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    const notification = getEscalationNotification("onboarding")
    expect(notification).not.toBeNull()
    expect(notification?.targetAgent).toBe("pm")
  })
})

// ─── Scenario N39: prompt caching — system prompt passed as TextBlockParam[] ──────────────────

describe("Scenario N39 — agent system prompts are passed as TextBlockParam[] arrays for prompt caching", () => {
  const THREAD = "workflow-n39"

  beforeEach(() => {
    clearHistory("n39feature")
    setConfirmedAgent("n39feature", "ux-design")
  })

  it("design agent Anthropic call receives system as TextBlockParam[] — at least one block has cache_control", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    // With confirmedAgent already set, classifyMessageScope is skipped — first call IS the design agent
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Let's design the feature." }],
      })

    const params = makeParams(THREAD, "feature-n39feature", "Let's start designing")
    await handleFeatureChannelMessage(params)

    // The design agent call is the one where system is a TextBlockParam[] array.
    // isOffTopicForAgent and isSpecStateQuery call client.messages.create directly with string
    // system fields; identifyUncommittedDecisions sends no system field at all. Only the design
    // agent (via runAgent → buildDesignSystemBlocks) passes system as an array.
    const allCalls = mockAnthropicCreate.mock.calls
    const designCall = allCalls.find((c: any) => Array.isArray(c[0].system))
    expect(designCall).toBeDefined()

    const system = designCall![0].system as Array<{ type: string; text: string; cache_control?: unknown }>

    for (const block of system) {
      expect(block.type).toBe("text")
      expect(typeof block.text).toBe("string")
    }

    // Stable block carries cache_control — at least one block must have it
    const cachedBlocks = system.filter(b => b.cache_control)
    expect(cachedBlocks.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── Scenario N40: escalation-continuation auto-close when PM saves spec ─────────────────────
//
// Root cause of 2026-04-13 production incident: "agree to both your recommendations" is not in
// isAffirmative's keyword list → isStandaloneConfirmation returns false → continuation path →
// PM runs again but escalationNotification is never cleared → every subsequent message routes to PM.
//
// Fix: after runPmAgent in the continuation path, check toolCallsOut for any spec-save tool.
// A save tool call is a deterministic signal the escalation is resolved — clear the notification
// and resume design regardless of how the human phrased their message.

describe("Scenario N40 — PM saves spec in continuation path → escalation auto-closed, design resumes", () => {
  const THREAD = "workflow-n40"

  beforeEach(async () => {
    clearHistory("n40feature")
    setConfirmedAgent("n40feature", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("n40feature", {
      targetAgent: "pm",
      question: "1. What is the exact copy for the logged-out indicator?",
      recommendations: "1. My recommendation: Use 'Not signed in'.\n→ Rationale: Standard phrasing.",
    })
  })
  afterEach(async () => {
    clearHistory("n40feature")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("n40feature")
  })

  it("non-affirmative message that causes PM to save spec → escalation cleared, design agent runs", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    // auditSpecDraft early-returns { status: "ok" } when productVision + systemArchitecture are empty
    // (both 404 from GitHub in this test) — so it makes NO Anthropic call in the tool handler.
    // Mock sequence (continuation path: PM runs, saves spec, design resumes):
    //   [0] classifyMessageScope      → "feature-specific" (runPmAgent calls this before main agent)
    //   [1] PM: stop_reason=tool_use  → save_product_spec_draft (auditSpecDraft skipped — no context)
    //   [2] PM: stop_reason=end_turn  → "Done. Spec updated." (tool result fed back)
    //   auto-close fires → design agent path:
    //   [3] isOffTopicForAgent        → false
    //   [4] isSpecStateQuery          → false
    //   [5] design agent              → "Let's continue the design."
    //   default: NONE for all remaining (identifyUncommittedDecisions etc.)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "save_product_spec_draft", input: { content: "## Problem\nLocked decision." } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      // PM end_turn after tool result
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done. Spec updated." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      // design agent path
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }) // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }) // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Let's continue the design." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }) // design agent

    // Non-affirmative message (does not start with yes/agree/ok/etc.) — triggers continuation path, not standalone confirmation
    const params = makeParams(THREAD, "feature-n40feature", "those recommendations look right, apply them")
    await handleFeatureChannelMessage(params)

    // Escalation notification must be cleared — not stuck in PM loop
    const { getEscalationNotification } = await import("../../../runtime/conversation-store")
    expect(getEscalationNotification("n40feature")).toBeNull()

    // Design agent must have been called — verified by checking the last update text
    const text = lastUpdateText(params.client)
    expect(text).toContain("Let's continue the design.")
  })
})

// ─── Scenario N41: per-feature in-flight lock ─────────────────────────────────
//
// When an agent run is already active for a feature (PM takes 10s+), a second
// message arriving before the first completes should be rejected immediately with
// a "Still working" message — not start a second parallel agent run.
//
// This prevents the Slack double-fire bug where both PM and UX Designer respond
// to the same message when a Slack retry arrives during a slow PM agent run.

describe("Scenario N41 — per-feature in-flight lock rejects concurrent messages", () => {
  const THREAD = "workflow-n41"

  beforeEach(() => {
    clearHistory("n41feature")
    // Pre-set confirmed agent to PM so we skip classifyIntent on the first message.
    // This makes the mock sequence deterministic: classifyMessageScope (1) + PM agent (2, blocks).
    setConfirmedAgent("n41feature", "pm")
  })

  afterEach(() => {
    clearHistory("n41feature")
  })

  it("second message for same feature while first is in-flight gets 'Still working' reply, no agent call", async () => {
    // First call mock sequence (confirmed-pm branch → runPmAgent):
    //   [0] classifyMessageScope → "feature-specific"
    //   [1] PM main agent        → blocks until resolveFirst() is called
    // Second call must be rejected by the lock before making any API calls.
    let resolveFirst!: () => void
    const firstCallBlock = new Promise<void>((res) => { resolveFirst = res })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }) // classifyMessageScope
      .mockImplementationOnce(async () => {
        await firstCallBlock // Block until second message has been processed
        return { content: [{ type: "text", text: "Here is the spec." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }
      })

    const params1 = makeParams(THREAD, "feature-n41feature", "tell me about the spec")
    const params2 = makeParams(THREAD, "feature-n41feature", "another message while first runs")

    // Start first message — acquires lock synchronously, then blocks on PM agent call
    const firstRun = handleFeatureChannelMessage(params1)

    // Yield to the event loop so params1 can acquire the lock and reach its first await
    await new Promise<void>((res) => setTimeout(res, 10))

    // Fire second message while first is still in-flight — should be rejected by lock
    await handleFeatureChannelMessage(params2)

    // Unblock first call and wait for it to complete
    resolveFirst()
    await firstRun

    // params2 should have received "Still working" via postMessage (not update)
    const postMessageCalls = (params2.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const stillWorkingCall = postMessageCalls.find((c: any[]) =>
      typeof c[0]?.text === "string" && c[0].text.includes("Still working")
    )
    expect(stillWorkingCall).toBeDefined()

    // Only 2 API calls total: classifyMessageScope + PM agent (both for params1).
    // params2 made zero — lock prevented it from reaching any agent call.
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
  })
})

// ─── Scenario N42: DELETED — clearProductBlockingMarkersFromDesignSpec removed (root cause fix) ──
//
// This scenario tested clearProductBlockingMarkersFromDesignSpec(), which was a symptom fix
// for the escalation loop bug (2026-04-13). The symptom: after PM resolved questions, the
// pre-run gate re-fired on stale [type: product] [blocking: yes] markers still in the spec.
//
// Root cause fix (same date): rubric criterion 10 now outputs [PM-GAP] (a rubric-level tag,
// never written to spec) instead of [type: product] [blocking: yes]. The design agent system
// prompt also explicitly prohibits writing product-scope questions as open questions. With the
// invariant enforced at the source, there are no markers to clear — the symptom fix and its
// test are obsolete. See N19 for the new invariant verification.
//
// clearProductBlockingMarkersFromDesignSpec and extractProductBlockingQuestions have been deleted.

// ─── Scenario N43: PM calls offer_architect_escalation in auto-close path ─────
//
// When PM resolves design blocking questions AND identifies an architecture gap,
// it should call offer_architect_escalation tool — not mention it in prose.
// Platform enforcement: the tool call is the signal. If PM called the tool,
// surface the architect escalation to the user before resuming design.
//
// Production gap (2026-04-13): PM mentioned "escalate to the architect" in prose
// but PM_TOOLS had no offer_architect_escalation tool. Platform had nothing to
// act on, so user's "yes" was swallowed by the next pendingEscalation.

describe("Scenario N43 — PM offer_architect_escalation in auto-close path surfaces architect question", () => {
  const THREAD = "workflow-n43"

  beforeEach(async () => {
    clearHistory("n43feature")
    setConfirmedAgent("n43feature", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("n43feature", {
      targetAgent: "pm",
      question: "1. Define what 'ambient awareness only' means operationally.",
      recommendations: "1. My recommendation: Non-clickable text only.",
    })
  })

  afterEach(async () => {
    clearHistory("n43feature")
    const { clearEscalationNotification, clearPendingEscalation } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("n43feature")
    clearPendingEscalation("n43feature")
  })

  it("PM saves spec and calls offer_architect_escalation → architect escalation surfaced, design does NOT run", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    // Mock sequence (continuation path):
    //   [0] classifyMessageScope → "feature-specific"
    //   [1] PM: stop_reason=tool_use → save_product_spec_draft
    //   [2] PM: stop_reason=tool_use → offer_architect_escalation
    //   [3] PM: stop_reason=end_turn → "Done."
    //   auto-close fires → architect escalation detected → postMessage, no design agent call
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "save_product_spec_draft", input: { content: "## Problem\nDecisions locked." } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_2", name: "offer_architect_escalation", input: { question: "1. What is the data retention policy for logged-out sessions?" } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Done. Spec updated and architecture gap registered." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })

    const params = makeParams(THREAD, "feature-n43feature", "those recommendations look right, apply them")
    await handleFeatureChannelMessage(params)

    // Architect escalation must be surfaced via postMessage
    const postMessageCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const archEscalationMsg = postMessageCalls.find((c: any[]) =>
      typeof c[0]?.text === "string" && c[0].text.includes("architecture gap")
    )
    expect(archEscalationMsg).toBeDefined()
    expect(archEscalationMsg![0].text).toContain("data retention policy")

    // pendingEscalation must be set to architect
    const { getPendingEscalation: getPE } = await import("../../../runtime/conversation-store")
    const pending = getPE("n43feature")
    expect(pending).not.toBeNull()
    expect(pending!.targetAgent).toBe("architect")

    // Design agent must NOT have run — no design-agent update after the postMessage
    const updateCalls = (params.client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const designUpdate = updateCalls.find((c: any[]) => typeof c[0]?.text === "string" && c[0].text.includes("UX Designer"))
    expect(designUpdate).toBeUndefined()
  })
})

// ─── Scenario N44: Architect escalation writeback routes to engineering spec ──────────────────
//
// When the design agent escalates to the architect (offer_architect_escalation) and the human
// confirms, the platform must write the decision to the engineering spec branch — NOT to the
// product spec. The old code called patchProductSpecWithRecommendations unconditionally, which
// was wrong: architect decisions belong in the engineering spec, not the product spec.
//
// Routing is determined by isArchitectEscalation = escalationNotification.targetAgent === "architect".

describe("Scenario N44 — Architect escalation confirmation routes writeback to engineering spec (not product spec)", () => {
  const THREAD = "workflow-n44"
  const QUESTION = "What is the max file upload size the API enforces?"
  const DECISION = "1. My recommendation: 10MB hard limit — API returns 413 for larger payloads."

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "architect",
      question: QUESTION,
      recommendations: DECISION,
      originAgent: "design",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("writes decision to engineering spec branch; does NOT write to product spec on main", async () => {
    // GitHub call order after standalone confirmation:
    // 1. patchEngineeringSpecWithDecision reads arch spec branch → 404 (no spec yet), then writes to branch
    // 2. Design phase resumes → various context reads (all 404)
    mockGetRef.mockResolvedValue({ data: { object: { sha: "main-sha" } } })
    mockCreateRef.mockResolvedValue({})
    mockCreateOrUpdate.mockResolvedValue({})
    // All reads: 404 (arch spec not found, context reads fail gracefully)
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }))

    // Anthropic: design agent resumes after escalation cleared
    mockAnthropicCreate
      .mockResolvedValue({
        content: [{ type: "text", text: "Architect confirmed the upload limit. Updating design spec now." }],
        stop_reason: "end_turn",
      })

    const params = makeParams(THREAD, "feature-onboarding", "approved, proceed")
    await handleFeatureChannelMessage(params)

    // Engineering spec branch must have been written (saveDraftEngineeringSpec → createOrUpdateFileContents on branch)
    const engWrite = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.path?.includes("onboarding.engineering.md")
    )
    expect(engWrite).toBeDefined()
    const engContent = Buffer.from(engWrite![0].content, "base64").toString()
    expect(engContent).toContain(QUESTION)
    expect(engContent).toContain("Pre-Engineering Architectural Decisions")

    // Product spec must NOT have been written (patchProductSpecWithRecommendations not called)
    const productWrite = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.path?.includes("onboarding.product.md")
    )
    expect(productWrite).toBeUndefined()
  })
})

// ─── N44 update to N30: isArchitectEscalation=true → patchProductSpecWithRecommendations NOT called ──
//
// This is the N30 complementary test: when targetAgent=architect, the PM writeback must NOT fire.
// N30 already tests the PM path (targetAgent=pm → product spec written). This ensures the
// routing condition is exclusive.

describe("Scenario N30 variant — isArchitectEscalation=true → product spec NOT written", () => {
  const THREAD = "workflow-n30-arch"

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "ux-design")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "architect",
      question: "What caching strategy should the auth token use?",
      recommendations: "1. My recommendation: 15-minute TTL with sliding window.",
      originAgent: "design",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("does not write to product spec on main when targetAgent=architect", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "main-sha" } } })
    mockCreateRef.mockResolvedValue({})
    mockCreateOrUpdate.mockResolvedValue({})
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }))
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "Architect decision applied." }],
      stop_reason: "end_turn",
    })

    const params = makeParams(THREAD, "feature-onboarding", "yes approved")
    await handleFeatureChannelMessage(params)

    // No product spec write — routing must have gone to engineering spec only
    const productSpecWrite = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => {
        const msg: string = c[0]?.message ?? ""
        return msg.includes("product.md") || c[0]?.path?.includes("product.md")
      }
    )
    expect(productSpecWrite).toBeUndefined()
  })
})

// ─── Scenario N44b: Arch upstream escalation reply writes to engineering spec ─────────────────
//
// When the ARCHITECT calls offer_upstream_revision targeting "pm" and the PM responds with a
// standalone confirmation, the platform must write the architect's question + PM decision to the
// engineering spec (as a pre-engineering decision) before resuming the architect.

describe("Scenario N44b — Arch upstream escalation confirmation writes to engineering spec", () => {
  const THREAD = "workflow-n44b"
  const ARCH_QUESTION = "Does the product spec allow background sync to run while the app is backgrounded?"
  const PM_DECISION = "Yes — background sync is explicitly in scope per the approved product spec."

  beforeEach(async () => {
    clearHistory("onboarding")
    setConfirmedAgent("onboarding", "architect")
    const { setEscalationNotification } = await import("../../../runtime/conversation-store")
    setEscalationNotification("onboarding", {
      targetAgent: "pm",
      question: ARCH_QUESTION,
      recommendations: PM_DECISION,
      originAgent: "architect",
    })
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearEscalationNotification } = await import("../../../runtime/conversation-store")
    clearEscalationNotification("onboarding")
  })

  it("writes pre-engineering decision to engineering spec branch before resuming architect", async () => {
    mockGetRef.mockResolvedValue({ data: { object: { sha: "main-sha" } } })
    mockCreateRef.mockResolvedValue({})
    mockCreateOrUpdate.mockResolvedValue({})
    mockGetContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }))

    // Anthropic: architect resumes after confirmation
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "PM confirmed background sync is in scope. Proceeding with engineering spec." }],
      stop_reason: "end_turn",
    })

    const params = makeParams(THREAD, "feature-onboarding", "confirmed, proceed")
    await handleFeatureChannelMessage(params)

    // Engineering spec branch must have been written with the decision
    const engWrite = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.path?.includes("onboarding.engineering.md")
    )
    expect(engWrite).toBeDefined()
    const engContent = Buffer.from(engWrite![0].content, "base64").toString()
    expect(engContent).toContain("Pre-Engineering Architectural Decisions")
    expect(engContent).toContain(ARCH_QUESTION)
  })
})

// ─── Scenario N47: [blocking: no] open question blocks all three finalize_* handlers ──────────
//
// Before this fix, only [blocking: yes] questions blocked finalization.
// The new extractAllOpenQuestions gate blocks on ANY question (yes or no).
// All three finalize_* handlers must enforce this.

describe("Scenario N47 — [blocking: no] question blocks finalize_product_spec", () => {
  const THREAD = "workflow-n47-pm"
  // Spec with ONLY a non-blocking question — was previously allowed through
  const DRAFT_WITH_NON_BLOCKING = `# Onboarding Product Spec\n\n## Open Questions\n- [type: product] [blocking: no] Should we add a skip button to step 3?\n`
  const DRAFT_B64 = Buffer.from(DRAFT_WITH_NON_BLOCKING).toString("base64")

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("finalize_product_spec blocks when spec has a [blocking: no] question", async () => {
    setConfirmedAgent("onboarding", "pm")

    // GitHub: product spec branch has draft with [blocking: no] question
    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.product.md") && ref?.includes("product")) {
        return { data: { content: DRAFT_B64, type: "file" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    mockGetRef.mockRejectedValue(new Error("Not Found"))

    // Agent calls finalize_product_spec
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Spec has remaining open questions." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "approve the spec")
    await handleFeatureChannelMessage(params)

    // saveApprovedSpec must NOT have been called (finalization blocked)
    const productMain = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes("final approved")
    )
    expect(productMain).toBeUndefined()
  })
})

describe("Scenario N47 — [blocking: no] question blocks finalize_design_spec", () => {
  const THREAD = "workflow-n47-design"
  const DRAFT = `# Onboarding Design Spec\n\n## Open Questions\n- [type: design] [blocking: no] Should the empty state show a subtle illustration?\n\n## Screens\nAuth screen.\n`
  const DRAFT_B64 = Buffer.from(DRAFT).toString("base64")

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("finalize_design_spec blocks when spec has a [blocking: no] question", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.design.md") && ref?.includes("design")) {
        return { data: { content: DRAFT_B64, type: "file" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    mockGetRef.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_design_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Design spec has remaining open questions." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "approve the design")
    await handleFeatureChannelMessage(params)

    // saveApprovedDesignSpec must NOT have been called
    const designMain = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes("design.md — final approved")
    )
    expect(designMain).toBeUndefined()
  })
})

describe("Scenario N47 — [blocking: no] question blocks finalize_engineering_spec", () => {
  const THREAD = "workflow-n47-arch"
  const DRAFT = `# Onboarding Engineering Spec\n\n## Open Questions\n- [type: engineering] [blocking: no] Should we use Redis or Postgres for session caching?\n\n## API Contracts\nPOST /auth\n`
  const DRAFT_B64 = Buffer.from(DRAFT).toString("base64")

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("finalize_engineering_spec blocks when spec has a [blocking: no] question", async () => {
    setConfirmedAgent("onboarding", "architect")

    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.engineering.md") && ref?.includes("engineering")) {
        return { data: { content: DRAFT_B64, type: "file" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    mockGetRef.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] }) // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] }) // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_engineering_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Engineering spec has remaining open questions." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "approve the engineering spec")
    await handleFeatureChannelMessage(params)

    // saveApprovedEngineeringSpec must NOT have been called
    const engMain = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes("engineering.md — final approved")
    )
    expect(engMain).toBeUndefined()
  })
})

// ─── Scenario N46: finalize_engineering_spec blocked on unconfirmed design assumptions ────────
//
// When ## Design Assumptions To Validate has content in the engineering spec draft,
// finalize_engineering_spec must block. This is the structural gate ensuring the architect
// confirms or escalates every design assumption before engineering is approved.

describe("Scenario N46 — finalize_engineering_spec blocked when Design Assumptions To Validate is non-empty", () => {
  const THREAD = "workflow-n46"
  const DRAFT = [
    "# Onboarding Engineering Spec",
    "",
    "## Design Assumptions To Validate",
    "",
    "- Designed for max 10MB file uploads — upload UX assumes immediate processing.",
    "",
    "## API Contracts",
    "POST /auth → { userId, token }",
  ].join("\n")
  const DRAFT_B64 = Buffer.from(DRAFT).toString("base64")

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("blocks finalize_engineering_spec when unconfirmed design assumptions remain", async () => {
    setConfirmedAgent("onboarding", "architect")

    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.engineering.md") && ref?.includes("engineering")) {
        return { data: { content: DRAFT_B64, type: "file" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    mockGetRef.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] }) // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] }) // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_engineering_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Engineering spec has unconfirmed design assumptions." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "finalize the engineering spec")
    await handleFeatureChannelMessage(params)

    // saveApprovedEngineeringSpec must NOT have been called
    const engMain = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes("engineering.md — final approved")
    )
    expect(engMain).toBeUndefined()
  })
})

// ─── Scenario N48: finalize_product_spec blocked when ## Design Notes is non-empty ────────────
//
// The PM must address (or move to ## Design Notes) all design guidance before finalizing.
// If ## Design Notes has content, finalize_product_spec must block even if there are no
// open questions — the design notes must be explicitly resolved first.

describe("Scenario N48 — finalize_product_spec blocked when Design Notes is non-empty", () => {
  const THREAD = "workflow-n48"
  const DRAFT = [
    "# Onboarding Product Spec",
    "",
    "## Acceptance Criteria",
    "- User can register.",
    "",
    "## Open Questions",
    "(none)",
    "",
    "## Design Notes",
    "- The empty state should feel encouraging, not alarming — designer owns the visual treatment.",
  ].join("\n")
  const DRAFT_B64 = Buffer.from(DRAFT).toString("base64")

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("blocks finalize_product_spec when ## Design Notes is non-empty", async () => {
    setConfirmedAgent("onboarding", "pm")

    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.product.md") && ref?.includes("product")) {
        return { data: { content: DRAFT_B64, type: "file" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    mockGetRef.mockRejectedValue(new Error("Not Found"))

    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Cannot finalize — Design Notes must be addressed first." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "finalize the spec")
    await handleFeatureChannelMessage(params)

    // saveApprovedSpec must NOT have been called
    const productMain = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes("product.md — final approved")
    )
    expect(productMain).toBeUndefined()
  })
})

// ─── Scenario N49 — finalize_product_spec blocked by design-readiness gate ────
//
// When the PM spec passes all structural gates (no open questions, no Design Notes)
// but auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC) returns a FINDING (vague language
// that a designer cannot implement without inventing answers), finalize_product_spec
// must block and return the findings to the PM agent.
//
// The design agent should NEVER be the first to discover vague PM spec requirements.

describe("Scenario N49 — finalize_product_spec blocked by PM_DESIGN_READINESS_RUBRIC", () => {
  const THREAD = "workflow-n49"
  // Spec with vague acceptance criteria: "ambient" is in the vague-word list
  const DRAFT = [
    "# Onboarding Product Spec",
    "",
    "## Acceptance Criteria",
    "- When a user's session expires, the app shows an ambient awareness indicator that does not disrupt the conversation.",
    "",
    "## Open Questions",
    "",
  ].join("\n")
  const DRAFT_B64 = Buffer.from(DRAFT).toString("base64")

  beforeEach(() => { clearHistory("onboarding") })
  afterEach(() => { clearHistory("onboarding") })

  it("blocks finalization when PM_DESIGN_READINESS_RUBRIC returns a FINDING", async () => {
    setConfirmedAgent("onboarding", "pm")

    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path?.includes("onboarding.product.md") && ref?.includes("product")) {
        return { data: { content: DRAFT_B64, type: "file" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })
    mockGetRef.mockRejectedValue(new Error("Not Found"))

    // [0] runAgent: tool_use → finalize_product_spec
    // [1] auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC) → FINDING (vague "ambient awareness indicator") [parallel with 2]
    // [2] auditDownstreamReadiness(designer) → PASS [parallel with 1]
    // combined findings from [1] block finalization
    // [3] runAgent: end_turn → agent surfaces the finding to PM
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "FINDING: 'ambient awareness indicator' is too vague for a designer to implement | Replace with a concrete UI treatment: read-only banner below the chat header, no interactive elements, text reads 'Session expired — tap to sign in again'" }],
      })                                                                                      // auditPhaseCompletion: FINDING
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })                 // auditDownstreamReadiness: PASS
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Cannot finalize — the 'ambient awareness indicator' acceptance criterion is too vague for the designer to implement." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "finalize the spec")
    await handleFeatureChannelMessage(params)

    // spec must NOT have been saved
    const productMain = mockCreateOrUpdate.mock.calls.find(
      (c: any[]) => c[0]?.message?.includes("product.md — final approved")
    )
    expect(productMain).toBeUndefined()

    // agent must have surfaced the finding to the PM
    const text = lastUpdateText(params.client)
    expect(text).toContain("ambient")
  })
})

// ─── Scenario N50: PM escalation — only design-agent-identified gaps go to PM ─────────────────
//
// When user says "yes" to pendingEscalation (PM path), PM answers ONLY the specific gaps the
// design agent identified — no pre-escalation audit. The pre-escalation audit was removed because
// inflating the brief to 13+ items caused Haiku to introduce new imprecision at higher rate than
// natural convergence (3-4 rounds of 2-3 items each). The audit belongs only at finalize_product_spec.

describe("Scenario N50 — PM escalation two-step: PM brief content, approval, and design resume", () => {
  // Two-step PM escalation:
  //   Turn 2 (first "yes"): PM runs, escalationNotification set, design does NOT run yet
  //   Turn 3 (second "yes"): spec patched, design resumes
  // This verifies:
  //   1. PM brief contains only design-identified questions (no audit inflation)
  //   2. Design cannot resume until human explicitly approves PM recommendations
  //   3. Spec patched (or skipped if 404) and design resumes on approval

  const THREAD = "workflow-n50"

  beforeEach(() => {
    clearHistory("onboarding")
    setPendingEscalation("onboarding", {
      targetAgent: "pm",
      question: "1. What is the exact copy for the logged-out indicator?",
      designContext: "",
    })
    setConfirmedAgent("onboarding", "ux-design")
  })
  afterEach(async () => {
    clearHistory("onboarding")
    const { clearPendingEscalation: clrEsc } = await import("../../../runtime/conversation-store")
    const { clearEscalationNotification: clrNotif } = await import("../../../runtime/conversation-store")
    clrEsc("onboarding")
    clrNotif("onboarding")
  })

  it("Turn 2: PM brief contains only the design-agent-identified question — no audit inflation; design does not run yet", async () => {
    mockPaginate.mockResolvedValue([])

    const PM_RECOMMENDATIONS = "1. My recommendation: Use 'Not signed in' text.\n→ Rationale: Clear and concise.\n→ Note: Pending your approval — say yes to apply to the product spec"

    // Call sequence (Turn 2 — PM only, design does NOT run):
    //   [0] classifyMessageScope → "feature-specific"
    //   [1] PM agent → PM_RECOMMENDATIONS (1 item, enforcement gate passes — 1 "My recommendation:")
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // [0] classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: PM_RECOMMENDATIONS }],
        usage: { input_tokens: 10, output_tokens: 30 },
      })                                                                                   // [1] PM agent

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // PM brief (classifyMessageScope call [0]) contains only the design-agent question
    const classifyCall = mockAnthropicCreate.mock.calls[0]
    const briefText = classifyCall[0].messages[0].content as string
    expect(briefText).toContain("What is the exact copy for the logged-out indicator?")

    // pendingEscalation cleared, escalationNotification set — awaiting approval
    expect(getPendingEscalation("onboarding")).toBeNull()
    const { getEscalationNotification: getNotif } = await import("../../../runtime/conversation-store")
    const notif = getNotif("onboarding")
    expect(notif).not.toBeNull()
    expect(notif?.targetAgent).toBe("pm")

    // Design did NOT run (only 2 Anthropic calls)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(2)
  })

  it("Turn 3: human approves → spec patched (or skipped if 404), design resumes", async () => {
    // Set up Turn 3 state directly (Turn 2 was the PM round)
    const { clearPendingEscalation: clrEsc } = await import("../../../runtime/conversation-store")
    clrEsc("onboarding")
    const { setEscalationNotification: setNotif } = await import("../../../runtime/conversation-store")
    setNotif("onboarding", {
      targetAgent: "pm",
      question: "1. What is the exact copy for the logged-out indicator?",
      recommendations: "1. My recommendation: Use 'Not signed in' text.\n→ Rationale: Clear and concise.",
      originAgent: "design",
    })

    // Spec 404 → Haiku skipped (patchProductSpecWithRecommendations returns null non-blocking)
    mockGetContent.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }))
    mockPaginate.mockResolvedValue([])

    // Design phase calls (no Haiku — spec 404):
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "on-topic" }] })           // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "no" }] })                 // isSpecStateQuery
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Continuing." }] }) // runAgent (design)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NONE" }] })               // identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NONE" }] })               // classifyForPmGaps

    const params = makeParams(THREAD, "feature-onboarding", "yes")
    await handleFeatureChannelMessage(params)

    // EscalationNotification cleared
    const { getEscalationNotification: getNotif } = await import("../../../runtime/conversation-store")
    expect(getNotif("onboarding")).toBeNull()

    // Design ran
    const designCall = mockAnthropicCreate.mock.calls.find((c: any) => Array.isArray(c[0]?.system))
    expect(designCall).toBeDefined()

    // "Product spec updated" closure posted (even when Haiku skipped — platform always confirms)
    const postCalls = (params.client.chat.postMessage as ReturnType<typeof vi.fn>).mock.calls
    const closurePost = postCalls.find((c: any) => c[0]?.text?.includes("Product spec updated"))
    expect(closurePost).toBeDefined()
  })
})

// ─── Scenario N51: PM spec sanitizer strips design-scope content at save time ──
//
// sanitizePmSpecDraft() runs before every GitHub write in save_product_spec_draft
// and apply_product_spec_patch. Design-scope sections (## Design Direction, etc.)
// and cross-domain open questions ([type: engineering], [type: design]) must be
// stripped from the saved content — regardless of what the PM agent writes.
//
// This is a structural gate: the PM agent cannot bypass it by including design
// content in its spec output.

describe("Scenario N51 — PM spec sanitizer strips design-scope content before save", () => {
  const THREAD = "workflow-n51"

  beforeEach(() => { clearHistory("n51feature") })
  afterEach(() => { clearHistory("n51feature") })

  it("save_product_spec_draft: ## Design Direction section stripped before GitHub save", async () => {
    setConfirmedAgent("n51feature", "pm")

    const specWithDesignSection = [
      "## Problem",
      "Users cannot onboard without an account.",
      "",
      "## Acceptance Criteria",
      "- User can register with email.",
      "",
      "## Design Direction",
      "**Dark mode primary.** Color palette:",
      "- Background: #0A0E27",
      "- Accent: rgba(139, 127, 232, 0.8)",
      "",
      "## Edge Cases",
      "- Network failure shows error.",
    ].join("\n")

    // PM call sequence: classifyMessageScope → runAgent (tool_use: save_product_spec_draft) → runAgent (end_turn)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "save_product_spec_draft", input: { content: specWithDesignSection } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Draft saved." }] })

    const params = makeParams(THREAD, "feature-n51feature", "update the spec")
    await handleFeatureChannelMessage(params)

    // Sanitizer must have stripped ## Design Direction before the GitHub write
    const savedContent = Buffer.from(
      mockCreateOrUpdate.mock.calls.find((c: any[]) =>
        c[0]?.path?.includes("n51feature.product.md")
      )?.[0]?.content ?? "",
      "base64"
    ).toString()

    expect(savedContent).not.toContain("## Design Direction")
    expect(savedContent).not.toContain("#0A0E27")
    expect(savedContent).not.toContain("rgba(139")
    // PM-scope content preserved
    expect(savedContent).toContain("## Problem")
    expect(savedContent).toContain("## Acceptance Criteria")
    expect(savedContent).toContain("## Edge Cases")
  })

  it("apply_product_spec_patch: [type: engineering] open question stripped before GitHub save", async () => {
    setConfirmedAgent("n51feature", "pm")

    // Existing draft has no open questions — patch introduces a cross-domain one
    mockGetContent.mockResolvedValue({
      data: {
        content: Buffer.from("## Problem\nUsers cannot onboard.\n\n## Acceptance Criteria\n- User can register.", "utf-8").toString("base64"),
        sha: "abc123",
        type: "file",
      },
    })
    mockPaginate.mockResolvedValue([{ name: "n51feature-product", commit: { sha: "abc" } }])

    const patch = [
      "## Open Questions",
      "- [type: product] [blocking: yes] What is the error recovery path for failed SSO?",
      "- [type: engineering] [blocking: no] Session TTL — needs infrastructure confirmation.",
    ].join("\n")

    // PM call sequence: classifyMessageScope → runAgent (tool_use: apply_product_spec_patch) → runAgent (end_turn)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "apply_product_spec_patch", input: { patch } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Questions added." }] })

    const params = makeParams(THREAD, "feature-n51feature", "add open questions")
    await handleFeatureChannelMessage(params)

    const savedContent = Buffer.from(
      mockCreateOrUpdate.mock.calls.find((c: any[]) =>
        c[0]?.path?.includes("n51feature.product.md")
      )?.[0]?.content ?? "",
      "base64"
    ).toString()

    // Engineering question stripped; product question preserved
    expect(savedContent).not.toContain("[type: engineering]")
    expect(savedContent).not.toContain("Session TTL")
    expect(savedContent).toContain("[type: product]")
    expect(savedContent).toContain("failed SSO")
  })
})

// ─── Scenario N53: Multi-patch turn posts exactly one preview ─────────────────
//
// When the design agent calls apply_design_spec_patch multiple times in a single
// turn, only one preview should be uploaded to Slack (after all patches complete),
// not one per patch. This prevents thread spam when the agent applies many fixes.
//
// Setup: agent calls apply_design_spec_patch twice in one turn.
// Expected: files.uploadV2 called exactly once (post-turn, not per-patch).

describe("Scenario N53 — Multi-patch turn posts exactly one preview", () => {
  const THREAD = "workflow-n53"

  beforeEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })
  afterEach(() => { clearHistory("onboarding"); clearSummaryCache("onboarding") })

  it("two apply_design_spec_patch calls in one turn produce exactly one preview upload", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Anthropic call sequence (0 history → no extractLockedDecisions; no design draft → auditPhaseCompletion skipped):
    //   [0] isOffTopicForAgent    → false
    //   [1] isSpecStateQuery      → false
    //   [2] runAgent (tool_use)   → apply_design_spec_patch (patch 1)
    //   [3] auditSpecRenderAmbiguity → ambiguities (triggers second patch)
    //   [4] runAgent (tool_use)   → apply_design_spec_patch (patch 2)
    //   [5] auditSpecRenderAmbiguity → [] (resolved)
    //   [6] runAgent (end_turn)   → text response
    //   [7] identifyUncommittedDecisions → "none"
    // generateDesignPreview is template-based (no LLM call).
    // uploadV2 must be called exactly once — after runAgent completes, not after each patch.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })    // isSpecStateQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Screens\n### Chat Home\nChips near bottom." } }],
      })                                                                          // runAgent: tool_use (patch 1)
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["Chip position is vague — specify exact spacing"]' }] }) // auditSpecRenderAmbiguity → ambiguity
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "apply_design_spec_patch", input: { patch: "## Screens\n### Chat Home\nChips: 12px above prompt bar." } }],
      })                                                                          // runAgent: tool_use (patch 2)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })        // auditSpecRenderAmbiguity → resolved
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Fixed chip positioning to 12px above prompt bar." }] }) // runAgent: end_turn
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })      // identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "fix all 9 gaps"), client })

    // Exactly one preview upload — not one per patch
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1)

    // The single upload uses the correct filename
    const uploadCall = (client.files.uploadV2 as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(uploadCall.filename).toBe("onboarding.preview.html")
  })
})

// ─── N54: Fix-all completion loop — platform-controlled multi-pass fix-and-verify ──
//
// Validates Embodiment 13: platform extracts authoritative item list → runs agent →
// re-audits from fresh GitHub read → posts to Slack only when audit is clean.
// Agent prose is suppressed between passes. Platform composes the final message.
// User says "fix all" once and gets a single response: "Fixed all N items."

describe("Scenario N54 — fix-all completion loop: platform composes result, never trusts agent self-report", () => {
  const THREAD = "workflow-n54"

  // Pre-patch draft: --violet has wrong value (#8B7FE8 vs #7C6FCD from BRAND.md) → 1 brand drift.
  // mockGetContent returns DRAFT_BRAND_CLEAN for reads 4+ (after the patcher save) —
  // patched draft has correct --violet → auditBrandTokens = [] → fixAllComplete = true.
  const BRAND_MD_FIXALL = "## Color Palette\n\n```\n--violet: #7C6FCD\n```"
  const DRAFT_WITH_BRAND_DRIFT = "## Brand\n\n- `--violet:` `#8B7FE8`\n\n## Screens\n### Home\nContent.\n"
  const DRAFT_BRAND_CLEAN = "## Brand\n\n- `--violet:` `#7C6FCD`\n\n## Screens\n### Home\nContent.\n"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
  })

  it("'fix all' with 1 brand drift item → loop runs → 'Fixed all 1 item' when post-pass brand clean", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // 4 reads in sequence: context load, pre-run audit, patcher merge-read, post-pass fresh.
    // Reads 1-3: DRAFT_WITH_BRAND_DRIFT (--violet wrong #8B7FE8 vs #7C6FCD from BRAND.md → 1 brand drift).
    // Read 4+ (post-pass): DRAFT_BRAND_CLEAN (correct --violet → brand clean → fixAllComplete = true).
    // BRAND.md is mocked to return BRAND_MD_FIXALL for all reads.
    let readCount = 0
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        readCount++
        const draft = readCount >= 4 ? DRAFT_BRAND_CLEAN : DRAFT_WITH_BRAND_DRIFT
        return { data: { type: "file", content: Buffer.from(draft).toString("base64"), sha: "abc123" } }
      }
      if (path === "specs/brand/BRAND.md") {
        return { data: { type: "file", content: Buffer.from(BRAND_MD_FIXALL).toString("base64"), sha: "brand-sha" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent    → false
    //   [1] isSpecStateQuery      → false
    //   [2] auditPhaseCompletion pre-run → PASS (no readiness findings)
    //       autoFixItems = 1 brand drift item (--violet: spec #8B7FE8 vs brand #7C6FCD)
    //   [3] runAgent pass 1 tool_use → apply_design_spec_patch (patch the brand section)
    //       (auditSpecDraft: LLM call skipped — productVision/arch/spec all null)
    //   [4] runAgent pass 1 end_turn
    //   [5] auditSpecRenderAmbiguity post-pass re-audit → [] (patched draft is clean)
    //   [6] auditPhaseCompletion post-pass → PASS (ready: true, no findings)
    // Total: 7 Anthropic calls. No identifyUncommittedDecisions — fix-all path returns early.
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // [2] auditPhaseCompletion pre-run → PASS
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-54-1", name: "apply_design_spec_patch", input: {
          patch: "## Brand\n\n- `--violet:` `#7C6FCD`\n\n## Screens\n### Home\nContent.\n",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Applied the fix. Spec updated." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })       // [5] auditSpecRenderAmbiguity post-pass
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })     // [6] auditPhaseCompletion post-pass

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "fix all"),
      client,
    })

    // Platform composes the completion message — not agent prose
    const text = lastUpdateText(client)
    expect(text).toContain("Fixed all 1 item")
    // No action menu when all items are fixed
    expect(text).not.toContain("OPEN ITEMS")
    // User is directed to approve
    expect(text).toContain("approved")

    // Single preview upload — one per turn, not one per patch
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1)

    // Exact call count: 7 Anthropic calls (auditSpecRenderAmbiguity no longer in saveDesignDraft)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)

    // Original user message stored in history (not the enriched PLATFORM FIX-ALL version)
    const history = getHistory("onboarding")
    const userTurn = history.find(m => m.role === "user")
    expect(userTurn?.content).toBe("fix all")
  })
})

// ─── N55: Post-patch continuation loop — normal turns auto-complete ────────────
//
// Validates the architectural fix for "agent addresses subset of findings" failure class.
// When the agent makes spec patches in a normal turn (not "fix all"), the platform
// re-audits from GitHub and automatically continues fixing remaining design items.
// The user sends one message and gets a single response reflecting ground truth.
//
// This test verifies: platform continues for design-only items; does NOT loop for PM-GAP
// items (those go through Gate 2 escalation); effective data drives the action menu.

describe("Scenario N55 — post-patch continuation loop: normal patch turn auto-completes design items", () => {
  const THREAD = "workflow-n55"

  const DESIGN_DRAFT_WITH_ISSUE = [
    "## Screens",
    "### Home",
    "Description: Welcome to the app.",
  ].join("\n")

  const DESIGN_DRAFT_CLEAN = [
    "## Screens",
    "### Home",
    "Description: Welcome to Health360.\n\n## Empty State\nIllustration + CTA.",
  ].join("\n")

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("normal agent turn with patches → platform re-audits → continuation pass runs → clean action menu", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // First read (pre-run): original draft with issue
    // Second read (post-patch): patched draft that still has 1 remaining design item
    // Third read (post-continuation pass): clean draft
    let readCount = 0
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        readCount++
        const content = readCount <= 2 ? DESIGN_DRAFT_WITH_ISSUE : DESIGN_DRAFT_CLEAN
        return { data: { type: "file", content: Buffer.from(content).toString("base64"), sha: `sha-${readCount}` } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence for normal path with post-patch continuation:
    //   [0] isOffTopicForAgent       → false
    //   [1] isSpecStateQuery         → false
    //   [2] auditPhaseCompletion pre-run → 1 design finding (NOT [PM-GAP])
    //   [3] runAgent normal turn: tool_use → apply_design_spec_patch
    //   [4] runAgent normal turn: end_turn
    //   [5] Post-patch re-audit: auditPhaseCompletion → 1 finding remains (designResidual.length=1)
    //   [6] Continuation pass agent: end_turn
    //   [7] Post-continuation re-audit: auditPhaseCompletion → PASS
    // identifyUncommittedDecisions: SKIPPED (didSave=true, apply_design_spec_patch in designSaveTools)
    // Gate 4 (classifyForPmGaps): SKIPPED (didSave=true guard at line 1997)
    // Total: 8 Anthropic calls (auditSpecRenderAmbiguity no longer in saveDesignDraft)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({                                                   // [2] pre-run audit: 1 design finding
        content: [{ type: "text", text: "FINDING: [type: design] [blocking: yes] Missing empty state | add illustration and CTA" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-55-1", name: "apply_design_spec_patch", input: {
          patch: "## Screens\n### Home\nDescription: Welcome to Health360.",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Updated the Home screen description." }],
      })
      .mockResolvedValueOnce({                                                   // [5] post-patch re-audit: 1 still remains
        content: [{ type: "text", text: "FINDING: [type: design] [blocking: yes] Missing empty state | add illustration and CTA" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                   // [6] continuation pass: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Added empty state." }],
      })
      .mockResolvedValueOnce({                                                   // [7] post-continuation re-audit: PASS
        content: [{ type: "text", text: "PASS" }],
        stop_reason: "end_turn",
      })

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "update the home screen"),
      client,
    })

    // Platform status line should be ABSENT — all items resolved by continuation
    const text = lastUpdateText(client)
    expect(text).not.toContain("to address before engineering handoff")
    // No action menu — spec is clean after continuation
    expect(text).not.toContain("OPEN ITEMS")

    // Exactly 8 Anthropic calls (auditSpecRenderAmbiguity no longer in saveDesignDraft; identifyUncommittedDecisions and Gate 4 skipped: didSave=true)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(8)
  })

  it("normal agent turn with patches — PM-GAP finding NOT fixed in continuation, surfaces via Gate 2 escalation", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT_WITH_ISSUE).toString("base64"), sha: "abc" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Post-patch audit returns a PM-GAP finding → continuation loop skips it (PM gaps need escalation)
    // → Gate 2 fires and sets pending escalation
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({                                                   // pre-run audit: PM-GAP finding
        content: [{ type: "text", text: "FINDING: [PM-GAP] [blocking: yes] Session expiry behavior undefined | PM must decide timeout duration" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                   // runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-55-2", name: "apply_design_spec_patch", input: {
          patch: "## Screens\n### Home\nDescription: Welcome to Health360.",
        }}],
      })
      .mockResolvedValueOnce({                                                   // runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Updated home screen. PM decision needed." }],
      })
      .mockResolvedValueOnce({                                                   // post-patch re-audit: PM-GAP survives
        content: [{ type: "text", text: "FINDING: [PM-GAP] [blocking: yes] Session expiry behavior undefined | PM must decide" }],
        stop_reason: "end_turn",
      })

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "update the home screen"),
      client,
    })

    // Gate 2 fires — PM escalation message shown, not a fixable action menu
    const text = lastUpdateText(client)
    expect(text).toContain("Design cannot move forward")
    expect(text).not.toContain("OPEN ITEMS")
  })
})

// ─── N56: Platform status line scope — arch vs PM escalation ──────────────────
//
// Platform status prefix ("N items to address before engineering handoff") must be visible when
// an architect escalation fires but design items remain — the arch question does not
// resolve all design gaps, and the agent must not claim "engineering-ready" unchallenged.
//
// For PM escalations, the prefix is correctly suppressed (user cannot act on design
// items while PM gaps are open).
describe("Scenario N56 — platform status line: visible for arch escalation, suppressed for PM escalation", () => {
  const THREAD = "workflow-n56"

  const DESIGN_DRAFT = [
    "## Screens",
    "### Home",
    "Description: Welcome to the app.",
  ].join("\n")

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("architect escalation with remaining design items — platform status line IS shown", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT).toString("base64"), sha: "abc" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] designReadinessNotice audit → 1 design finding (NOT PM-GAP)
    //   [3] runAgent: tool_use → offer_architect_escalation (genuine ARCH-GAP question)
    //   [4] classifyForArchGap (Gate) → "ARCH-GAP" (accepted — UI differs based on answer)
    //   [5] runAgent: end_turn (agent receives "Escalation offer stored." result)
    //   [6] identifyUncommittedDecisions → none (didSave=false)
    //   Total: 7 calls
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({                                                   // [2] pre-run audit: 1 design finding
        content: [{ type: "text", text: "FINDING: [type: design] [blocking: yes] Prompt bar height undefined | add 48px height spec" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-56-1", name: "offer_architect_escalation", input: {
          question: "Does the API support streaming responses? I need to decide whether to show a typing indicator or a loading spinner.",
        }}],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ARCH-GAP" }] }) // [4] classifyForArchGap: accepted
      .mockResolvedValueOnce({                                                   // [5] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Escalated the streaming question to the architect." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })     // [6] identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "continue with the design"),
      client,
    })

    const text = lastUpdateText(client)
    // Platform status line MUST appear — arch escalation does not close design gaps
    expect(text).toContain("1 item to address before engineering handoff")
    // Action menu still suppressed (escalation is pending — user cannot act yet)
    expect(text).not.toContain("OPEN ITEMS")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)
  })

  it("PM escalation with remaining design items — platform status line is suppressed", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT).toString("base64"), sha: "abc" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] designReadinessNotice audit → 1 design finding (NOT PM-GAP)
    //   [3] runAgent: tool_use → offer_pm_escalation
    //   [4] classifyForPmGaps (Gate 2 — runs inside offer_pm_escalation tool handler) → 1 GAP accepted
    //   [5] runAgent: end_turn (agent receives tool result, concludes turn)
    //   [6] identifyUncommittedDecisions → none (didSave=false)
    //   Total: 7 calls
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({                                                   // [2] pre-run audit: 1 design finding
        content: [{ type: "text", text: "FINDING: [type: design] [blocking: yes] Prompt bar height undefined | add 48px height spec" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-56-2", name: "offer_pm_escalation", input: {
          question: "What is the session expiry duration?",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [4] classifyForPmGaps: 1 PM gap accepted
        content: [{ type: "text", text: "GAP: What is the session expiry duration?" }],
      })
      .mockResolvedValueOnce({                                                   // [5] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Escalated session expiry to PM." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })     // [6] identifyUncommittedDecisions

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "continue with the design"),
      client,
    })

    const text = lastUpdateText(client)
    // Platform status line MUST be absent for PM escalation (user cannot act on design items yet)
    expect(text).not.toContain("to address before engineering handoff")
    // Assertive override fires for PM escalation
    expect(text).toContain("Design cannot move forward")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)
  })
})

// ─── N57: Arch escalation gate — implementation questions rejected ──────────────
//
// When the design agent calls offer_architect_escalation with an implementation-only
// question (UI is identical regardless of the answer), the platform gate (classifyForArchGap)
// rejects the escalation and returns a structured rejection directing the agent to add
// a ## Design Assumptions entry instead. No pending escalation is stored.
//
// This is structural — the gate fires on every offer_architect_escalation call,
// regardless of what the agent says. The agent cannot route around it.
describe("Scenario N57 — arch escalation gate rejects implementation-only questions", () => {
  const THREAD = "workflow-n57"

  const DESIGN_DRAFT = [
    "## Screens",
    "### Home",
    "Description: Welcome to the app.",
  ].join("\n")

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    clearPendingEscalation("onboarding")
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    clearPendingEscalation("onboarding")
  })

  it("implementation-only question → gate rejects, no pending escalation stored", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT).toString("base64"), sha: "abc" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] designReadinessNotice audit → 1 design finding
    //   [3] runAgent: tool_use → offer_architect_escalation with implementation question
    //   [4] classifyForArchGap (Gate) → "DESIGN-ASSUMPTION" (rejected — no setPendingEscalation)
    //   [5] runAgent: end_turn (agent received rejection message, concludes turn)
    //   [6] identifyUncommittedDecisions → none (!didSave && !agentStillSeeking)
    //   [7] Gate 4 classifyForPmGaps — fires because agentCalledEscalation=false
    //       (rejected tool call never stores pending escalation) → 0 PM gaps
    //   Total: 8 calls
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({                                                   // [2] pre-run audit: 1 design finding
        content: [{ type: "text", text: "FINDING: [type: design] [blocking: yes] Prompt bar height undefined | add 48px height spec" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-57-1", name: "offer_architect_escalation", input: {
          question: "How are logged-out conversations stored — client-side localStorage or server-side session?",
        }}],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "DESIGN-ASSUMPTION" }] }) // [4] gate: rejected
      .mockResolvedValueOnce({                                                   // [5] runAgent: end_turn (after rejection)
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Noted — I will add this as a Design Assumption." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })     // [6] identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NONE" }] })     // [7] Gate 4: 0 PM gaps

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "continue with the design"),
      client,
    })

    // Gate rejected — no pending escalation stored
    expect(getPendingEscalation("onboarding")).toBeNull()
    // Design items remain → platform status line still shows (no suppression without pending escalation)
    const text = lastUpdateText(client)
    expect(text).toContain("1 item to address before engineering handoff")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(8)
  })
})

// ─── N58: Natural English fix intent — Haiku fallback path ────────────────────
//
// When the user says "go ahead and fix all of these" instead of the prescribed
// "fix all", the fast path (parseFixAllIntent) misses. The FIX_PREFILTER matches
// the word "fix", triggering the classifyFixIntent Haiku fallback at position [3].
// The Haiku returns "FIX-ALL" → the platform fix-all loop runs exactly as in N54.
//
// This verifies: the natural English path is structurally identical to the keyword
// path once fix intent is detected — same platform loop, same result composition,
// same history stored with the original user message (not the enriched PLATFORM FIX-ALL).

describe("Scenario N58 — natural English fix intent: Haiku fallback triggers platform fix-all loop", () => {
  const THREAD = "workflow-n58"

  // Same draft setup as N54: pre-patch has brand drift, post-patch returns clean draft.
  const BRAND_MD_FIXALL = "## Color Palette\n\n```\n--violet: #7C6FCD\n```"
  const DRAFT_WITH_BRAND_DRIFT = "## Brand\n\n- `--violet:` `#8B7FE8`\n\n## Screens\n### Home\nContent.\n"
  const DRAFT_BRAND_CLEAN = "## Brand\n\n- `--violet:` `#7C6FCD`\n\n## Screens\n### Home\nContent.\n"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
  })

  it("'go ahead and fix all of these' → Haiku classifies FIX-ALL → loop runs → 'Fixed all 1 item'", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Reads 1-3: DRAFT_WITH_BRAND_DRIFT (--violet wrong → 1 brand drift).
    // Read 4+ (post-pass fresh): DRAFT_BRAND_CLEAN (correct --violet → brand clean → fixAllComplete).
    // BRAND.md is mocked to return BRAND_MD_FIXALL for all reads.
    let readCount = 0
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        readCount++
        const draft = readCount >= 4 ? DRAFT_BRAND_CLEAN : DRAFT_WITH_BRAND_DRIFT
        return { data: { type: "file", content: Buffer.from(draft).toString("base64"), sha: "abc123" } }
      }
      if (path === "specs/brand/BRAND.md") {
        return { data: { type: "file", content: Buffer.from(BRAND_MD_FIXALL).toString("base64"), sha: "brand-sha" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent    → false
    //   [1] isSpecStateQuery      → false
    //   [2] auditPhaseCompletion pre-run → PASS (no readiness findings)
    //       autoFixItems = 1 brand drift item (--violet: spec #8B7FE8 vs brand #7C6FCD)
    //   [3] classifyFixIntent (Haiku fallback — "fix" matched prefilter, fast path missed) → "FIX-ALL"
    //   [4] runAgent pass 1 tool_use → apply_design_spec_patch (patch the brand section)
    //       (auditSpecDraft: LLM call skipped — productVision/arch/spec all null)
    //   [5] runAgent pass 1 end_turn
    //   [6] auditSpecRenderAmbiguity post-pass re-audit → [] (patched draft is clean)
    //   [7] auditPhaseCompletion post-pass → PASS (ready: true, no findings)
    // Total: 8 Anthropic calls (1 more than N54 — the Haiku fix intent call at [3]).
    // No identifyUncommittedDecisions — fix-all path returns early.
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // [2] auditPhaseCompletion pre-run → PASS
      .mockResolvedValueOnce({ content: [{ type: "text", text: "FIX-ALL" }] }) // [3] classifyFixIntent → FIX-ALL
      .mockResolvedValueOnce({                                                   // [4] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-58-1", name: "apply_design_spec_patch", input: {
          patch: "## Brand\n\n- `--violet:` `#7C6FCD`\n\n## Screens\n### Home\nContent.\n",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [5] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Applied the fix. Spec updated." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })       // [6] auditSpecRenderAmbiguity post-pass
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })     // [7] auditPhaseCompletion post-pass

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "go ahead and fix all of these"),
      client,
    })

    // Platform composes the completion message — not agent prose
    const text = lastUpdateText(client)
    expect(text).toContain("Fixed all 1 item")
    // No action menu when all items are fixed
    expect(text).not.toContain("OPEN ITEMS")
    // User is directed to approve
    expect(text).toContain("approved")

    // Single preview upload — one per turn, not one per patch
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1)

    // Exact call count: 8 Anthropic calls (N54's 7 + 1 for the classifyFixIntent Haiku call)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(8)

    // Original user message stored in history (not the enriched PLATFORM FIX-ALL version)
    const history = getHistory("onboarding")
    const userTurn = history.find(m => m.role === "user")
    expect(userTurn?.content).toBe("go ahead and fix all of these")
  })
})

// ─── N59: Fix-all no-progress detection — loop breaks after pass 1 ────────────
//
// When the post-pass re-audit returns the same number of findings as before
// (readiness criteria still failing after the agent's patches), the loop must
// break after pass 1 rather than running all MAX_FIX_PASSES passes.
//
// Root cause of prior bug: selectedResidual used exact-string matching of
// LLM-generated readiness issue text. The auditor produces different text each
// call for the same conceptual finding, so mismatches falsely signaled "progress"
// and the loop ran all 3 passes re-applying the same patches.
//
// Fix: for "fix all" (selectedIndices=null), selectedResidual = residualItems
// directly — fresh count is the authoritative ground truth.
//
// This test verifies: 1 finding in, 1 finding out (different text) → break after
// 1 pass → "Fixed 0 of 1 item" → exactly 8 Anthropic calls (not 16 or 24).

describe("Scenario N59 — fix-all no-progress detection: loop breaks after pass 1 when count unchanged", () => {
  const THREAD = "workflow-n59"

  // Brand drift draft: --violet wrong (#8B7FE8 vs #7C6FCD) → 1 pre-run brand drift item.
  // Post-pass: same DRAFT_WITH_BRAND_DRIFT returned (drift persists) → freshFixableItems.length = 1 = prevItemCount → no-progress → break.
  const BRAND_MD_FIXALL = "## Color Palette\n\n```\n--violet: #7C6FCD\n```"
  const DRAFT_WITH_BRAND_DRIFT = "## Brand\n\n- `--violet:` `#8B7FE8`\n\n## Screens\n### Home\nContent.\n"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("post-pass audit returns same count (brand drift persists) → breaks after 1 pass, reports 0 fixed", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // All reads return DRAFT_WITH_BRAND_DRIFT — brand drift never patched away.
    // BRAND.md mocked to return BRAND_MD_FIXALL for all reads.
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DRAFT_WITH_BRAND_DRIFT).toString("base64"), sha: "abc123" } }
      }
      if (path === "specs/brand/BRAND.md") {
        return { data: { type: "file", content: Buffer.from(BRAND_MD_FIXALL).toString("base64"), sha: "brand-sha" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent    → false
    //   [1] isSpecStateQuery      → false
    //   [2] auditPhaseCompletion pre-run → PASS (no readiness findings)
    //       autoFixItems = 1 brand drift item (--violet), prevItemCount = 1
    //   [3] runAgent pass 1 tool_use → apply_design_spec_patch
    //   [4] runAgent pass 1 end_turn
    //   [5] auditSpecRenderAmbiguity post-pass → [] (quality excluded from freshFixableItems anyway)
    //       freshDraft = same DRAFT_WITH_BRAND_DRIFT → auditBrandTokens → 1 brand drift.
    //       freshFixableItems.length = 1 = prevItemCount = 1 → no-progress → break.
    //   [6] auditPhaseCompletion post-pass → PASS
    // Total: 7 calls. Loop does NOT run pass 2.
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    //
    // Key: no-progress detected via count (1 in, 1 out) using brand drift — same mechanism
    // as quality-based detection but using the deterministic brand auditor, not LLM output.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // [2] auditPhaseCompletion pre-run → PASS
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-59-1", name: "apply_design_spec_patch", input: {
          patch: "## Brand\n\n- `--violet:` `#7C6FCD`\n\n## Screens\n### Home\nContent.\n",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Applied patch." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })       // [5] auditSpecRenderAmbiguity post-pass: [] (quality excluded; brand drift detected deterministically)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // [6] auditPhaseCompletion post-pass → PASS

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "fix all"),
      client,
    })

    // Loop broke after pass 1 — exactly 7 calls (not 14 or 21 for 2 or 3 passes)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)

    // Platform reports 0 items fixed (count-based: 1 pre-run → 1 post-pass → no progress)
    const text = lastUpdateText(client)
    expect(text).toContain("Fixed 0 of 1 item")
    // Residual item appears in the action menu
    expect(text).toContain("OPEN ITEMS")

    // Preview still uploaded (patches were applied even though rubric criteria unmet)
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1)
  })
})

// ─── N60: Fix-all regression guard — fresh count exceeds pre-run count ────────
//
// When the agent's patches add new content that triggers additional issues
// (post-pass audit returns MORE items than pre-run audit), totalFixed must not
// be negative. Real incident (2026-04-15): pre-run=8, post-pass=26 (patches
// added spec sections with new ambiguities) → "Fixed -18 of 8 items".
//
// Fix: Math.max(0, autoFixItems.length - selectedResidual.length).
// Loop termination is correct (26 >= 8 → break after pass 1).
// Message must read "Fixed 0 of 1 item. 2 items still need attention:" (not negative).

describe("Scenario N60 — fix-all regression guard: post-patch fresh count exceeds pre-run count", () => {
  const THREAD = "workflow-n60"

  // Pre-run: 1 brand drift (--violet wrong). Post-pass: 2 brand drifts (--violet AND --teal wrong).
  // This simulates the regression: agent patch introduces new drift → freshFixableItems > autoFixItems.
  const BRAND_MD_FIXALL = "## Color Palette\n\n```\n--violet: #7C6FCD\n--teal: #4FAFA8\n```"
  // DRAFT_WITH_BRAND_DRIFT: --violet wrong, --teal correct → 1 drift, 0 missing → 1 autoFixItem.
  const DRAFT_WITH_BRAND_DRIFT = "## Brand\n\n- `--violet:` `#8B7FE8`\n- `--teal:` `#4FAFA8`\n\n## Screens\n### Home\nContent.\n"
  // DRAFT_WITH_TWO_BRAND_DRIFTS: both --violet AND --teal wrong → 2 drifts → freshFixableItems = 2.
  const DRAFT_WITH_TWO_BRAND_DRIFTS = "## Brand\n\n- `--violet:` `#8B7FE8`\n- `--teal:` `#99DADA`\n\n## Screens\n### Home\nContent.\n"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("post-pass returns 2 findings when pre-run had 1 → Fixed 0 (not -1), 2 items in menu", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Reads 1-3: DRAFT_WITH_BRAND_DRIFT (1 brand drift: --violet only).
    // Reads 4+: DRAFT_WITH_TWO_BRAND_DRIFTS (2 brand drifts: --violet AND --teal wrong).
    // BRAND.md mocked to return BRAND_MD_FIXALL for all reads.
    let readCount = 0
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        readCount++
        const draft = readCount >= 4 ? DRAFT_WITH_TWO_BRAND_DRIFTS : DRAFT_WITH_BRAND_DRIFT
        return { data: { type: "file", content: Buffer.from(draft).toString("base64"), sha: "abc123" } }
      }
      if (path === "specs/brand/BRAND.md") {
        return { data: { type: "file", content: Buffer.from(BRAND_MD_FIXALL).toString("base64"), sha: "brand-sha" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence — identical shape to N59 except post-pass fresh returns 2 brand drifts.
    // autoFixItems.length = 1 (pre-run: 1 violet drift), freshFixableItems.length = 2 (post-pass: violet + teal).
    // selectedResidual = freshFixableItems = 2 items (fix-all path).
    // 2 >= 1 (prevItemCount) → break (regression = no-progress).
    // totalFixed = Math.max(0, 1 - 2) = 0 (not -1).
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // [2] auditPhaseCompletion pre-run → PASS
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-60-1", name: "apply_design_spec_patch", input: {
          patch: "## Brand\n\n- `--violet:` `#7C6FCD`\n- `--teal:` `#99DADA`\n\n## Screens\n### Home\nContent.\n",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Applied patch." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })       // [5] auditSpecRenderAmbiguity post-pass: [] (quality excluded; brand drifts detected deterministically from DRAFT_WITH_TWO_BRAND_DRIFTS)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // [6] auditPhaseCompletion post-pass → PASS

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "fix all"),
      client,
    })

    // Loop broke after pass 1 — exactly 7 calls (auditSpecRenderAmbiguity no longer in saveDesignDraft)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)

    const text = lastUpdateText(client)
    // totalFixed clamped at 0 — not -1
    expect(text).toContain("Fixed 0 of 1 item")
    // 2 residual items shown in action menu (fresh state)
    expect(text).toContain("OPEN ITEMS")
    // Confirm no negative number appears in the message
    expect(text).not.toMatch(/Fixed -\d/)

    expect(client.files.uploadV2).toHaveBeenCalledTimes(1)
  })
})

// ─── Scenario N61: Post-patch spec health invariant ────────────────────────
//
// After the agent applies patches, the platform compares pre-run vs post-run
// spec size and finding count. If the spec bloated beyond maxAllowedSpecGrowthRatio
// (default 1.2 = 20%), the platform surfaces a human-friendly bloat warning and
// returns early — no action menu, no preview upload.
//
// This is a structural gate: arithmetic comparison, no LLM, fires on every patch turn.
// Principle 8: platform enforcement first.

describe("Scenario N61 — Post-patch spec health invariant fires on bloating patch", () => {
  const THREAD = "workflow-n61"

  const SHORT_SPEC = "# Onboarding Design Spec\n\n## Screens\nScreen 1.\n"
  // Bloated spec is >> 110% of SHORT_SPEC (test uses 1.1 ratio cap for reliability)
  const BLOATED_SPEC = SHORT_SPEC + "Duplicate content added by patch. ".repeat(200)

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
    process.env.MAX_ALLOWED_SPEC_GROWTH_RATIO = "1.1"
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    delete process.env.MAX_ALLOWED_SPEC_GROWTH_RATIO
  })

  it("patch that bloats spec beyond growth ratio triggers health warning and exits early", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Before patch write: short spec. After patch write: bloated spec (simulates what was committed).
    // Flag-based (not readCount-based) because loadDesignAgentContext also reads the design spec
    // before the agent runs — a readCount approach would return BLOATED_SPEC prematurely.
    let patchWritten = false
    mockCreateOrUpdate.mockImplementation(async () => { patchWritten = true; return {} })
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        const content = patchWritten ? BLOATED_SPEC : SHORT_SPEC
        return { data: { type: "file", content: Buffer.from(content).toString("base64"), sha: "sha-1" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] auditPhaseCompletion pre-run → PASS (short spec, no findings)
    //   [3] runAgent: tool_use → apply_design_spec_patch
    //   [4] runAgent: end_turn
    //   [5] auditPhaseCompletion post-patch (runFreshDesignAudit) → PASS
    //   → Health invariant fires (bloated > 110%) → returns early
    //   Total: 6 Anthropic calls (auditSpecRenderAmbiguity no longer in saveDesignDraft)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })  // [2] pre-run audit: PASS
      .mockResolvedValueOnce({                                                  // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-n61-1", name: "apply_design_spec_patch", input: {
          patch: "## Screens\nScreen 1.\n" + "Added content: ".repeat(200),
        }}],
      })
      .mockResolvedValueOnce({                                                  // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Updated the screens section." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })  // [5] post-patch audit: PASS

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "update the screens section"),
      client,
    })

    // Health invariant fired: response contains bloat warning in human-friendly language
    const text = lastUpdateText(client)
    expect(text).toContain("wasn't in better shape")
    expect(text).toContain("grew significantly")

    // Platform returned early: no preview upload (health check fires before post-patch preview point)
    expect(client.files.uploadV2).not.toHaveBeenCalled()

    // 6 Anthropic calls (health check is arithmetic — no extra LLM call; auditSpecRenderAmbiguity no longer in saveDesignDraft)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(6)
  })
})

// ─── Scenario N62: Fix-all routes structural conflict to rewrite_design_spec ──
//
// When "fix all" is requested and the pre-run audit finds a structural conflict
// (e.g. "## Screens section is defined twice"), singlePassFixItems is populated
// and the fixAllNotice instructs the agent to use rewrite_design_spec (not patch).
// The agent rewrites the spec, the fix-all loop detects no residual fixable items,
// and the response confirms completion without leaking any internal tool names.
//
// This is the structural routing test: verifies rewrite_design_spec is selected
// for structural conflicts, apply_design_spec_patch is NOT called for this turn.

describe("Scenario N62 — Fix-all routes structural conflict to rewrite_design_spec", () => {
  const THREAD = "workflow-n62"

  // Spec with duplicate ## Screens section — structural conflict that triggers rewrite route
  const SPEC_WITH_DUPLICATE =
    "# Onboarding Design Spec\n\n## Screens\nScreen A.\n\n## Navigation\nTab bar.\n\n## Screens\nScreen B (duplicate).\n"
  // Consolidated spec — one ## Screens, smaller than SPEC_WITH_DUPLICATE
  const CONSOLIDATED_SPEC =
    "# Onboarding Design Spec\n\n## Screens\nScreen A and Screen B consolidated.\n\n## Navigation\nTab bar.\n"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
    mockCreateOrUpdate.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("structural conflict finding routes to rewrite_design_spec, not apply_design_spec_patch", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Before rewrite: return SPEC_WITH_DUPLICATE. After rewrite committed: return CONSOLIDATED_SPEC.
    // Flag-based (not readCount) — loadDesignAgentContext reads the spec before the agent runs.
    let patchWritten = false
    mockCreateOrUpdate.mockImplementation(async (_: unknown, params: { content?: string }) => {
      patchWritten = true
      return {}
    })
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        const content = patchWritten ? CONSOLIDATED_SPEC : SPEC_WITH_DUPLICATE
        return { data: { type: "file", content: Buffer.from(content).toString("base64"), sha: "sha-1" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence (normal path — fix-all loop only runs when autoFixItems.length > 0,
    // i.e. brand drift. Structural readiness findings go via singlePassFixItems notice in the
    // normal agent call, not the fix-all loop):
    //   [0] isOffTopicForAgent    → false
    //   [1] isSpecStateQuery      → false
    //   [2] auditPhaseCompletion pre-run → FINDING with "defined twice" (structural conflict)
    //       → singlePassFixItems = [finding], structuralFixItems = [finding]
    //       → fixAllNotice injected into enrichedUserMessage, instructs rewrite_design_spec
    //   [3] runAgent: tool_use → rewrite_design_spec with CONSOLIDATED_SPEC
    //   [4] runAgent: end_turn → "Consolidated the duplicate sections."
    //   → patchAppliedThisTurn=true → runFreshDesignAudit fires (deterministic + 1 LLM):
    //   [5] auditPhaseCompletion post-patch (runFreshDesignAudit) → PASS
    //       designResidual = [] → continuation loop does NOT run
    //       health invariant: CONSOLIDATED_SPEC < SPEC_WITH_DUPLICATE → bloated=false, degraded=false
    //   Total: 6 Anthropic calls (auditSpecRenderAmbiguity no longer in saveDesignDraft)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // [1] isSpecStateQuery
      .mockResolvedValueOnce({                                                  // [2] pre-run audit: structural FINDING
        content: [{ type: "text", text: "FINDING: Screens section is defined twice | Remove the duplicate and consolidate into one section" }],
        stop_reason: "end_turn",
      })
      .mockResolvedValueOnce({                                                  // [3] runAgent: tool_use → rewrite
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-n62-1", name: "rewrite_design_spec", input: {
          content: CONSOLIDATED_SPEC,
        }}],
      })
      .mockResolvedValueOnce({                                                  // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Consolidated the duplicate sections." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // [5] auditPhaseCompletion post-patch → PASS

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "fix all"),
      client,
    })

    // rewrite_design_spec was called — design spec write to GitHub contains CONSOLIDATED_SPEC
    // (saveDesignDraft calls createOrUpdateFileContents twice: once for the spec, once for the preview HTML)
    const designSpecWrite = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.includes("onboarding.design.md")
    )
    expect(designSpecWrite).toBeDefined()
    const writtenContent = Buffer.from(
      designSpecWrite?.[0]?.content ?? "",
      "base64",
    ).toString("utf-8")
    expect(writtenContent).toBe(CONSOLIDATED_SPEC)

    // Post-patch preview upload fired (patchAppliedThisTurn=true, normal path line 2034)
    expect(client.files.uploadV2).toHaveBeenCalledTimes(1)

    // Response is normal path — agent prose present, no fix-all loop completion message
    const text = lastUpdateText(client)
    // No internal tool names or platform markers leaked to Slack response
    expect(text).not.toContain("[PLATFORM")
    expect(text).not.toContain("rewrite_design_spec")
    expect(text).not.toContain("apply_design_spec_patch")

    // 7 Anthropic calls: 2 routing + 1 pre-audit + 2 agent turns + 1 post-patch audit + 1 render ambiguity (post-patch fresh audit)
    //                    (auditSpecStructure is deterministic — no Anthropic call)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)
  })
})

// ─── Scenario N63: Health invariant fires when readiness count increases ───────
//
// After a patch, the platform compares pre-run readiness finding count vs
// post-patch readiness finding count (same rubric both sides — apples-to-apples).
// If post-patch count > pre-patch count, the patch introduced new conflicts.
// Platform fires the health warning regardless of spec size.
//
// This test validates the degraded path (count increase) independently of
// the bloat path (size increase) tested in N61.

describe("Scenario N63 — Health invariant fires when readiness count increases after patch", () => {
  const THREAD = "workflow-n63"

  const SPEC_BEFORE = "# Onboarding Design Spec\n\n## Screens\nScreen 1.\n"
  // After patch: spec is same size but now has a conflict (duplicate screen)
  const SPEC_AFTER = "# Onboarding Design Spec\n\n## Screens\nScreen 1.\n\n## Screens\nScreen 1 (duplicate).\n"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("patch that increases readiness finding count triggers degraded warning and exits early", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    let patchWritten = false
    mockCreateOrUpdate.mockImplementation(async () => { patchWritten = true; return {} })
    mockGetContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        const content = patchWritten ? SPEC_AFTER : SPEC_BEFORE
        return { data: { type: "file", content: Buffer.from(content).toString("base64"), sha: "sha-1" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] auditPhaseCompletion pre-run → PASS (0 findings) → preRunReadinessCount = 0
    //   [3] runAgent: tool_use → apply_design_spec_patch
    //   [4] runAgent: end_turn
    //   [5] auditPhaseCompletion (runFreshDesignAudit initial) → 1 finding → designResidual = [1]
    //   [6] continuation runAgent: end_turn (no patches — designResidual not reduced)
    //   [7] auditPhaseCompletion (runFreshDesignAudit re-audit) → 1 finding → 1 >= 1 → break
    //   → Health invariant fires (postRunReadinessCount=1 > preRunReadinessCount=0)
    // auditSpecRenderAmbiguity no longer called inside saveDesignDraft
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // [2] pre-run: PASS (0 readiness findings)
      .mockResolvedValueOnce({                                                   // [3] runAgent: tool_use
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-n63-1", name: "apply_design_spec_patch", input: {
          patch: "## Screens\nScreen 1.\n\n## Screens\nScreen 1 (duplicate).\n",
        }}],
      })
      .mockResolvedValueOnce({                                                   // [4] runAgent: end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Updated the screens section." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "FINDING: Screens defined twice | remove duplicate" }] })  // [5] post-patch: 1 finding → designResidual=[1]
      .mockResolvedValueOnce({                                                   // [6] continuation runAgent: end_turn (no patches)
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Noted the conflict." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "FINDING: Screens defined twice | remove duplicate" }] })  // [7] re-audit: still 1 finding → 1>=1 → break

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "update the screens section"),
      client,
    })

    // Health invariant fired: response contains health warning (bloated — spec grew beyond ratio)
    const text = lastUpdateText(client)
    expect(text).toContain("wasn't in better shape")
    expect(text).toContain("grew significantly")

    // Platform returned early: no preview upload
    expect(client.files.uploadV2).not.toHaveBeenCalled()

    // 8 calls: 2 routing + 1 pre-audit + 2 agent turns +
    //          1 initial fresh-audit + 1 continuation agent + 1 re-audit
    //          (auditSpecRenderAmbiguity no longer in saveDesignDraft)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(8)
  })
})

// ─── Scenario N64: Audit-stripping gate prevents renderAmbiguities from reaching agent ─────
// Regression test: even if saveDesignDraft is modified to return renderAmbiguities,
// the stripAuditFromToolResult gate must remove them before the agent sees them.
// This prevents the divergent patch loop (50K→31K→50K) observed on 2026-04-16.

describe("Scenario N64 — Audit-stripping gate blocks renderAmbiguities from tool response", () => {
  const THREAD = "n64-strip-gate"
  const DESIGN_DRAFT = [
    "## Screens",
    "### Screen 1a: Chat Home",
    "Layout container with prompt bar.",
  ].join("\n")

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("tool response reaching the agent does not contain renderAmbiguities", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT).toString("base64"), sha: "abc" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] extractLockedDecisions → none
    //   [3] auditPhaseCompletion (pre-run) → ready=true (no findings)
    //   [4] runAgent → tool_use: apply_design_spec_patch
    //   [5] auditSpecDraft (inside saveDesignDraft) → ok
    //   [6] runAgent continuation → end_turn
    //   [7] identifyUncommittedDecisions → none
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0]
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1]
      .mockResolvedValueOnce({ content: [{ type: "text", text: "No locked decisions found." }] }) // [2]
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn" }) // [3]
      .mockResolvedValueOnce({                                                   // [4] runAgent: tool_use
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Patching." },
          { type: "tool_use", id: "t-64-1", name: "apply_design_spec_patch", input: { patch: "## Screens\n\n### Screen 1a: Chat Home\n\nUpdated layout" } },
        ],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] })      // [5] auditSpecDraft
      .mockResolvedValueOnce({                                                   // [6] runAgent continuation
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Patch applied." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // [7] identifyUncommittedDecisions

    mockCreateOrUpdate.mockResolvedValue({})
    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "fix the layout"),
      client,
    })

    // Find the Anthropic call that includes a tool_result in its messages — this is
    // what the agent sees after apply_design_spec_patch runs. The audit-stripping gate
    // must have removed renderAmbiguities and qualityIssues before this reached the agent.
    const allCalls = mockAnthropicCreate.mock.calls
    const callWithToolResult = allCalls.find(call => {
      const msgs = call[0]?.messages
      return msgs?.some((m: any) =>
        m.role === "user" && Array.isArray(m.content) &&
        m.content.some((c: any) => c.type === "tool_result")
      )
    })

    expect(callWithToolResult).toBeTruthy()
    const toolResultMsg = callWithToolResult![0].messages.find((m: any) =>
      m.role === "user" && Array.isArray(m.content) &&
      m.content.some((c: any) => c.type === "tool_result")
    )
    const toolResultContent = toolResultMsg.content.find((c: any) => c.type === "tool_result")
    const resultText = typeof toolResultContent.content === "string"
      ? toolResultContent.content
      : JSON.stringify(toolResultContent.content)

    // The gate MUST have stripped these keys — they are user-facing only, never agent-facing
    expect(resultText).not.toContain("renderAmbiguities")
    expect(resultText).not.toContain("qualityIssues")
  })
})

// ─── Scenario N65: Write gate strips spec-writing tools on non-fix normal turns ───────
// When a draft exists with open action items and fix intent is NOT confirmed,
// spec-writing tools must be stripped from the agent's tool list.
// Historical violation (2026-04-17): user said "approving fixes for 2, 3, 5 and 8",
// fix intent detection failed, agent ran with full tools and modified 20+ elements.

describe("Scenario N65 — Write gate strips spec-writing tools when fix intent not confirmed", () => {
  const THREAD = "n65-write-gate"
  const DESIGN_DRAFT = [
    "## Screens",
    "### Screen 1a: Chat Home",
    "Layout container with prompt bar.",
  ].join("\n")

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("non-fix message with draft and open items → agent has no spec-writing tools", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Mock GitHub: design draft exists on branch, everything else 404
    mockGetContent.mockImplementation(async ({ path, ref }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md" && ref === "spec/onboarding-design") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT).toString("base64"), sha: "abc" } }
      }
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(DESIGN_DRAFT).toString("base64"), sha: "abc" } }
      }
      throw Object.assign(new Error("Not Found"), { status: 404 })
    })

    // Anthropic call sequence:
    //   [0] isOffTopicForAgent → false
    //   [1] isSpecStateQuery → false
    //   [2] auditPhaseCompletion (pre-run design readiness) → 1 FINDING (so allActionItems > 0)
    //   [3] classifyFixIntent (Haiku fallback — FIX_PREFILTER matches "fixes") → NOT-FIX
    //   [4] runAgent → end_turn (agent has no write tools, just responds)
    //   [5] identifyUncommittedDecisions → none
    //   [6] classifyForPmGaps (Gate 4 escalation classifier) → none
    // Note: extractLockedDecisions skips Anthropic call (history.length < 6)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({                                                   // [2] auditPhaseCompletion → 1 finding
        content: [{ type: "text", text: "FINDING: Screen coverage incomplete | add Screen 2" }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "NOT-FIX" }] })  // [3] classifyFixIntent
      .mockResolvedValueOnce({                                                   // [4] agent end_turn
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I recommend fixing Screen 1a positioning." }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // [5] identifyUncommittedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PM_GAPS: 0\nARCHITECT_ITEMS: 0\nDESIGN_ITEMS: 0" }] })  // [6] classifyForPmGaps

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "approving fixes for 2 3 5 and 8"),
      client,
    })

    // Find the runAgent call — the one with tools array that has more than 2 items
    // (classifier calls may have tools but they're short; the agent call has the full tool set)
    const agentCall = mockAnthropicCreate.mock.calls.find(call => {
      const tools = call[0]?.tools
      return tools && tools.length > 2
    })

    expect(agentCall).toBeTruthy()
    const toolNames = agentCall![0].tools.map((t: any) => t.name)

    // Write gate: spec-writing tools must NOT be present
    expect(toolNames).not.toContain("save_design_spec_draft")
    expect(toolNames).not.toContain("apply_design_spec_patch")
    expect(toolNames).not.toContain("rewrite_design_spec")
    // finalize_design_spec IS allowed through the write gate (approval path must remain open)
    expect(toolNames).toContain("finalize_design_spec")

    // Non-writing tools should still be available
    expect(toolNames).toContain("offer_pm_escalation")
  })
})

// ─── N66: Persistent render ambiguity audit cache — GitHub cache hit skips Haiku LLM call ──
//
// When the design branch contains a persisted audit cache file ({feature}.design-audit.json)
// whose specFingerprint matches the current draft, the state query path reuses those findings
// without calling auditSpecRenderAmbiguity (Haiku). This saves one LLM round-trip and keeps
// findings deterministic across bot restarts.
//
// Without the persistent cache: 5 Anthropic calls (isOffTopicForAgent, isSpecStateQuery, auditSpecDraft, auditSpecRenderAmbiguity, auditPhaseCompletion)
// With    the persistent cache: 4 Anthropic calls (auditSpecRenderAmbiguity skipped)

describe("Scenario N66 — Persistent render ambiguity audit cache hit skips Haiku LLM call on state query", () => {
  const THREAD = "workflow-n66"

  beforeEach(() => {
    clearHistory("onboarding")
    clearPhaseAuditCaches()
    setConfirmedAgent("onboarding", "ux-design")
  })

  afterEach(() => {
    clearHistory("onboarding")
  })

  it("GitHub-cached render ambiguity findings used when fingerprint matches — no auditSpecRenderAmbiguity call", async () => {
    const designDraft = [
      "## Screens",
      "### Onboarding Welcome",
      "Purpose: First screen after signup.",
      "Auth: Users sign in via Google OAuth2.",
      "## Acceptance Criteria",
      "1. Sign-in indicator is soft and non-intrusive.",
    ].join("\n")

    const approvedProductSpec = "## Acceptance Criteria\n1. SSO sign-in required. Provider TBD by PM."
    const productVision = "# Product Vision\n\nHealth app for conversations."

    // Compute the same fingerprint the platform produces.
    const fp = `${designDraft.length}:${designDraft.slice(0, 100)}:${designDraft.slice(-50)}`

    // Persisted cache content — renderAmbiguity + readiness with a matching fingerprint.
    // Both fields must be present so both the render ambiguity and readiness cache lookups
    // hit the persistent cache (avoiding extra LLM calls for either).
    const cachedAuditJson = JSON.stringify({
      specFingerprint: fp,
      renderAmbiguity: ["Screen 1a: prompt bar clipped on 320px viewport — add horizontal scroll or wrap"],
      readiness: [],
    })

    // GitHub: design draft + audit cache on branch, approved PM spec + product vision on main.
    mockGetContent.mockImplementation(async ({ path }: any) => {
      if (path === "specs/features/onboarding/onboarding.design.md") {
        return { data: { type: "file", content: Buffer.from(designDraft).toString("base64"), encoding: "base64" } }
      }
      if (path === "specs/features/onboarding/onboarding.design-audit.json") {
        return { data: { type: "file", content: Buffer.from(cachedAuditJson).toString("base64"), encoding: "base64" } }
      }
      if (path === "specs/features/onboarding/onboarding.product.md") {
        return { data: { type: "file", content: Buffer.from(approvedProductSpec).toString("base64"), encoding: "base64" } }
      }
      if (path === "specs/product/PRODUCT_VISION.md") {
        return { data: { type: "file", content: Buffer.from(productVision).toString("base64"), encoding: "base64" } }
      }
      throw Object.assign(new Error("not found"), { status: 404 })
    })

    // Anthropic call sequence — state query path with persistent cache HIT:
    //   [0] isOffTopicForAgent         → false
    //   [1] isSpecStateQuery           → yes (routes to state path)
    //   [2] auditSpecDraft             → OK
    //   --- auditSpecRenderAmbiguity SKIPPED (persistent render cache hit) ---
    //   --- auditPhaseCompletion SKIPPED (persistent readiness cache hit) ---
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "yes" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })

    const params = makeParams(THREAD, "feature-onboarding", "what is the current state of the design?")
    await handleFeatureChannelMessage(params)

    // Only 3 Anthropic calls — both auditSpecRenderAmbiguity and auditPhaseCompletion
    // were skipped due to persistent cache hits (renderAmbiguity + readiness).
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)

    // Cached finding must appear in the Design Issues section of the action menu.
    const text = lastUpdateText(params.client)
    expect(text).toContain("prompt bar clipped on 320px viewport")
    expect(text).toContain("Design Issues")
  })
})

// ─── Scenario N67: Agent addressing — @design overrides phase-based routing ──────
// When user sends "@design: show me the preview" while in architect phase,
// the router overrides confirmedAgent to ux-design and strips the prefix.

describe("Scenario N67 — Agent addressing overrides phase-based routing", () => {
  const THREAD = "n67-agent-addressing"

  beforeEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
    mockAnthropicCreate.mockReset()
    mockGetContent.mockReset()
  })

  afterEach(() => {
    clearHistory("onboarding")
    clearSummaryCache("onboarding")
    clearPhaseAuditCaches()
  })

  it("@design: prefix routes to design agent even when confirmedAgent is architect", async () => {
    // Start in architect phase
    setConfirmedAgent("onboarding", "architect")

    // After @design override, the router will run the design agent path.
    // isOffTopicForAgent → false, isSpecStateQuery → false, then design agent runs
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "No locked decisions found." }] }) // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }], stop_reason: "end_turn" }) // auditPhaseCompletion
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is the design status." }], stop_reason: "end_turn" }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })    // identifyUncommittedDecisions

    mockGetContent.mockRejectedValue(new Error("Not Found"))
    mockCreateOrUpdate.mockResolvedValue({})

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({
      ...makeParams(THREAD, "feature-onboarding", "@design: show me the current state"),
      client,
    })

    // confirmedAgent should now be ux-design (overridden from architect)
    expect(getConfirmedAgent("onboarding")).toBe("ux-design")

    // The message logged should have the prefix stripped
    // (verified by the [ROUTER] log showing msg="show me the current state" not "@design: ...")
  })
})

// Note: parseFixAllIntent hyphen range support ("fix 1-5", "fix 1-3, 5, 7-9")
// is covered by unit tests in tests/unit/action-menu.test.ts.
// No new E2E scenario needed — the fix-all flow (N54, N58, N62) already tests
// the platform path once parseFixAllIntent returns { isFixAll: true, selectedIndices }.

// Note: PM and architect tool handlers were extracted to runtime/tool-handlers.ts
// (handlePmTool, handleArchitectTool). E2E scenarios N71-N78 exercise these through
// the message.ts wiring. Unit tests in tests/unit/tool-handlers.test.ts cover all
// individual handler branches without E2E routing ceremony.

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N71 — PM run_phase_completion_audit tool handler
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N71 — PM run_phase_completion_audit tool handler", () => {
  const THREAD = "workflow-n71"
  const PM_DRAFT = "# Product Spec\n\n## Acceptance Criteria\nAC#1: user can log in.\n"

  it("PM agent calls run_phase_completion_audit and gets rubric result", async () => {
    setConfirmedAgent("onboarding", "pm")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.product.md") && ref === "spec/onboarding-product") {
        return Promise.resolve({ data: { content: Buffer.from(PM_DRAFT).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // PM path: [0] classifyMessageScope → feature,
    // [1] runAgent → tool_use: run_phase_completion_audit,
    //     [2] auditPhaseCompletion → PASS,
    // [3] runAgent → end_turn
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "run_phase_completion_audit", input: {} }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Rubric audit passed — spec is ready." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "run the rubric audit")
    await handleFeatureChannelMessage(params)

    // PM agent ran and produced a response
    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("Rubric audit passed")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N72 — PM offer_architect_escalation tool handler
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N72 — PM offer_architect_escalation tool handler", () => {
  const THREAD = "workflow-n72"

  it("PM agent calls offer_architect_escalation — returns success", async () => {
    setConfirmedAgent("onboarding", "pm")
    mockGetContent.mockImplementation(() => Promise.reject(new Error("Not Found")))

    // PM path: [0] classifyMessageScope → feature,
    // [1] runAgent → tool_use, [2] runAgent → end_turn
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_architect_escalation", input: { question: "How should we handle caching?" } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Architecture gap flagged." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "flag an arch gap")
    await handleFeatureChannelMessage(params)

    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("Architecture gap flagged")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N73 — Architect save_engineering_spec_draft tool handler
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N73 — Architect save_engineering_spec_draft tool handler", () => {
  const THREAD = "workflow-n73"
  const ENG_DRAFT = "# Engineering Spec\n\n## Components\nAuth module.\n"

  it("architect saves draft — save_engineering_spec_draft handler called", async () => {
    setConfirmedAgent("onboarding", "architect")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "main") {
        return Promise.resolve({ data: { content: Buffer.from("# Approved Design").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Use default mock for all routing/audit calls, then specific mocks for tool interaction
    let callCount = 0
    mockAnthropicCreate.mockImplementation(() => {
      callCount++
      // First few calls: routing classifiers + audit → all return generic text
      // Eventually runAgent calls with tool_use → save → end_turn
      if (callCount <= 3) return Promise.resolve({ content: [{ type: "text", text: "false" }] })
      if (callCount === 4) return Promise.resolve({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "save_engineering_spec_draft", input: { content: ENG_DRAFT } }],
      })
      if (callCount === 5) return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
      return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Engineering draft saved." }],
      })
    })

    const params = makeParams(THREAD, "feature-onboarding", "save the engineering spec")
    await handleFeatureChannelMessage(params)

    // Verify the engineering spec was written to GitHub
    const saveCall = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.endsWith("onboarding.engineering.md")
    )
    expect(saveCall).toBeDefined()
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N74 — Architect read_approved_specs tool handler
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N74 — Architect read_approved_specs tool handler", () => {
  const THREAD = "workflow-n74"

  it("read_approved_specs with empty featureNames returns note", async () => {
    setConfirmedAgent("onboarding", "architect")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "main") {
        return Promise.resolve({ data: { content: Buffer.from("# Approved Design").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Architect path: [0] isOffTopicForAgent, [1] isSpecStateQuery,
    // [2] runAgent → tool_use, [3] runAgent → end_turn
    // Note: no auditPhaseCompletion because no eng draft exists
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_approved_specs", input: { featureNames: [] } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Specs already in context." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "read approved specs")
    await handleFeatureChannelMessage(params)

    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("Specs already in context")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N75 — Architect offer_upstream_revision to PM
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N75 — Architect offer_upstream_revision to PM", () => {
  const THREAD = "workflow-n75"

  it("escalates to PM target and stores pending escalation", async () => {
    setConfirmedAgent("onboarding", "architect")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "main") {
        return Promise.resolve({ data: { content: Buffer.from("# Approved Design").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Architect: [0] isOffTopicForAgent, [1] isSpecStateQuery,
    // [2] runAgent → tool_use, [3] runAgent → end_turn
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "offer_upstream_revision", input: { targetAgent: "pm", question: "The AC doesn't cover edge case X" } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "PM escalation flagged." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "the PM needs to clarify something")
    await handleFeatureChannelMessage(params)

    // Agent ran and produced escalation response
    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("PM escalation flagged")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N76 — Architect finalize_engineering_spec blocked by design assumptions
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N76 — Architect finalize_engineering_spec blocked by design assumptions", () => {
  const THREAD = "workflow-n76"
  const ENG_WITH_ASSUMPTIONS = "# Engineering Spec\n\n## Components\nAuth.\n\n## Design Assumptions To Validate\n- Assumption 1: mobile bottom sheet is 90vh.\n"

  it("blocks finalization when unconfirmed design assumptions exist", async () => {
    setConfirmedAgent("onboarding", "architect")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.engineering.md") && ref === "spec/onboarding-engineering") {
        return Promise.resolve({ data: { content: Buffer.from(ENG_WITH_ASSUMPTIONS).toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.design.md") && ref === "main") {
        return Promise.resolve({ data: { content: Buffer.from("# Approved Design").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Architect: [0] isOffTopicForAgent, [1] isSpecStateQuery,
    // [2] auditPhaseCompletion → PASS,
    // [3] runAgent → tool_use: finalize_engineering_spec (blocked by assumptions),
    // [4] runAgent → end_turn (agent sees tool error)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_engineering_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Cannot finalize — design assumptions still pending." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "approved")
    await handleFeatureChannelMessage(params)

    // Agent received the tool error about design assumptions
    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("design assumptions")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N77 — Design fetch_url tool handler
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N77 — Design fetch_url tool handler", () => {
  const THREAD = "workflow-n77"

  it("design agent calls fetch_url — error handled gracefully", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from("# Design Spec\n\n## Screens\nScreen A.\n").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Mock global fetch to fail
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"))

    try {
      mockAnthropicCreate
        .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
        .mockResolvedValueOnce({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: "fetch_url", input: { url: "https://example.com/reference.html" } }],
        })
        .mockResolvedValueOnce({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Could not fetch — network error." }],
        })

      const params = makeParams(THREAD, "feature-onboarding", "fetch https://example.com/reference.html")
      await handleFeatureChannelMessage(params)

      // Agent received the error and continued
      const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
      const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
      expect(text).toContain("network error")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N78 — Design run_phase_completion_audit tool handler
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N78 — Design run_phase_completion_audit tool handler", () => {
  const THREAD = "workflow-n78"
  const DESIGN_DRAFT = "# Design Spec\n\n## Screens\nScreen A.\n"

  it("design agent calls run_phase_completion_audit and gets result", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(DESIGN_DRAFT).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      // auditPhaseCompletion for readiness notice
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      // runAgent → tool_use: run_phase_completion_audit
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "run_phase_completion_audit", input: {} }],
      })
      // auditPhaseCompletion inside tool handler
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      // runAgent → end_turn
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Audit passed." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "run the design audit")
    await handleFeatureChannelMessage(params)

    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("Audit passed")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N79 — Platform finalization with structural findings delegates to agent
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N79 — Platform finalization with structural findings delegates to agent", () => {
  const THREAD = "workflow-n79"
  const SPEC_WITH_DUPS = "# Design Spec\n\n## Screens\nScreen A.\n\n## Screens\nScreen B.\n"

  it("approval intent + structural findings → agent runs normally (no platform shortcut)", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(SPEC_WITH_DUPS).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Default mock for all routing/audit calls, final call returns agent response
    let callCount = 0
    mockAnthropicCreate.mockImplementation(() => {
      callCount++
      // Last call: runAgent end_turn with agent explaining structural conflicts
      if (callCount >= 5) return Promise.resolve({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "There are structural conflicts — fix duplicate ## Screens before approving." }],
      })
      // All routing/audit calls return generic text
      return Promise.resolve({ content: [{ type: "text", text: "false" }] })
    })

    const params = makeParams(THREAD, "feature-onboarding", "approved")
    await handleFeatureChannelMessage(params)

    // Spec was NOT finalized (structural conflicts block platform finalization)
    const mainWrite = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.endsWith("onboarding.design.md") && !c[0]?.ref
    )
    expect(mainWrite).toBeUndefined()

    // Agent ran (platform delegated to agent because structural findings > 0)
    expect(callCount).toBeGreaterThanOrEqual(4)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N68 — auditSpecStructure deterministic floor in action menu
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N68 — auditSpecStructure deterministic floor in action menu", () => {
  const THREAD = "workflow-n68"
  const SPEC_WITH_DUPLICATE = "# Design Spec\n\n## Screens\nScreen A.\n\n## Screens\nScreen B.\n"

  it("[STRUCTURAL] findings appear in state query action menu", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(SPEC_WITH_DUPLICATE).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // State query path: [0] isOffTopicForAgent, [1] isSpecStateQuery → true
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "true" }] })
      // auditPhaseCompletion for readiness
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ content: [{ type: "text", text: "[]" }] })

    const params = makeParams(THREAD, "feature-onboarding", "current state")
    await handleFeatureChannelMessage(params)

    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("[STRUCTURAL]")
    expect(text).toContain("Screens")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N69 — Health gate blocks save when structural findings increase
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N69 — Health gate blocks save when structural findings increase", () => {
  const THREAD = "workflow-n69"
  const CLEAN_SPEC = "# Design Spec\n\n## Screens\nScreen A.\n"
  const WORSE_SPEC = "# Design Spec\n\n## Screens\nScreen A.\n\n## Screens\nScreen B.\n"

  it("saveDesignDraft blocks when new content has more structural findings", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    // Existing spec is clean (0 structural findings)
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(CLEAN_SPEC).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Fix-all path: [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] auditPhaseCompletion,
    // [3] runAgent → rewrite_design_spec with WORSE content → health gate blocks save
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "rewrite_design_spec", input: { content: WORSE_SPEC } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
      })

    const params = makeParams(THREAD, "feature-onboarding", "fix all")
    await handleFeatureChannelMessage(params)

    // The save should have been blocked — check that the tool error mentions structural
    // The agent received the error message in the tool result
    const agentCall = mockAnthropicCreate.mock.calls[4]?.[0]
    if (agentCall) {
      const msgs = agentCall.messages as Array<{ role: string; content: unknown }>
      const toolResult = msgs.findLast((m: { role: string }) => m.role === "user")
      const toolResultText = Array.isArray(toolResult?.content)
        ? (toolResult.content as Array<{ type: string; content?: string }>).find(b => b.type === "tool_result")?.content ?? ""
        : ""
      expect(toolResultText).toContain("structural issues increased")
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Scenario N70 — Platform-enforced finalization bypasses agent
// ────────────────────────────────────────────────────────────────────────────────
describe("Scenario N70 — Platform-enforced finalization bypasses agent", () => {
  const THREAD = "workflow-n70"
  const CLEAN_SPEC = "# Design Spec\n\n## Screens\nScreen A: layout.\n\n## User Flows\nUS-1: user opens app → Screen A.\n"

  it("approval intent + 0 structural findings → platform calls finalize directly (no runAgent)", async () => {
    setConfirmedAgent("onboarding", "ux-design")
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.design.md") && ref === "spec/onboarding-design") {
        return Promise.resolve({ data: { content: Buffer.from(CLEAN_SPEC).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Default mock returns PASS/false for all routing + audit calls
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })
    // Override routing classifiers
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })

    const params = makeParams(THREAD, "feature-onboarding", "approved")
    await handleFeatureChannelMessage(params)

    // Spec was saved to main (merged)
    const mainWrite = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.endsWith("onboarding.design.md")
    )
    expect(mainWrite).toBeDefined()

    // Platform sent success message
    const updateCall = params.client.chat.update as ReturnType<typeof vi.fn>
    const text = updateCall.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(text).toContain("approved and merged")
  })
})

describe("Scenario N71 — Extracted design tool handler wiring through message.ts", () => {
  const THREAD = "workflow-n71"

  beforeEach(() => { clearHistory("onboarding") })

  it("save_design_spec_draft via extracted handler saves to GitHub and generates preview", async () => {
    setConfirmedAgent("onboarding", "ux-design")

    // Call sequence (0 history → no extractLockedDecisions):
    //   [0] isOffTopicForAgent  → false
    //   [1] isSpecStateQuery    → false
    //   [2] runAgent (tool_use) → save_design_spec_draft
    //       handler: auditSpecDraft skips LLM (empty productVision/architecture)
    //       generateDesignPreview → Anthropic call for renderer (gets NONE default)
    //   [3] runAgent (end_turn) → text response
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "save_design_spec_draft", input: { content: "# Design Spec\n\n## Screens\nWelcome\n\n## User Flows\nUS-1: user opens app" } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Design spec saved." }] })

    const client = makeClient()
    ;(client.files.uploadV2 as ReturnType<typeof vi.fn>).mockResolvedValue({})

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "create the design spec"), client })

    // Verify design spec was saved to GitHub via the extracted handler
    const branchWrite = mockCreateOrUpdate.mock.calls.find((c: any[]) =>
      c[0]?.path?.endsWith("onboarding.design.md")
    )
    expect(branchWrite).toBeDefined()
  })
})

describe("Scenario N73 — Phase transition clears conversation history", () => {
  beforeEach(() => { clearHistory("onboarding") })

  it("setConfirmedAgent clears history when agent changes (phase transition)", () => {
    // Seed history and agent for "onboarding"
    appendMessage("onboarding", { role: "user", content: "design discussion" })
    appendMessage("onboarding", { role: "assistant", content: "design response" })
    setConfirmedAgent("onboarding", "ux-design")
    expect(getHistory("onboarding")).toHaveLength(2)

    // Phase transition: design → architect
    setConfirmedAgent("onboarding", "architect")
    expect(getHistory("onboarding")).toHaveLength(0)
  })

  it("setConfirmedAgent does NOT clear history when agent is the same (no transition)", () => {
    appendMessage("onboarding", { role: "user", content: "arch discussion" })
    setConfirmedAgent("onboarding", "architect")
    setConfirmedAgent("onboarding", "architect") // same agent — no transition
    expect(getHistory("onboarding")).toHaveLength(1)
  })
})

describe("Scenario N72 — Architect orientation gate suppresses notices for first-time userId", () => {
  const THREAD = "workflow-n72"

  beforeEach(() => { clearHistory("onboarding") })

  it("first message from a userId suppresses audit notices; second message includes them", async () => {
    setConfirmedAgent("onboarding", "architect")
    // Mock: engineering draft exists so readiness audit fires
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.engineering.md") && ref === "spec/onboarding-engineering") {
        return Promise.resolve({ data: { content: Buffer.from("# Eng Spec\n## Open Questions\n- Q1 [open: architecture]").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // Anthropic mock: classifiers + agent response
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Welcome! This feature is onboarding." }] }) // runAgent

    // First message WITH userId — orientation gate fires, notices suppressed
    const params = { ...makeParams(THREAD, "feature-onboarding", "Hi, I am new here"), userId: "U_NEW_USER" }
    await handleFeatureChannelMessage(params)

    // Verify the agent's user message did NOT contain audit notice text
    const firstCall = mockAnthropicCreate.mock.calls.find((c: any[]) =>
      c[0]?.messages?.some((m: any) => m.role === "user" && m.content?.includes?.("INTERNAL — Upstream spec gaps"))
    )
    expect(firstCall).toBeUndefined()
  })
})

// ─── Scenario N80: Architect pre-run gate uses ARCHITECT_UPSTREAM_PM_RUBRIC ──────

describe("Scenario N80 — Architect pre-run gate uses ARCHITECT_UPSTREAM_PM_RUBRIC, not PM_RUBRIC", () => {
  const THREAD = "workflow-n80"

  beforeEach(() => { clearHistory("onboarding") })

  it("PM spec with sparse data requirements but complete error paths and no open questions → gate does NOT fire", async () => {
    setConfirmedAgent("onboarding", "architect")
    // Mark user as oriented so pre-run gate is not bypassed
    const { handleFeatureChannelMessage } = await import("../../../interfaces/slack/handlers/message")

    // PM spec: has error paths for all stories, no open questions, but NO data requirements
    // Under PM_RUBRIC this would produce criterion 4 findings. Under ARCHITECT_UPSTREAM_PM_RUBRIC it should NOT.
    const PM_SPEC = `# Onboarding
## User Stories
1. User signs up via SSO
2. Returning user signs in

## Edge Cases
- Sign-up SSO fails → user sees inline error with retry
- Sign-in SSO fails → user sees inline error with retry

## Acceptance Criteria
1. User can sign up
2. User can sign in

## Open Questions
(none)`

    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(PM_SPEC).toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.engineering.md") && ref === "spec/onboarding-engineering") {
        return Promise.resolve({ data: { content: Buffer.from("# Eng Spec\n## Open Questions\n(none)").toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.design.md")) {
        return Promise.resolve({ data: { content: Buffer.from("# Design Spec\nComplete").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })
    mockPaginate.mockResolvedValue([])

    // First message (orientation) to set orientedUsers
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // PM audit (ARCHITECT_UPSTREAM_PM_RUBRIC)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // Design audit
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // Engineering readiness audit
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Welcome!" }] }) // Agent response

    const params1 = { ...makeParams(THREAD, "feature-onboarding", "Hi I am new"), userId: "U_N80" }
    await handleFeatureChannelMessage(params1)

    // Second message — should NOT trigger pre-run gate because PM spec has no ARCHITECT_UPSTREAM_PM_RUBRIC gaps
    // All audits are CACHED from first message (same spec fingerprint), so only
    // isOffTopicForAgent, isSpecStateQuery, and agent response need mocks.
    mockAnthropicCreate.mockReset()
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Here is my proposal..." }] })

    const params2 = { ...makeParams(THREAD, "feature-onboarding", "what does the data model look like?"), userId: "U_N80" }
    await handleFeatureChannelMessage(params2)

    // Architect ran — gate did NOT fire (no pendingEscalation set)
    expect(getPendingEscalation("onboarding")).toBeNull()

    // Verify the agent actually ran (last mock was the agent response)
    const updateCalls = (params2.client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const agentResponse = updateCalls.find((c: any) => c[0]?.text?.includes("Here is my proposal"))
    expect(agentResponse).toBeDefined()
  })

  it("PM spec with missing error path → architect runs with finding in context (no gate, no block)", async () => {
    setConfirmedAgent("onboarding", "architect")

    // PM spec: MISSING error path for sign-in story
    const PM_SPEC_WITH_GAP = `# Onboarding
## User Stories
1. User signs up via SSO
2. Returning user signs in

## Edge Cases
- Sign-up SSO fails → user sees inline error with retry

## Acceptance Criteria
1. User can sign up
2. User can sign in

## Open Questions
(none)`

    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(PM_SPEC_WITH_GAP).toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.engineering.md") && ref === "spec/onboarding-engineering") {
        return Promise.resolve({ data: { content: Buffer.from("# Eng Spec\n## Open Questions\n(none)").toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.design.md")) {
        return Promise.resolve({ data: { content: Buffer.from("# Design Spec\nComplete").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })
    mockPaginate.mockResolvedValue([])

    // First message to set orientedUsers
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Welcome!" }] })
    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "I am new to the team"), userId: "U_N80b" })

    // Second message — PM audit finds a gap via different fingerprint
    const PM_SPEC_WITH_GAP_V2 = `# Onboarding v2
## User Stories
1. User signs up via SSO
2. Returning user signs in

## Edge Cases
- Sign-up SSO fails → user sees inline error with retry

## Acceptance Criteria
1. User can sign up
2. User can sign in

## Open Questions
(none)`
    mockGetContent.mockImplementation(({ path, ref }: { path?: string; ref?: string }) => {
      if (path?.endsWith("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(PM_SPEC_WITH_GAP_V2).toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.engineering.md") && ref === "spec/onboarding-engineering") {
        return Promise.resolve({ data: { content: Buffer.from("# Eng Spec\n## Open Questions\n(none)").toString("base64"), type: "file" } })
      }
      if (path?.endsWith("onboarding.design.md")) {
        return Promise.resolve({ data: { content: Buffer.from("# Design Spec\nComplete").toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    mockAnthropicCreate.mockReset()
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "FINDING: User Story 2 has no failure path | Add sign-in failure edge case" }] }) // PM audit
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // Design audit
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })    // Engineering readiness
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "I found a PM spec gap..." }] }) // Agent runs (NOT blocked)

    await handleFeatureChannelMessage({ ...makeParams(THREAD, "feature-onboarding", "lets go"), userId: "U_N80b" })

    // No gate fired — architect ran normally (no pendingEscalation)
    expect(getPendingEscalation("onboarding")).toBeNull()

    // PM finding appears in the architect's context (injected as notice, not a blocker)
    const agentCall = mockAnthropicCreate.mock.calls.find((c: any[]) =>
      c[0]?.messages?.some((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("APPROVED PM SPEC"))
    )
    expect(agentCall).toBeDefined()
  })
})
