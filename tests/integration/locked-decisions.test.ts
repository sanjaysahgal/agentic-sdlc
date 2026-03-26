import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Integration tests for extractLockedDecisions wiring in all three agent runners.
// Verifies: (1) locked decisions are injected into the Sonnet call when present,
// (2) if extractLockedDecisions throws, the runner does NOT crash — it falls back
//     to the unmodified user message and the agent still responds.
//
// Actual Anthropic call order per runner:
//   PM:       extractLockedDecisions → classifyMessageScope → runAgent
//   Design:   isOffTopicForAgent → isSpecStateQuery → extractLockedDecisions → runAgent
//   Architect: isOffTopicForAgent → isSpecStateQuery → extractLockedDecisions → runAgent

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

// The last user message in the Sonnet call is the enriched current message.
// History messages come first; the current userMessage is appended last.
function getLastUserContent(call: any): string {
  const msgs = call[0].messages as Array<{ role: string; content: string }>
  return msgs.filter(m => m.role === "user").at(-1)?.content ?? ""
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

// ─── PM agent ─────────────────────────────────────────────────────────────────
// Call order: [0] extractLockedDecisions, [1] classifyMessageScope, [2] runAgent

describe("locked decisions — PM agent", () => {
  it("injects locked decisions into Sonnet call when Haiku returns bullets", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "pm")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "• Dark primary color\n• Mobile-first layout" }] }) // [0] extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })                           // [1] classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is my response." }] })                       // [2] runAgent (Sonnet)

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("let's keep going", client))

    // Sonnet call is index 2 — last user message is the enriched current message
    const lastUserContent = getLastUserContent(mockAnthropicCreate.mock.calls[2])
    expect(lastUserContent).toContain("Decisions locked in this conversation")
    expect(lastUserContent).toContain("Dark primary color")
    expect(lastUserContent).toContain("let's keep going")
  })

  it("runner does NOT crash when extractLockedDecisions throws — agent still responds", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "pm")

    mockAnthropicCreate
      .mockRejectedValueOnce(new Error("Haiku API failure"))                                                       // [0] extractLockedDecisions → caught by .catch(() => "")
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })                           // [1] classifyMessageScope
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is my response." }] })                       // [2] runAgent

    const client = makeClient()
    // Must NOT throw — .catch(() => "") absorbs the failure
    await expect(handleFeatureChannelMessage(makeParams("let's keep going", client))).resolves.toBeUndefined()

    // Agent still responded with real content, not an error message
    const updateCalls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastText = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastText).toContain("Here is my response")
    expect(lastText).not.toContain("Something went wrong")
  })
})

// ─── Design agent ─────────────────────────────────────────────────────────────
// Call order: [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] detectRenderIntent, [3] extractLockedDecisions, [4] runAgent

describe("locked decisions — design agent", () => {
  it("injects locked decisions into Sonnet call when Haiku returns bullets", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                                      // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })                                      // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "other" }] })                                      // [2] detectRenderIntent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "• Dark primary\n• Archon Labs aesthetic" }] })    // [3] extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Design response." }] })                           // [4] runAgent (Sonnet)

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("rebuild the spec", client))

    const lastUserContent = getLastUserContent(mockAnthropicCreate.mock.calls[4])
    expect(lastUserContent).toContain("Decisions locked in this conversation")
    expect(lastUserContent).toContain("Dark primary")
    expect(lastUserContent).toContain("Archon Labs aesthetic")
    expect(lastUserContent).toContain("rebuild the spec")
  })

  it("runner does NOT crash when extractLockedDecisions throws — design agent still responds", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "other" }] })   // [2] detectRenderIntent
      .mockRejectedValueOnce(new Error("Haiku API failure"))                   // [3] extractLockedDecisions → caught
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Design response." }] })  // [4] runAgent

    const client = makeClient()
    await expect(handleFeatureChannelMessage(makeParams("rebuild the spec", client))).resolves.toBeUndefined()

    const updateCalls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastText = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastText).toContain("Design response")
    expect(lastText).not.toContain("Something went wrong")
  })
})

// ─── Architect agent ──────────────────────────────────────────────────────────
// Call order: [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] extractLockedDecisions, [3] runAgent

describe("locked decisions — architect agent", () => {
  it("runner does NOT crash when extractLockedDecisions throws — architect still responds", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "architect")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })   // [1] isSpecStateQuery
      .mockRejectedValueOnce(new Error("Haiku API failure"))                   // [2] extractLockedDecisions → caught
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Arch response." }] })  // [3] runAgent

    const client = makeClient()
    await expect(handleFeatureChannelMessage(makeParams("plan the API", client))).resolves.toBeUndefined()

    const updateCalls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
    const lastText = updateCalls.at(-1)?.[0]?.text ?? ""
    expect(lastText).toContain("Arch response")
    expect(lastText).not.toContain("Something went wrong")
  })
})
