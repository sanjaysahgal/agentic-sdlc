import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Integration tests for extractLockedDecisions wiring in all three agent runners.
// Verifies: (1) locked decisions are injected into the Sonnet call when present,
// (2) if extractLockedDecisions throws, the runner does NOT crash — it falls back
//     to the unmodified user message and the agent still responds.

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
import { clearHistory, setConfirmedAgent, appendMessage } from "../../../runtime/conversation-store"

const originalEnv = process.env
const THREAD = "thread-locked"

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "msg-ts" }),
      update: vi.fn().mockResolvedValue({}),
    },
    files: { uploadV2: vi.fn().mockRejectedValue(new Error("no scope")) },
  }
}

function makeParams(userMessage: string, client = makeClient()) {
  return {
    channelName: "feature-onboarding",
    threadTs: THREAD,
    channelId: "C123",
    client,
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

// Seed enough history for extractLockedDecisions to fire (threshold = 6 messages)
function seedHistory(count = 7) {
  for (let i = 0; i < count; i++) {
    appendMessage(THREAD, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
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
  mockOctokitPaginate.mockResolvedValue([])
  mockOctokitGetContent.mockRejectedValue(new Error("Not Found"))
  mockOctokitGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
  mockOctokitCreateRef.mockResolvedValue({})
  clearHistory(THREAD)
})

afterEach(() => {
  process.env = originalEnv
  clearHistory(THREAD)
})

// ─── PM agent ────────────────────────────────────────────────────────────────

describe("locked decisions — PM agent", () => {
  it("injects locked decisions into Sonnet call when Haiku returns bullets", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "pm")

    // Call sequence: classifyMessageScope, extractLockedDecisions, runAgent (Sonnet)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "• Dark primary color\n• Mobile-first layout" }] })  // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is my response." }] })  // runAgent

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("let's keep going", client))

    // Third call is Sonnet (runAgent) — its user content must contain the locked decisions prefix
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(3)
    const sonnetCall = mockAnthropicCreate.mock.calls[2][0]
    const userContent = sonnetCall.messages.find((m: any) => m.role === "user")?.content
    expect(userContent).toContain("Decisions locked in this conversation")
    expect(userContent).toContain("Dark primary color")
  })

  it("runner does NOT crash when extractLockedDecisions throws — agent still responds", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "pm")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })  // classifyMessageScope
      .mockRejectedValueOnce(new Error("Haiku API failure"))                              // extractLockedDecisions throws
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is my response." }] })  // runAgent

    const client = makeClient()
    // Must NOT throw
    await expect(handleFeatureChannelMessage(makeParams("let's keep going", client))).resolves.toBeUndefined()

    // Agent still responded — update was called with actual content
    const updateCalls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastText = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastText).toContain("Here is my response")
    expect(lastText).not.toContain("Something went wrong")
  })
})

// ─── Design agent ─────────────────────────────────────────────────────────────

describe("locked decisions — design agent", () => {
  it("injects locked decisions into Sonnet call when Haiku returns bullets", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    // Call sequence: isOffTopicForAgent, isSpecStateQuery, extractLockedDecisions, runAgent
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "• Dark primary\n• Archon Labs aesthetic" }] })  // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Design response." }] })  // runAgent

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("rebuild the spec", client))

    const sonnetCall = mockAnthropicCreate.mock.calls[3][0]
    const userContent = sonnetCall.messages.find((m: any) => m.role === "user")?.content
    expect(userContent).toContain("Decisions locked in this conversation")
    expect(userContent).toContain("Dark primary")
    expect(userContent).toContain("Archon Labs aesthetic")
  })

  it("runner does NOT crash when extractLockedDecisions throws — design agent still responds", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockRejectedValueOnce(new Error("Haiku API failure"))                   // extractLockedDecisions throws
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Design response." }] })  // runAgent

    const client = makeClient()
    await expect(handleFeatureChannelMessage(makeParams("rebuild the spec", client))).resolves.toBeUndefined()

    const updateCalls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastText = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastText).toContain("Design response")
    expect(lastText).not.toContain("Something went wrong")
  })
})

// ─── Architect agent ──────────────────────────────────────────────────────────

describe("locked decisions — architect agent", () => {
  it("runner does NOT crash when extractLockedDecisions throws — architect still responds", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "architect")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // isSpecStateQuery
      .mockRejectedValueOnce(new Error("Haiku API failure"))                   // extractLockedDecisions throws
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Arch response." }] })  // runAgent

    const client = makeClient()
    await expect(handleFeatureChannelMessage(makeParams("plan the API", client))).resolves.toBeUndefined()

    const updateCalls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastText = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastText).toContain("Arch response")
    expect(lastText).not.toContain("Something went wrong")
  })
})
