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
  clearHistory("onboarding")
})

afterEach(() => {
  process.env = originalEnv
  clearHistory("onboarding")
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

describe("bug #8 — blocking gate: spec with [blocking: yes] questions is never saved", () => {
  it("PM agent does not save when blocking questions remain", async () => {
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })
      .mockResolvedValueOnce({
        content: [{
          type: "text",
          text: "INTENT: CREATE_SPEC\n## Problem\nHelp users.\n\n## Open Questions\n- [type: product] [blocking: yes] Who is the primary user?",
        }],
      })

    setConfirmedAgent("onboarding", "pm" as any)
    await handleFeatureChannelMessage(makeParams())

    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()

    const history = getHistory("onboarding")
    const lastAssistant = history.filter(m => m.role === "assistant").at(-1)
    expect(lastAssistant?.content).toContain("Approval blocked")
    expect(lastAssistant?.content).toContain("Who is the primary user")
  })

  it("Design agent does not save when blocking questions remain", async () => {
    // Design agent makes 3 Anthropic calls: isOffTopicForAgent, isSpecStateQuery, runAgent.
    // Use mockResolvedValue (persistent) so all 3 calls return the intent, which is fine:
    // "INTENT: CREATE_DESIGN_SPEC" is not "off-topic" and not "yes", so the first two
    // classifiers return false and the flow proceeds to runAgent which gets the INTENT.
    mockAnthropicCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: "INTENT: CREATE_DESIGN_SPEC\n## Screens\n\n## Open Questions\n- [type: product] [blocking: yes] What is the session TTL?",
      }],
    })

    setConfirmedAgent("onboarding", "ux-design" as any)
    await handleFeatureChannelMessage(makeParams())

    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })
})

// ─── Bug #9: gap detection history persistence ────────────────────────────────
// Regression: gap question was surfaced in Slack but not stored in conversation
// history. On the next turn, the agent had no record of the gap question, so
// a short reply like "Deliberate extension" was uninterpretable.
// Fix: gap message is appended to history as an assistant message.

function setupGapScenario() {
  const encodedVision = Buffer.from("The product vision: health tracking for everyday users.").toString("base64")
  mockOctokitGetContent.mockResolvedValue({ data: { content: encodedVision, type: "file" } })

  mockAnthropicCreate
    .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
    .mockResolvedValueOnce({ content: [{ type: "text", text: "DRAFT_SPEC_START\n## Problem\nHelp users.\n## Open Questions\n- [type: product] [blocking: no] Define power user.\nDRAFT_SPEC_END" }] }) // runAgent
    .mockResolvedValueOnce({ content: [{ type: "text", text: "GAP: Power user persona is not defined in the product vision." }] }) // auditSpecDraft

  mockOctokitCreateOrUpdate.mockResolvedValue({})
}

describe("bug #9 — gap detection: gap question is stored in history", () => {
  it("gap message appears in conversation history so agent can interpret next reply", async () => {
    setupGapScenario()

    setConfirmedAgent("onboarding", "pm" as any)
    await handleFeatureChannelMessage(makeParams("let's keep going"))

    const history = getHistory("onboarding")
    const assistantMessages = history.filter(m => m.role === "assistant")
    expect(assistantMessages.length).toBeGreaterThan(0)

    const allAssistantContent = assistantMessages.map(m => m.content).join("\n")
    expect(allAssistantContent).toContain("Gap detected")
    expect(allAssistantContent).toContain("deliberate extension")
  })

  it("draft is saved even when a gap is detected", async () => {
    setupGapScenario()

    setConfirmedAgent("onboarding", "pm" as any)
    await handleFeatureChannelMessage(makeParams("let's keep going"))

    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })
})
