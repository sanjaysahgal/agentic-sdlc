import { describe, it, expect, vi, beforeEach } from "vitest"

// Regression tests for approval detection false positives.
// Each test documents a specific production incident where the wrong signal
// triggered spec approval, saving a spec the user never intended to approve.
//
// Bugs tracked here:
//   #4 — isSpecStateQuery false positive: "yes please and I assume you will
//        base it exactly on how our spec is written today?" was classified as
//        a state query (because it contained "spec"), triggering a fast-path
//        state-summary response and appending only the assistant message → #1.
//   #5 — isSpecStateQuery false positive: "lets lock option A" was classified
//        as a state query, short-circuiting to state summary instead of routing
//        to the agent as a normal decision message.
//   #6 — Premature spec approval: "lets lock option A" (confirming a single
//        design decision) triggered INTENT: CREATE_DESIGN_SPEC because approval
//        detection was too broad. Fix: two-step PendingApproval flow — INTENT
//        shows a confirmation prompt, user must reply "confirmed" to save.
//
// isSpecStateQuery tests mock only the Anthropic client (unit-level).
// Premature approval tests run the full message handler path.

// ─── isSpecStateQuery unit tests ─────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { isSpecStateQuery } from "../../../runtime/agent-router"

describe("bug #4 — isSpecStateQuery: affirmations containing 'spec' are not state queries", () => {
  beforeEach(() => mockCreate.mockReset())

  it("'yes please and I assume you will base it exactly on how our spec is written today?' → false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no" }] })
    const result = await isSpecStateQuery(
      "yes please and I assume you will base it exactly on how our spec is written today?"
    )
    expect(result).toBe(false)
  })

  it("plain 'yes please' → false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no" }] })
    expect(await isSpecStateQuery("yes please")).toBe(false)
  })

  it("'sure go ahead' → false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no" }] })
    expect(await isSpecStateQuery("sure go ahead")).toBe(false)
  })
})

describe("bug #5 — isSpecStateQuery: decision confirmations are not state queries", () => {
  beforeEach(() => mockCreate.mockReset())

  it("'lets lock option A' → false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no" }] })
    expect(await isSpecStateQuery("lets lock option A")).toBe(false)
  })

  it("'yes lock option A' → false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no" }] })
    expect(await isSpecStateQuery("yes lock option A")).toBe(false)
  })

  it("'ok let's go with option 2' → false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no" }] })
    expect(await isSpecStateQuery("ok let's go with option 2")).toBe(false)
  })

  // Positive controls — these should still return true
  it("'current state?' → true", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "yes" }] })
    expect(await isSpecStateQuery("current state?")).toBe(true)
  })

  it("'where are we with this?' → true", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "yes" }] })
    expect(await isSpecStateQuery("where are we with this?")).toBe(true)
  })
})

// ─── Bug #6: premature spec approval ─────────────────────────────────────────
// Full-path integration tests. These require the Octokit mock as well.

const mockOctokitGetContent = vi.hoisted(() => vi.fn())
const mockOctokitGetRef = vi.hoisted(() => vi.fn())
const mockOctokitCreateRef = vi.hoisted(() => vi.fn())
const mockOctokitCreateOrUpdate = vi.hoisted(() => vi.fn())
const mockOctokitPaginate = vi.hoisted(() => vi.fn())
// Note: Anthropic is already mocked above (mockCreate). The integration tests
// use mockCreate directly — there is only one @anthropic-ai/sdk mock per file.

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

const makeParams = (userMessage: string) => ({
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

describe("bug #6 — premature spec approval: text-only agent responses must never save the spec", () => {
  it("PM agent: text-only response never calls createOrUpdateFileContents (tools required for saves)", async () => {
    // In the tool-based system, the PM agent can only save specs by calling
    // save_product_spec_draft, apply_product_spec_patch, or finalize_product_spec tools.
    // A text-only response (no tool calls) must never trigger a save.
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "feature-specific" }] }) // classifyMessageScope
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "I recommend option A for the data model. Here's why..." }],
      }) // runAgent — text-only, no tool calls

    setConfirmedAgent("onboarding", "pm" as any)
    await handleFeatureChannelMessage(makeParams("lets lock option A"))

    // Text-only response → no save of any kind
    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })

  it("Design agent: text-only response never saves spec", async () => {
    // Design agent makes 3 Anthropic calls: isOffTopicForAgent, isSpecStateQuery, runAgent.
    // A text-only response from runAgent (no tool calls) must not save anything.
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] }) // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] }) // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "I recommend dark mode as the default. Want me to lock this in?" }] }) // runAgent — text-only
    mockOctokitCreateOrUpdate.mockResolvedValue({})

    setConfirmedAgent("onboarding", "ux-design" as any)

    await handleFeatureChannelMessage(makeParams("approved"))
    // Text response — no save triggered
    expect(mockOctokitCreateOrUpdate).not.toHaveBeenCalled()
  })
})
