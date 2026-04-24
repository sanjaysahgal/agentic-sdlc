/**
 * Cross-Context E2E Tests
 *
 * These tests exercise multi-step user journeys across different contexts
 * (general channel, feature channels, slash commands) to verify that actions
 * in one context never corrupt state in another.
 *
 * Every cross-context regression we've had (slash command contamination,
 * thread agent leaking into features) would be caught by these tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetContent     = vi.hoisted(() => vi.fn())
const mockGetRef         = vi.hoisted(() => vi.fn())
const mockCreateRef      = vi.hoisted(() => vi.fn())
const mockDeleteRef      = vi.hoisted(() => vi.fn())
const mockCreateOrUpdate = vi.hoisted(() => vi.fn())
const mockPaginate       = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockAnthropicCreate = vi.hoisted(() => vi.fn())

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(function () {
    return {
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdate,
        listBranches: vi.fn(),
      },
      git: { getRef: mockGetRef, createRef: mockCreateRef, deleteRef: mockDeleteRef },
      paginate: mockPaginate,
    }
  }),
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } }
  }),
}))

import {
  getConfirmedAgent, setConfirmedAgent, clearHistory,
  getThreadAgent, setThreadAgent, getHistory,
  disableFilePersistence,
} from "../../runtime/conversation-store"
import { handleFeatureChannelMessage, getChannelState } from "../../interfaces/slack/handlers/message"
import { clearSummaryCache } from "../../runtime/conversation-summarizer"

disableFilePersistence()

function makeClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "msg-ts" }),
      update: vi.fn().mockResolvedValue({}),
    },
    files: { uploadV2: vi.fn().mockRejectedValue(new Error("no scope")) },
  }
}

function makeParams(threadTs: string, channelName: string, userMessage: string) {
  return {
    channelName,
    threadTs,
    channelId: "C123",
    client: makeClient(),
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

// ─── CROSS-CONTEXT TESTS ────────────────────────────────────────────────────

describe("Cross-Context E2E: actions in one context must not affect another", () => {
  beforeEach(() => {
    clearHistory("onboarding")
    clearHistory("auth")
    clearSummaryCache("onboarding")
    clearSummaryCache("auth")
    vi.clearAllMocks()
    mockPaginate.mockResolvedValue([])
    mockGetContent.mockRejectedValue(new Error("Not Found"))
  })

  // ─── Test 1: Slash command in feature channel → next normal message unaffected

  it("slash command override in feature channel does not persist — next message routes to phase agent", async () => {
    // Set up: onboarding is in PM phase
    setConfirmedAgent("onboarding", "pm")

    // Step 1: @design: temporary override (simulates slash command converting to @prefix)
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Design response." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })   // identifyUncommittedDecisions

    await handleFeatureChannelMessage(makeParams("ctx-1a", "feature-onboarding", "@design: show me the screens"))

    // confirmedAgent must still be PM — @design: was temporary
    expect(getConfirmedAgent("onboarding")).toBe("pm")

    // Step 2: Normal message — should route to PM (the phase agent), not design
    mockAnthropicCreate
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "PM response." }] })

    await handleFeatureChannelMessage(makeParams("ctx-1b", "feature-onboarding", "what about the error path?"))

    // Still PM
    expect(getConfirmedAgent("onboarding")).toBe("pm")
  })

  // ─── Test 2: Multi-feature isolation

  it("setting confirmedAgent for feature A does not affect feature B routing", async () => {
    // Set up two features
    setConfirmedAgent("onboarding", "pm")
    setConfirmedAgent("auth", "architect")

    // Send message to onboarding
    mockAnthropicCreate
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "PM onboarding response." }] })

    await handleFeatureChannelMessage(makeParams("ctx-2a", "feature-onboarding", "how is the spec?"))

    // Onboarding is PM, auth is still architect
    expect(getConfirmedAgent("onboarding")).toBe("pm")
    expect(getConfirmedAgent("auth")).toBe("architect")
  })

  // ─── Test 3: Thread agent isolation from features

  it("setThreadAgent for general channel does not affect feature confirmedAgent", () => {
    setConfirmedAgent("onboarding", "architect")

    // Simulate slash command setting thread agent in general channel
    setThreadAgent("general-thread-456", "pm")

    // Feature agent unchanged
    expect(getConfirmedAgent("onboarding")).toBe("architect")

    // Thread agent set
    expect(getThreadAgent("general-thread-456")).toBe("pm")

    // Feature history separate from thread history
    expect(getHistory("onboarding")).toHaveLength(0)
    expect(getHistory("general:general-thread-456")).toHaveLength(0)
  })

  // ─── Test 4: History isolation across features

  it("messages in feature A do not appear in feature B history", async () => {
    setConfirmedAgent("onboarding", "pm")
    setConfirmedAgent("auth", "pm")

    // Send to onboarding
    mockAnthropicCreate
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Onboarding answer." }] })

    await handleFeatureChannelMessage(makeParams("ctx-4a", "feature-onboarding", "onboarding question"))

    // Onboarding has history, auth does not
    expect(getHistory("onboarding").length).toBeGreaterThan(0)
    expect(getHistory("auth")).toHaveLength(0)
  })

  // ─── Test 5: Phase correction after stale state

  it("stale confirmedAgent is corrected by resolveAgent on next message", async () => {
    const PRODUCT_SPEC = Buffer.from("# PM Spec").toString("base64")
    const DESIGN_SPEC = Buffer.from("# Design Spec").toString("base64")

    // Stale state: confirmedAgent=pm but feature is in engineering phase
    setConfirmedAgent("onboarding", "pm")

    // Mock GitHub: product + design specs on main, engineering branch exists
    mockPaginate.mockResolvedValueOnce([
      { name: "spec/onboarding-product" },
      { name: "spec/onboarding-design" },
    ])
    mockGetContent.mockImplementation(({ path }: { path?: string }) => {
      if (path?.endsWith("onboarding.product.md")) return Promise.resolve({ data: { content: PRODUCT_SPEC, type: "file" } })
      if (path?.endsWith("onboarding.design.md")) return Promise.resolve({ data: { content: DESIGN_SPEC, type: "file" } })
      return Promise.reject(new Error("Not Found"))
    })

    // Architect path mocks — architect has upstream audits that make additional API calls
    mockAnthropicCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // upstream PM audit (auditPhaseCompletion)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // upstream design audit (auditPhaseCompletion)
      .mockResolvedValueOnce({ content: [{ type: "text", text: "PASS" }] })   // engineering readiness audit (auditPhaseCompletion)
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Architect response." }] })  // runAgent
      .mockResolvedValueOnce({ content: [{ type: "text", text: "none" }] })   // identifyUncommittedDecisions

    await handleFeatureChannelMessage(makeParams("ctx-5", "feature-onboarding", "what's the data model?"))

    // resolveAgent corrected pm → architect
    expect(getConfirmedAgent("onboarding")).toBe("architect")
  })
})
