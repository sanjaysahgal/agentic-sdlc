import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Integration tests for the message handler's blocking gate and gap detection.
// Strategy: set env vars so workspace-config works; mock only external packages
// (@octokit/rest, @anthropic-ai/sdk) and the Slack thinking indicator.
// All internal runtime modules run as normal — this tests the full handler path.

const mockOctokitGetContent = vi.hoisted(() => vi.fn())
const mockOctokitGetRef = vi.hoisted(() => vi.fn())
const mockOctokitCreateRef = vi.hoisted(() => vi.fn())
const mockOctokitCreateOrUpdate = vi.hoisted(() => vi.fn())
const mockOctokitPaginate = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockAnthropicCreate = vi.hoisted(() => vi.fn())

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      repos: {
        getContent: mockOctokitGetContent,
        createOrUpdateFileContents: mockOctokitCreateOrUpdate,
        listBranches: vi.fn(),
      },
      git: { getRef: mockOctokitGetRef, createRef: mockOctokitCreateRef },
      paginate: mockOctokitPaginate,
    }
  }),
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } }
  }),
}))


import { handleFeatureChannelMessage } from "../../../interfaces/slack/handlers/message"
import { clearHistory, setConfirmedAgent, getHistory, disableFilePersistence } from "../../../runtime/conversation-store"
import { featureKey } from "../../runtime/routing/types"
disableFilePersistence()

const originalEnv = process.env

beforeEach(() => {
  vi.resetAllMocks()
  process.env = {
    ...originalEnv,
    PRODUCT_NAME: "TestApp",
    GITHUB_OWNER: "o",
    GITHUB_REPO: "r",
    GITHUB_TOKEN: "test-token",
    ANTHROPIC_API_KEY: "test-key",
    SLACK_MAIN_CHANNEL: "all-testapp",
  }

  // Default: feature in product-spec-in-progress phase (no spec branches)
  mockOctokitPaginate.mockResolvedValue([])
  // Default: no existing draft files on branch
  mockOctokitGetContent.mockRejectedValue(new Error("Not Found"))
  // Default: context docs empty
  mockOctokitGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
  mockOctokitCreateRef.mockResolvedValue({})
  clearHistory(featureKey("onboarding"))
})

afterEach(() => {
  process.env = originalEnv
  clearHistory(featureKey("onboarding"))
})

const makeParams = (overrides: Partial<{ userMessage: string }> = {}) => ({
  channelName: "feature-onboarding",
  threadTs: "thread-123",
  channelId: "C123",
  // postMessage must return { ts } so withThinking can update the placeholder
  client: {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "msg-ts" }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  channelState: {
    productSpecApproved: false,
    engineeringSpecApproved: false,
    pendingAgent: null,
    pendingMessage: null,
    pendingThreadTs: null,
  },
  userMessage: overrides.userMessage ?? "approved",
})

// Helper: set the confirmed agent for the test thread
async function withConfirmedAgent(agent: string, fn: () => Promise<void>) {
  setConfirmedAgent(featureKey("onboarding"), agent as any)
  await fn()
}

// Helper: make Anthropic return a specific text response
function mockAgentResponse(text: string) {
  mockAnthropicCreate.mockResolvedValue({
    content: [{ type: "text", text }],
  })
}

// ─── Blocking gate — PM agent ────────────────────────────────────────────────

describe("blocking gate — PM agent", () => {
  it("blocks approval and does not save when spec has [blocking: yes] questions", async () => {
    mockAgentResponse(
      `INTENT: CREATE_SPEC\n## Problem\nHelp users.\n\n## Open Questions\n- [type: product] [blocking: yes] Who is the primary user?`
    )

    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(makeParams())
    })

    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })

  it("PM agent saves approved spec when finalize_product_spec tool is called with valid draft", async () => {
    // Mock GitHub to return a draft without blocking questions for the product spec path
    const draftContent = "## Problem\nHelp users onboard.\n\n## Open Questions\n"
    mockOctokitGetContent.mockImplementation((params: any) => {
      if (params?.path?.includes("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(draftContent).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })
    mockOctokitCreateOrUpdate.mockResolvedValue({})

    // [0] classifyMessageScope, [1] runAgent (tool_use: finalize_product_spec),
    // [2] auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC) → PASS (parallel with [3]),
    // [3] auditDownstreamReadiness(designer) → PASS (parallel with [2]),
    // [4] runAgent (end_turn text) — auditSpecDecisions skips (history < 2)
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })                                                                                    // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })               // auditDownstreamReadiness(designer)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Product spec approved and saved!" }] }) // runAgent: end_turn

    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(makeParams())
    })
    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })

  it("finalize_product_spec returns blocking error when [blocking: yes] questions exist", async () => {
    // Mock GitHub to return a draft WITH blocking questions
    const draftWithBlocking = "## Problem\nHelp users.\n\n## Open Questions\n- [type: product] [blocking: yes] Who is the primary user?\n- [type: design] [blocking: yes] Which nav pattern?"
    mockOctokitGetContent.mockImplementation((params: any) => {
      if (params?.path?.includes("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(draftWithBlocking).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // [0] classifyMessageScope, [1] runAgent (tool_use: finalize_product_spec → blocking error),
    // [2] runAgent (end_turn: agent surfaces blocking error to user)
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })                                                                                    // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Approval blocked — 2 blocking questions must be resolved first:\n• Who is the primary user?\n• Which nav pattern?" }] }) // runAgent: end_turn

    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(makeParams())
    })

    const history = getHistory(featureKey("onboarding"))
    const lastAssistant = history.filter(m => m.role === "assistant").at(-1)
    expect(lastAssistant?.content).toContain("Approval blocked")
    expect(lastAssistant?.content).toContain("Who is the primary user")
    expect(lastAssistant?.content).toContain("Which nav pattern")
    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })
})

// ─── Blocking gate — design agent ───────────────────────────────────────────

describe("blocking gate — design agent", () => {
  it("blocks design spec approval when [blocking: yes] questions remain", async () => {
    mockAgentResponse(
      `INTENT: CREATE_DESIGN_SPEC\n## Screens\n\n## Open Questions\n- [type: product] [blocking: yes] What is the session TTL?`
    )

    await withConfirmedAgent("ux-design", async () => {
      await handleFeatureChannelMessage(makeParams())
    })

    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })

  it("Design agent saves approved spec when finalize_design_spec tool is called with valid draft", async () => {
    // Mock GitHub to return a design draft without blocking questions
    const draftContent = "## Screens\nLogin screen.\n\n## Open Questions\n"
    mockOctokitGetContent.mockImplementation((params: any) => {
      if (params?.path?.includes("onboarding.design.md")) {
        return Promise.resolve({ data: { content: Buffer.from(draftContent).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })
    mockOctokitCreateOrUpdate.mockResolvedValue({})

    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] isReadinessQuery, [3] runAgent (tool_use: finalize_design_spec),
    // [4] runAgent (end_turn text) — auditSpecDecisions skips (history < 2)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })             // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })             // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "no" }] })                // isReadinessQuery
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_design_spec", input: {} }],
      })                                                                                   // runAgent: tool_use
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Design spec approved and saved!" }] }) // runAgent: end_turn

    await withConfirmedAgent("ux-design", async () => {
      await handleFeatureChannelMessage(makeParams())
    })
    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })
})

// ─── Gap detection — history persistence ────────────────────────────────────

// Helpers for gap tests: the spec-auditor needs non-empty productVision to make
// an Anthropic call. We provide it via getContent and sequence 4 API calls:
// 1. classifyMessageScope → "feature-specific"
// 2. runAgent first call → tool_use: save_product_spec_draft
// 3. auditSpecDraft (triggered by productVision being non-empty) → GAP response
// 4. runAgent second call → agent's text response mentioning the gap
function setupGapScenario() {
  const encodedVision = Buffer.from("The product vision: health tracking for everyday users.").toString("base64")
  mockOctokitGetContent.mockResolvedValue({ data: { content: encodedVision, type: "file" } })

  mockAnthropicCreate
    .mockResolvedValueOnce({                                                            // runAgent: tool_use
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "save_product_spec_draft", input: { content: "## Problem\nHelp users.\n## Open Questions\n- [type: product] [blocking: no] Define power user.\n" } }],
    })
    .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: Power user persona is not defined in the product vision." }] }) // auditSpecDraft
    .mockResolvedValueOnce({                                                            // runAgent: end_turn
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Draft saved!\n\nGap detected: Power user persona is not defined in the product vision. Is this a deliberate extension or something you want to resolve?" }],
    })

  mockOctokitCreateOrUpdate.mockResolvedValue({})
}

describe("gap detection", () => {
  it("surfaces gap message and question in Slack response and saves the draft", async () => {
    setupGapScenario()

    const params = { ...makeParams(), userMessage: "let's keep going" }
    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(params)
    })

    // Draft IS saved even when a gap is detected
    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()

    // Gap message and resolution options surfaced in Slack (agent's text response)
    const updateCalls = (params.client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastUpdate = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastUpdate).toContain("Gap detected")
    expect(lastUpdate).toContain("deliberate extension")
  })

  it("gap question is stored in history so the agent can interpret the next reply", async () => {
    setupGapScenario()

    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage({ ...makeParams(), userMessage: "let's keep going" })
    })

    // The gap question must be in history so the agent knows what a short reply
    // like "Deliberate extension" refers to on the next turn
    const history = getHistory(featureKey("onboarding"))
    const assistantMessages = history.filter(m => m.role === "assistant")
    expect(assistantMessages.length).toBeGreaterThan(0)
    const allAssistantContent = assistantMessages.map(m => m.content).join("\n")
    expect(allAssistantContent).toContain("Gap detected")
    expect(allAssistantContent).toContain("deliberate extension")
  })
})

// History integrity tests live in tests/regression/history-integrity.test.ts

// ─── Design state query — quality section ────────────────────────────────────

describe("design state query — quality section", () => {
  // This test guards against the wiring bug where quality checks were only injected
  // into the design agent LLM path but state queries take an early-return path
  // (buildDesignStateResponse) and never reached them. Quality issues now appear
  // in the action menu under "Design Issues" (same as the LLM path). This test
  // asserts quality findings surface on a state query without any trigger phrase.

  it("surfaces Design Issues entries in action menu with redundant branding and copy findings on state query", async () => {
    const { readFileSync } = await import("fs")
    const fixtureContent = readFileSync(
      "tests/fixtures/agent-output/onboarding-design-full.md",
      "utf-8"
    )

    // Return the fixture spec from the design branch path
    mockOctokitGetContent.mockImplementation((params: any) => {
      if (params?.path?.includes("onboarding.design.md")) {
        return Promise.resolve({
          data: { content: Buffer.from(fixtureContent).toString("base64"), type: "file" },
        })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // State query path: isOffTopicForAgent + isSpecStateQuery + auditSpecRenderAmbiguity + auditPhaseCompletion (4 Haiku calls)
    // isOffTopicForAgent: returns true when text === "off-topic"; "on-topic" → false (keep going)
    // isSpecStateQuery: returns true when text === "yes"
    // auditSpecRenderAmbiguity: returns JSON array of quality findings
    // auditPhaseCompletion: returns PASS (no readiness gaps)
    // No Sonnet call — returns early via buildDesignStateResponse + buildActionMenu
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "on-topic" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "yes" }] })                // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: '["Scrollbar treatment not defined for chip row"]' }] }) // auditSpecRenderAmbiguity
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })              // auditPhaseCompletion

    const params = makeParams({ userMessage: "what is the current state" })

    await withConfirmedAgent("ux-design", async () => {
      await handleFeatureChannelMessage(params)
    })

    const updateCalls = (params.client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastUpdate = updateCalls.at(-1)?.[0]?.text ?? ""

    // Action menu with Design Issues category must be present — this is the wiring invariant
    expect(lastUpdate).toContain("*── OPEN ITEMS ──*")
    expect(lastUpdate).toContain("Design Issues")

    // Redundant branding (deterministic, from auditSpecRenderAmbiguity internal check)
    expect(lastUpdate).toContain("Sign in to Health360")

    // Copy completeness (deterministic, from auditSpecRenderAmbiguity internal check)
    expect(lastUpdate).toContain("One conversation")

    // Haiku semantic finding surfaced in the same section
    expect(lastUpdate).toContain("Scrollbar treatment not defined for chip row")
  })
})
