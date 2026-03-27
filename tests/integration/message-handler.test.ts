import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Integration tests for the message handler's blocking gate and gap detection.
// Strategy: set env vars so workspace-config works; mock only external packages
// (@octokit/rest, @anthropic-ai/sdk) and the Slack thinking indicator.
// All internal runtime modules run as normal — this tests the full handler path.

const mockOctokitGetContent = vi.hoisted(() => vi.fn())
const mockOctokitGetRef = vi.hoisted(() => vi.fn())
const mockOctokitCreateRef = vi.hoisted(() => vi.fn())
const mockOctokitCreateOrUpdate = vi.hoisted(() => vi.fn())
const mockOctokitPaginate = vi.hoisted(() => vi.fn())
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
import { clearHistory, setConfirmedAgent, getHistory } from "../../../runtime/conversation-store"

const originalEnv = process.env

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

  // Default: feature in product-spec-in-progress phase (no spec branches)
  mockOctokitPaginate.mockResolvedValue([])
  // Default: no existing draft files on branch
  mockOctokitGetContent.mockRejectedValue(new Error("Not Found"))
  // Default: context docs empty
  mockOctokitGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
  mockOctokitCreateRef.mockResolvedValue({})
  clearHistory("onboarding")
})

afterEach(() => {
  process.env = originalEnv
  clearHistory("onboarding")
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
  setConfirmedAgent("onboarding", agent as any)
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

  it("saves approved spec after two-step confirmation — approval intent shows confirm prompt, 'confirmed' saves", async () => {
    mockAgentResponse(
      `INTENT: CREATE_SPEC\n## Problem\nHelp users.\n\n## Open Questions\n- [type: engineering] [blocking: no] Which auth provider?`
    )
    mockOctokitCreateOrUpdate.mockResolvedValue({})

    // Step 1: agent fires approval intent → shows confirmation prompt, does NOT save
    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(makeParams())
    })
    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
    const confirmPrompt = getHistory("onboarding").filter(m => m.role === "assistant").at(-1)
    expect(confirmPrompt?.content).toContain("Looks like you're approving")

    // Step 2: user confirms → spec is saved
    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(makeParams({ userMessage: "confirmed" }))
    })
    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })

  it("reports blocking count in history when multiple blocking questions exist", async () => {
    mockAgentResponse([
      "INTENT: CREATE_SPEC",
      "## Open Questions",
      "- [type: product] [blocking: yes] Who is the primary user?",
      "- [type: design] [blocking: yes] Which nav pattern?",
    ].join("\n"))

    await withConfirmedAgent("pm", async () => {
      await handleFeatureChannelMessage(makeParams())
    })

    const history = getHistory("onboarding")
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

  it("saves approved design spec after two-step confirmation — approval intent shows confirm prompt, 'confirmed' saves", async () => {
    mockAgentResponse(
      `INTENT: CREATE_DESIGN_SPEC\n## Screens\n\n## Open Questions\n- [type: engineering] [blocking: no] Glow: CSS vs canvas?`
    )
    mockOctokitCreateOrUpdate.mockResolvedValue({})

    // Step 1: agent fires approval intent → shows confirmation prompt, does NOT save
    await withConfirmedAgent("ux-design", async () => {
      await handleFeatureChannelMessage(makeParams())
    })
    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
    const confirmPrompt = getHistory("onboarding").filter(m => m.role === "assistant").at(-1)
    expect(confirmPrompt?.content).toContain("Looks like you're approving")

    // Step 2: user confirms → spec is saved
    await withConfirmedAgent("ux-design", async () => {
      await handleFeatureChannelMessage(makeParams({ userMessage: "confirmed" }))
    })
    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })
})

// ─── Gap detection — history persistence ────────────────────────────────────

// Helpers for gap tests: the real spec-auditor needs non-empty productVision
// to make an Anthropic call. We provide it via getContent and sequence 3 calls:
// 1. classifyMessageScope → "feature-specific"
// 2. runAgent → DRAFT spec body
// 3. auditSpecDraft → GAP response
function setupGapScenario() {
  const encodedVision = Buffer.from("The product vision: health tracking for everyday users.").toString("base64")
  mockOctokitGetContent.mockResolvedValue({ data: { content: encodedVision, type: "file" } })

  mockAnthropicCreate
    .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
    .mockResolvedValueOnce({ content: [{ type: "text", text: "DRAFT_SPEC_START\n## Problem\nHelp users.\n## Open Questions\n- [type: product] [blocking: no] Define power user.\nDRAFT_SPEC_END" }] }) // runAgent
    .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: Power user persona is not defined in the product vision." }] }) // auditSpecDraft

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

    // Gap message and resolution options surfaced in Slack
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
    const history = getHistory("onboarding")
    const assistantMessages = history.filter(m => m.role === "assistant")
    expect(assistantMessages.length).toBeGreaterThan(0)
    const allAssistantContent = assistantMessages.map(m => m.content).join("\n")
    expect(allAssistantContent).toContain("Gap detected")
    expect(allAssistantContent).toContain("deliberate extension")
  })
})

// History integrity tests live in tests/regression/history-integrity.test.ts
