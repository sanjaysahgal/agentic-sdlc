import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Regression tests for conversation history shape bugs.
// Each test documents a specific production incident where history corruption
// caused Anthropic API 400 errors that surfaced as "Something went wrong".
//
// Bugs tracked here:
//   #1 — Fast-path early returns only appended assistant message, skipping the
//        user message. Next API call had consecutive [assistant, assistant] → 400.
//   #2 — appendMessage(user) was called BEFORE runAgent. If runAgent threw,
//        the user message stayed in history, accumulating on each retry.
//   #3 — Corrupted history (leading assistant from #1) caused every subsequent
//        Anthropic call to fail with 400, making the thread permanently broken.
//
// The Anthropic API requires strictly alternating user/assistant messages
// starting with user. Any violation → 400 → "Something went wrong".

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
import { clearHistory, setConfirmedAgent, getHistory, appendMessage } from "../../../runtime/conversation-store"

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

const makeParams = (overrides: Partial<{ userMessage: string }> = {}) => ({
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
  userMessage: overrides.userMessage ?? "approved",
})

// ─── Bug #1: fast-path off-topic missing user message ─────────────────────────
// Regression: fast-path early returns only appended assistant → consecutive
// [assistant, assistant] on next call → Anthropic 400 → "Something went wrong"

describe("bug #1 — fast-path off-topic appends user then assistant (never assistant-only)", () => {
  it("off-topic redirect appends user then assistant in correct order", async () => {
    setConfirmedAgent("onboarding", "ux-design" as any)
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "off-topic" }] })

    await handleFeatureChannelMessage(makeParams({ userMessage: "what features are in progress globally?" }))

    const history = getHistory("onboarding")
    expect(history.length).toBe(2)
    expect(history[0].role).toBe("user")
    expect(history[1].role).toBe("assistant")
  })
})

// ─── Bug #2: duplicate user messages on retry ─────────────────────────────────
// Regression: appendMessage(user) before runAgent left the user message in
// history when runAgent threw. Retries accumulated duplicate user entries,
// causing Anthropic 400 on the next real call.

describe("bug #2 — failed agent call leaves no user message in history", () => {
  it("user message is not stored when the agent call fails", async () => {
    setConfirmedAgent("onboarding", "pm" as any)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })
      .mockRejectedValueOnce(new Error("API overloaded"))

    // withThinking re-throws after logging — catch it so the test can assert history
    await handleFeatureChannelMessage(makeParams({ userMessage: "let's refine the scope" })).catch(() => {})

    const history = getHistory("onboarding")
    expect(history.filter(m => m.role === "user")).toHaveLength(0)
  })
})

// ─── Bug #3: corrupted history causing permanent "Something went wrong" ────────
// Regression: a single fast-path bug (#1) produced [assistant] as the first
// history entry. Every subsequent call passed that to Anthropic → 400 → the
// thread was permanently broken until the server restarted.
// Fix: runAgent sanitizes history before the API call (strips leading assistants,
// collapses consecutive same-role messages).

describe("bug #3 — corrupted history (leading assistant) is sanitized", () => {
  it("subsequent call succeeds even when history starts with assistant", async () => {
    setConfirmedAgent("onboarding", "pm" as any)

    // Inject corrupted state: history starts with assistant (as happens after bug #1)
    appendMessage("onboarding", { role: "assistant", content: "Fast-path response with no preceding user message." })

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is my answer." }] })

    // This must NOT throw — sanitization makes the API call valid
    await handleFeatureChannelMessage(makeParams({ userMessage: "what are the open questions?" }))

    const history = getHistory("onboarding")
    const last2 = history.slice(-2)
    expect(last2[0].role).toBe("user")
    expect(last2[1].role).toBe("assistant")
    expect(last2[1].content).toContain("Here is my answer")
  })
})

// ─── Invariant: history is always strictly alternating ────────────────────────

describe("invariant — no consecutive same-role messages after a normal turn", () => {
  it("history alternates user/assistant after each successful turn", async () => {
    setConfirmedAgent("onboarding", "pm" as any)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Here is my answer." }] })

    await handleFeatureChannelMessage(makeParams({ userMessage: "tell me about the feature" }))

    const history = getHistory("onboarding")
    for (let i = 1; i < history.length; i++) {
      expect(history[i].role).not.toBe(history[i - 1].role)
    }
  })
})
