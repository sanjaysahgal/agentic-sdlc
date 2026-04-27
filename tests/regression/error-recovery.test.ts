import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withThinking } from "../../../interfaces/slack/handlers/thinking"

// Regression tests for error handling and recovery behaviors.
// Each test documents a specific production incident where error handling was
// either too silent (errors were swallowed) or too fragile (one bad state
// made the entire thread permanently broken).
//
// Bugs tracked here:
//   #7 — withThinking silently swallowed chat.update failures.
//        When update() failed (stale message TS, rate limit), the error was
//        caught and discarded. Users saw "UX Designer is thinking..." forever
//        with no visible error, and no fallback message was posted.
//   #8 — Blocking gate: PM agent saved spec even when [blocking: yes] questions
//        existed. A spec with unresolved blocking questions must never be saved.
//   #9 — Gap detection must persist the gap question in conversation history so
//        the agent can interpret short follow-up replies (e.g. "deliberate extension").

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
  // resetAllMocks clears queued mockResolvedValueOnce values between tests,
  // preventing leftover queue entries from leaking into subsequent tests.
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
  mockOctokitPaginate.mockResolvedValue([])
  mockOctokitGetContent.mockRejectedValue(new Error("Not Found"))
  mockOctokitGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
  mockOctokitCreateRef.mockResolvedValue({})
  clearHistory(featureKey("onboarding"))
})

afterEach(() => {
  process.env = originalEnv
  clearHistory(featureKey("onboarding"))
})

const makeParams = (userMessage = "approved") => ({
  channelName: "feature-onboarding",
  threadTs: "thread-123",
  channelId: "C123",
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
  userMessage,
})

// ─── Bug #7: withThinking silent swallow ─────────────────────────────────────
// Regression: chat.update failure was caught by an empty .catch(() => {}) inside
// withThinking. Users saw the "thinking..." placeholder with no reply and no error.
// Fix: post a new message via chat.postMessage when chat.update fails.
//
// Tested directly against withThinking to avoid the mock sequencing complexity
// of routing the error through the full handler (intermediate status updates
// would consume the mock before the Anthropic call, masking the real error).

describe("bug #7 — withThinking posts fallback message when chat.update fails", () => {
  it("posts a new error message when update() throws (stale TS / rate limit)", async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "msg-ts" }),
        update: vi.fn().mockRejectedValue(new Error("message_not_found")),
      },
    }

    // run() throws so withThinking tries to update with an error message
    const run = vi.fn().mockRejectedValue(new Error("API overloaded"))

    // Should not throw — the fallback postMessage handles it
    await withThinking({ client, channelId: "C123", threadTs: "t-test", run }).catch(() => {})

    // postMessage is called twice: once for the "thinking..." placeholder,
    // once as the fallback when chat.update fails to post the error
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2)
    const fallbackCall = client.chat.postMessage.mock.calls.at(-1)?.[0]
    expect(fallbackCall?.text).toContain("overloaded")
  })
})

// ─── Bug #8: blocking gate ────────────────────────────────────────────────────
// Regression: spec was saved regardless of [blocking: yes] questions.
// A spec with unresolved blocking questions must never write to GitHub.

describe("bug #8 — blocking gate: finalize tool returns error when [blocking: yes] questions exist", () => {
  it("PM agent: finalize_product_spec returns blocking error and spec is not saved", async () => {
    // Mock GitHub to return a draft WITH blocking questions for the product spec path
    const draftWithBlocking = "## Problem\nHelp users.\n\n## Open Questions\n- [type: product] [blocking: yes] Who is the primary user?"
    mockAnthropicCreate.mockOctokitGetContent = undefined  // clear any stale reference
    mockOctokitGetContent.mockImplementation((params: any) => {
      if (params?.path?.includes("onboarding.product.md")) {
        return Promise.resolve({ data: { content: Buffer.from(draftWithBlocking).toString("base64"), type: "file" } })
      }
      return Promise.reject(new Error("Not Found"))
    })

    // [0] runAgent (tool_use: finalize_product_spec → blocking error),
    // [1] runAgent (end_turn: agent surfaces the error)
    mockAnthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "finalize_product_spec", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Approval blocked — 1 blocking question must be resolved first:\n• Who is the primary user?" }],
      })

    setConfirmedAgent(featureKey("onboarding"), "pm" as any)
    await handleFeatureChannelMessage(makeParams())

    // saveApprovedSpec must NOT have been called
    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()

    // Blocking error must be surfaced in the agent's response (stored in history)
    const history = getHistory(featureKey("onboarding"))
    const lastAssistant = history.filter(m => m.role === "assistant").at(-1)
    expect(lastAssistant?.content).toContain("Approval blocked")
    expect(lastAssistant?.content).toContain("Who is the primary user")
  })

  it("Design agent: text-only response never saves spec (no finalize tool called)", async () => {
    // If the agent doesn't call finalize_design_spec, nothing is saved — regardless of
    // what it says in the text. This is a stronger guarantee than the old INTENT-based gate.
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "no" }] })     // isReadinessQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "There's a blocking question about session TTL. Resolve it before finalizing." }] }) // runAgent — text-only

    setConfirmedAgent(featureKey("onboarding"), "ux-design" as any)
    await handleFeatureChannelMessage(makeParams())

    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })
})

// ─── Bug #9: gap detection history persistence ────────────────────────────────
// Regression: gap question was surfaced in Slack but not stored in conversation
// history. On the next turn, the agent had no record of the gap question, so
// a short reply like "Deliberate extension" was uninterpretable.
// Fix: gap message is appended to history as an assistant message.

// Bug #9: gap detection must surface gap in agent response and store it in history.
// In the tool-based system: save_product_spec_draft tool runs auditSpecDraft; if a
// gap is found, the tool result includes { audit: { status: "gap", message: "..." } }.
// The agent then sees this and must reference it in its text response, which gets
// stored in history. The fix ensures the gap info flows through the tool result
// rather than being appended externally (the old DRAFT_SPEC text-block approach).

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

describe("bug #9 — gap detection: gap question is stored in history", () => {
  it("gap message appears in conversation history so agent can interpret next reply", async () => {
    setupGapScenario()

    setConfirmedAgent(featureKey("onboarding"), "pm" as any)
    await handleFeatureChannelMessage(makeParams("let's keep going"))

    const history = getHistory(featureKey("onboarding"))
    const assistantMessages = history.filter(m => m.role === "assistant")
    expect(assistantMessages.length).toBeGreaterThan(0)

    const allAssistantContent = assistantMessages.map(m => m.content).join("\n")
    expect(allAssistantContent).toContain("Gap detected")
    expect(allAssistantContent).toContain("deliberate extension")
  })

  it("draft is saved even when a gap is detected", async () => {
    setupGapScenario()

    setConfirmedAgent(featureKey("onboarding"), "pm" as any)
    await handleFeatureChannelMessage(makeParams("let's keep going"))

    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })
})
