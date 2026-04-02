import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Integration tests for the post-response uncommitted decisions audit.
//
// After every design agent response, the platform checks whether any save tool
// was called (save_design_spec_draft, apply_design_spec_patch, finalize_design_spec).
// If no save tool was called AND history > 6 messages, the platform calls
// identifyUncommittedDecisions and, if uncommitted decisions exist, appends a
// note to the response pointing the user to "save those".
//
// Design agent call order (no save tool invoked):
//   [0] isOffTopicForAgent
//   [1] isSpecStateQuery
//   [2] extractLockedDecisions (fires when history ≥ 6)
//   [3] runAgent — text-only response (no tool calls)
//   [4] identifyUncommittedDecisions (post-response audit, fires when history > 6)

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
import { clearHistory, clearLegacyMessages, setConfirmedAgent, appendMessage } from "../../../runtime/conversation-store"
import { clearSummaryCache } from "../../../runtime/conversation-summarizer"

const originalEnv = process.env
const THREAD = "thread-render-override"
const FEATURE = "onboarding"

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

function seedHistory(count = 7) {
  for (let i = 0; i < count; i++) {
    appendMessage(FEATURE, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
  }
}

function lastUpdateText(client: ReturnType<typeof makeClient>): string {
  const calls = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls
  return calls.at(-1)?.[0]?.text ?? ""
}

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
  mockOctokitPaginate.mockResolvedValue([])
  mockOctokitGetContent.mockRejectedValue(new Error("Not Found"))
  mockOctokitGetRef.mockResolvedValue({ data: { object: { sha: "abc123" } } })
  mockOctokitCreateRef.mockResolvedValue({})
  clearHistory(FEATURE)
  clearLegacyMessages()
  clearSummaryCache(FEATURE)
})

afterEach(() => {
  process.env = originalEnv
  clearHistory(FEATURE)
  clearSummaryCache(FEATURE)
})

// ─── Post-response uncommitted decisions audit ─────────────────────────────────

describe("post-response uncommitted decisions audit", () => {
  it("appends uncommitted note when no save tool called and history > 6", async () => {
    seedHistory(7)
    setConfirmedAgent(FEATURE, "ux-design")

    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] extractLockedDecisions,
    // [3] runAgent (text-only, no tool calls), [4] identifyUncommittedDecisions
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })               // extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "I recommend dark mode as the default." }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "1. Dark mode default: I recommend dark mode — discussed in thread\n2. Chip positioning: I recommend above prompt bar — agreed" }] }) // identifyUncommittedDecisions

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("let's keep refining", client))

    const text = lastUpdateText(client)
    // Post-response audit note must be appended
    expect(text).toContain("save those")
    // Original agent response is also present
    expect(text).toContain("I recommend dark mode")
  })

  it("skips uncommitted note when no decisions discussed (fresh conversation)", async () => {
    // No seedHistory — audit now fires on every turn, but classifier returns "all committed"
    setConfirmedAgent(FEATURE, "ux-design")

    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] runAgent, [3] identifyUncommittedDecisions
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Let's start with the layout direction." }] }) // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "All discussed decisions appear to be in the committed spec" }] }) // identifyUncommittedDecisions

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("what should we design first?", client))

    const text = lastUpdateText(client)
    expect(text).not.toContain("save those")
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(4)
  })

  it("skips uncommitted note when save tool was called", async () => {
    seedHistory(7)
    setConfirmedAgent(FEATURE, "ux-design")

    // [0] isOffTopicForAgent, [1] isSpecStateQuery, [2] extractLockedDecisions,
    // [3] runAgent (tool_use: apply_design_spec_patch), [4] generateDesignPreview (in tool handler),
    // [5] runAgent (end_turn text) — no identifyUncommittedDecisions since didSave = true
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })          // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })               // extractLockedDecisions
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "apply_design_spec_patch", input: { patch: "## Design Direction\nDark mode." } }],
      })                                                                               // runAgent: tool_use
      .mockResolvedValueOnce({ content: [{ type: "text", text: "<html>preview</html>" }] }) // generateDesignPreview
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Saved the dark mode decision to the spec." }] }) // runAgent: end_turn

    const client = makeClient()
    await handleFeatureChannelMessage(makeParams("lock in dark mode", client))

    const text = lastUpdateText(client)
    // Save tool was called → no uncommitted note appended
    expect(text).not.toContain("save those")
    // Draft was saved to GitHub
    expect(mockOctokitCreateOrUpdate).toHaveBeenCalled()
  })
})
