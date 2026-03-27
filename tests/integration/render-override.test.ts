import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Regression suite for render/preview override behavior.
//
// These tests protect the exact content of PLATFORM OVERRIDE text injected
// into the design agent's system prompt and user message for render-only and
// apply-and-render intents. A prompt change that changes agent behavior without
// changing mechanics (routing, block parsing) would previously pass CI silently.
//
// Call order for design agent render-only path:
//   [0] isOffTopicForAgent
//   [1] isSpecStateQuery
//   [2] detectRenderIntent → "render-only"
//   [3] extractLockedDecisions (fires when history ≥ 6)
//   [4] runAgent — receives system prompt with PLATFORM OVERRIDE prepended

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
const THREAD = "thread-render-override"

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
    appendMessage(THREAD, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
  }
}

// Gets the system prompt passed to the Sonnet runAgent call.
// system is an array of {type, text, cache_control} blocks in claude-client.ts.
function getSystemPrompt(callIndex: number): string {
  const sys = mockAnthropicCreate.mock.calls[callIndex]?.[0]?.system
  if (Array.isArray(sys)) return sys.map((s: any) => s.text ?? "").join("")
  return sys ?? ""
}

// Gets the last user message content in a Sonnet call
function getLastUserContent(callIndex: number): string {
  const msgs = mockAnthropicCreate.mock.calls[callIndex]?.[0]?.messages as Array<{ role: string; content: string }> ?? []
  return msgs.filter(m => m.role === "user").at(-1)?.content ?? ""
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
  clearHistory(THREAD)
})

afterEach(() => {
  process.env = originalEnv
  clearHistory(THREAD)
})

// ─── render-only override content ─────────────────────────────────────────────

describe("render-only PLATFORM OVERRIDE content", () => {
  it("system prompt override tells agent to list uncommitted decisions BEFORE outputting the block", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })           // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })           // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "render-only" }] })     // [2] detectRenderIntent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })                // [3] extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Preview response." }] }) // [4] runAgent

    await handleFeatureChannelMessage(makeParams("give a new render that is true to the updated spec"))

    const systemPrompt = getSystemPrompt(4)

    // Override is present and at the top
    expect(systemPrompt).toContain("PLATFORM OVERRIDE — MANDATORY")

    // Critical regression guard: agent must list uncommitted decisions FIRST,
    // before outputting the PREVIEW_ONLY block. If this is missing, the user
    // sees a render with no context about what's pending vs committed.
    expect(systemPrompt).toMatch(/list.*uncommitted|uncommitted.*decisions|not yet.*saved/i)

    // Render block must still be required
    expect(systemPrompt).toContain("PREVIEW_ONLY_START")

    // Agent must not be allowed to refuse or offer choices
    expect(systemPrompt).toMatch(/do not.*ask permission|do not.*offer choices/i)
  })

  it("user message also receives the override — belt-and-suspenders", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "render-only" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Preview response." }] })

    await handleFeatureChannelMessage(makeParams("show me the preview"))

    const lastUserMsg = getLastUserContent(4)
    expect(lastUserMsg).toContain("PLATFORM OVERRIDE")
    expect(lastUserMsg).toContain("PREVIEW_ONLY_START")
  })

  it("no override injected when detectRenderIntent returns other", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "other" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Normal response." }] })

    await handleFeatureChannelMessage(makeParams("should we use a dark background?"))

    const systemPrompt = getSystemPrompt(4)
    // No override when it's a normal design question
    expect(systemPrompt).not.toContain("PLATFORM OVERRIDE")
  })
})

// ─── PREVIEW_ONLY truncation recovery ─────────────────────────────────────────

describe("PREVIEW_ONLY truncation recovery", () => {
  it("retries when PREVIEW_ONLY_START is present but PREVIEW_ONLY_END is absent", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    const truncatedPreview = "Some preamble.\nPREVIEW_ONLY_START\n# Spec\n## Direction\nDark mode.\n[truncated]"
    const fullPreview = "PREVIEW_ONLY_START\n# Spec\n## Direction\nDark mode.\nPREVIEW_ONLY_END"

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })        // [0] isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })        // [1] isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "render-only" }] })  // [2] detectRenderIntent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })             // [3] extractLockedDecisions
      .mockResolvedValueOnce({ content: [{ type: "text", text: truncatedPreview }] }) // [4] runAgent — truncated
      .mockResolvedValueOnce({ content: [{ type: "text", text: fullPreview }] })    // [5] retry runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "<html>preview</html>" }] }) // [6] generateDesignPreview

    await handleFeatureChannelMessage(makeParams("give a new render"))

    // Retry must have been called (7 total Anthropic calls including HTML renderer)
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(7)

    // Retry instruction must contain SYSTEM OVERRIDE and PREVIEW_ONLY
    const retryMsg = mockAnthropicCreate.mock.calls[5]?.[0]?.messages?.at(-1)?.content
    expect(retryMsg).toContain("SYSTEM OVERRIDE")
    expect(retryMsg).toContain("PREVIEW_ONLY_START")
    expect(retryMsg).toContain("PREVIEW_ONLY_END")
  })

  it("shows graceful fallback message when retry also fails to produce PREVIEW_ONLY_END", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")
    const client = makeClient()

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "render-only" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PREVIEW_ONLY_START\ntruncated again" }] }) // truncated
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PREVIEW_ONLY_START\nstill truncated" }] }) // retry also truncated

    await handleFeatureChannelMessage(makeParams("give a new render", client))

    const lastUpdate = client.chat.update.mock.calls.at(-1)?.[0]?.text ?? ""
    expect(lastUpdate).toMatch(/too large|specific section|approved/i)
  })
})

// ─── apply-and-render override content ────────────────────────────────────────

describe("apply-and-render PLATFORM OVERRIDE content", () => {
  it("system prompt override forces PATCH block output with no permission-asking", async () => {
    seedHistory()
    setConfirmedAgent(THREAD, "ux-design")

    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "apply-and-render" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "" }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Applied." }] })

    await handleFeatureChannelMessage(makeParams("apply the changes we discussed and show me"))

    const systemPrompt = getSystemPrompt(4)
    expect(systemPrompt).toContain("PLATFORM OVERRIDE — MANDATORY")
    expect(systemPrompt).toContain("DESIGN_PATCH_START")
    expect(systemPrompt).toMatch(/do not.*ask permission|do not.*offer/i)
  })
})
