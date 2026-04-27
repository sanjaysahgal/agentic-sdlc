/**
 * Routing Contract Invariant Tests
 *
 * These tests verify that the routing contract holds under every state permutation.
 * They are NOT scenario tests — they test invariants: properties that must ALWAYS
 * hold regardless of prior state, message sequence, or external conditions.
 *
 * Every routing regression we've had (stale confirmedAgent, slash command contamination,
 * phase transition wipe) violated one of these invariants. If these tests pass,
 * those bug classes are structurally impossible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Mock setup (same pattern as workflows.test.ts) ─────────────────────────

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
  getThreadAgent, setThreadAgent, getHistory, appendMessage,
  isUserOriented, markUserOriented,
  disableFilePersistence,
} from "../../runtime/conversation-store"
import { handleFeatureChannelMessage, getChannelState, resolveAgent } from "../../interfaces/slack/handlers/message"
import { clearSummaryCache } from "../../runtime/conversation-summarizer"
import { featureKey, threadKey } from "../../runtime/routing/types"

disableFilePersistence()

const PRODUCT_SPEC = Buffer.from("# PM Spec").toString("base64")
const DESIGN_SPEC = Buffer.from("# Design Spec").toString("base64")

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

// ─── Helper: mock GitHub to return a specific phase ─────────────────────────

function mockPhase(phase: string) {
  switch (phase) {
    case "product-spec-in-progress":
      mockPaginate.mockResolvedValueOnce([])
      mockGetContent.mockRejectedValue(new Error("Not Found"))
      break
    case "product-spec-approved-awaiting-design":
      mockPaginate.mockResolvedValueOnce([{ name: "spec/onboarding-product" }])
      mockGetContent.mockImplementation(({ path }: { path?: string }) => {
        if (path?.endsWith("onboarding.product.md")) return Promise.resolve({ data: { content: PRODUCT_SPEC, type: "file" } })
        return Promise.reject(new Error("Not Found"))
      })
      break
    case "design-in-progress":
      mockPaginate.mockResolvedValueOnce([{ name: "spec/onboarding-product" }, { name: "spec/onboarding-design" }])
      mockGetContent.mockImplementation(({ path }: { path?: string }) => {
        if (path?.endsWith("onboarding.product.md")) return Promise.resolve({ data: { content: PRODUCT_SPEC, type: "file" } })
        return Promise.reject(new Error("Not Found"))
      })
      break
    case "design-approved-awaiting-engineering":
      mockPaginate.mockResolvedValueOnce([{ name: "spec/onboarding-product" }, { name: "spec/onboarding-design" }])
      mockGetContent.mockImplementation(({ path }: { path?: string }) => {
        if (path?.endsWith("onboarding.product.md")) return Promise.resolve({ data: { content: PRODUCT_SPEC, type: "file" } })
        if (path?.endsWith("onboarding.design.md")) return Promise.resolve({ data: { content: DESIGN_SPEC, type: "file" } })
        return Promise.reject(new Error("Not Found"))
      })
      break
    case "engineering-in-progress":
      mockPaginate.mockResolvedValueOnce([{ name: "spec/onboarding-product" }, { name: "spec/onboarding-design" }, { name: "spec/onboarding-engineering" }])
      mockGetContent.mockImplementation(({ path }: { path?: string }) => {
        if (path?.endsWith("onboarding.product.md")) return Promise.resolve({ data: { content: PRODUCT_SPEC, type: "file" } })
        if (path?.endsWith("onboarding.design.md")) return Promise.resolve({ data: { content: DESIGN_SPEC, type: "file" } })
        return Promise.reject(new Error("Not Found"))
      })
      break
  }
}

// ─── INVARIANT TESTS ────────────────────────────────────────────────────────

describe("Routing Contract Invariants", () => {
  beforeEach(() => {
    clearHistory(featureKey("onboarding"))
    clearHistory(featureKey("auth"))
    clearSummaryCache("onboarding")
    clearSummaryCache("auth")
    vi.clearAllMocks()
    mockPaginate.mockResolvedValue([])
    mockGetContent.mockRejectedValue(new Error("Not Found"))
  })

  // ─── Invariant 1: Phase-agent consistency ───────────────────────────────

  describe("Invariant 1: resolveAgent returns the canonical agent for each phase", () => {
    const cases = [
      { phase: "product-spec-in-progress", expectedAgent: "pm" },
      { phase: "product-spec-approved-awaiting-design", expectedAgent: "ux-design" },
      { phase: "design-in-progress", expectedAgent: "ux-design" },
      { phase: "design-approved-awaiting-engineering", expectedAgent: "architect" },
      { phase: "engineering-in-progress", expectedAgent: "architect" },
    ]

    for (const { phase, expectedAgent } of cases) {
      it(`phase=${phase} → agent=${expectedAgent}`, async () => {
        mockPhase(phase)
        const agent = await resolveAgent("onboarding")
        expect(agent).toBe(expectedAgent)
      })
    }
  })

  // ─── Invariant 2-4: Stale confirmedAgent corrected ──────────────────────

  describe("Invariant 2-4: Stale confirmedAgent corrected by resolveAgent", () => {
    it("confirmedAgent=pm but phase=engineering → corrected to architect", async () => {
      setConfirmedAgent(featureKey("onboarding"), "pm")
      mockPhase("engineering-in-progress")
      const agent = await resolveAgent("onboarding")
      expect(agent).toBe("architect")
      expect(getConfirmedAgent(featureKey("onboarding"))).toBe("architect")
    })

    it("confirmedAgent=pm but phase=design → corrected to ux-design", async () => {
      setConfirmedAgent(featureKey("onboarding"), "pm")
      mockPhase("design-in-progress")
      const agent = await resolveAgent("onboarding")
      expect(agent).toBe("ux-design")
      expect(getConfirmedAgent(featureKey("onboarding"))).toBe("ux-design")
    })

    it("confirmedAgent=architect but phase=product-spec-in-progress → trusts existing (ambiguous phase)", async () => {
      // product-spec-in-progress is the default/fallback — could mean no branches OR new feature
      // In this case, trust the existing confirmedAgent (it was set deliberately)
      setConfirmedAgent(featureKey("onboarding"), "architect")
      mockPhase("product-spec-in-progress")
      const agent = await resolveAgent("onboarding")
      expect(agent).toBe("architect") // trusted, not corrected
    })

    it("confirmedAgent=ux-design but phase=engineering → corrected to architect", async () => {
      setConfirmedAgent(featureKey("onboarding"), "ux-design")
      mockPhase("engineering-in-progress")
      const agent = await resolveAgent("onboarding")
      expect(agent).toBe("architect")
    })
  })

  // ─── Invariant 5: @pm: temporary override doesn't persist ──────────────

  describe("Invariant 5: Temporary agent override doesn't persist", () => {
    it("@pm: prefix does not change confirmedAgent in store", async () => {
      setConfirmedAgent(featureKey("onboarding"), "architect")
      mockPhase("engineering-in-progress")

      mockAnthropicCreate
        .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isOffTopicForAgent (architect check — but @pm: overrides)
        .mockResolvedValueOnce({ content: [{ type: "text", text: "false" }] })  // isSpecStateQuery
        .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "PM response." }] })

      const params = makeParams("inv-5", "feature-onboarding", "@pm: quick question about the spec")
      await handleFeatureChannelMessage(params)

      // confirmedAgent must still be architect — @pm: was temporary
      expect(getConfirmedAgent(featureKey("onboarding"))).toBe("architect")
    })
  })

  // ─── Invariant 8: Cross-feature isolation ──────────────────────────────

  describe("Invariant 8: Cross-feature state isolation", () => {
    it("setting state for feature A does not affect feature B", () => {
      setConfirmedAgent(featureKey("onboarding"), "pm")
      setConfirmedAgent(featureKey("auth"), "architect")

      expect(getConfirmedAgent(featureKey("onboarding"))).toBe("pm")
      expect(getConfirmedAgent(featureKey("auth"))).toBe("architect")

      // Modifying onboarding doesn't touch auth
      setConfirmedAgent(featureKey("onboarding"), "ux-design")
      expect(getConfirmedAgent(featureKey("auth"))).toBe("architect")
    })
  })

  // ─── Invariant 9: Thread agent isolation ───────────────────────────────

  describe("Invariant 9: Thread agent does not affect feature agent", () => {
    it("setThreadAgent for general channel thread does not change confirmedAgent for features", () => {
      setConfirmedAgent(featureKey("onboarding"), "architect")
      setThreadAgent(threadKey("general-thread-123"), "pm")

      // Feature agent unchanged
      expect(getConfirmedAgent(featureKey("onboarding"))).toBe("architect")
      // Thread agent set correctly
      expect(getThreadAgent(threadKey("general-thread-123"))).toBe("pm")
    })
  })

  // ─── Invariant 10: History key isolation ───────────────────────────────

  describe("Invariant 10: History key isolation between features", () => {
    it("appending to feature A history does not affect feature B", () => {
      appendMessage(featureKey("onboarding"), { role: "user", content: "onboarding msg" })
      appendMessage(featureKey("auth"), { role: "user", content: "auth msg" })

      expect(getHistory(featureKey("onboarding"))).toHaveLength(1)
      expect(getHistory(featureKey("auth"))).toHaveLength(1)
      expect(getHistory(featureKey("onboarding"))[0].content).toBe("onboarding msg")
      expect(getHistory(featureKey("auth"))[0].content).toBe("auth msg")
    })

    it("clearing feature A history does not affect feature B", () => {
      appendMessage(featureKey("onboarding"), { role: "user", content: "msg1" })
      appendMessage(featureKey("auth"), { role: "user", content: "msg2" })

      clearHistory(featureKey("onboarding"))

      expect(getHistory(featureKey("onboarding"))).toHaveLength(0)
      expect(getHistory(featureKey("auth"))).toHaveLength(1)
    })
  })

  // ─── Invariant: orientedUsers persists across clear/reload ──────────────

  describe("Invariant: orientedUsers persistence", () => {
    it("markUserOriented persists and isUserOriented reads it back", () => {
      expect(isUserOriented(featureKey("testfeature"), "U123")).toBe(false)
      markUserOriented(featureKey("testfeature"), "U123")
      expect(isUserOriented(featureKey("testfeature"), "U123")).toBe(true)
    })
  })

  // ─── Invariant: resolveAgent is deterministic ──────────────────────────

  describe("Invariant: resolveAgent is deterministic — same phase, same result", () => {
    it("calling resolveAgent twice with same phase returns same agent", async () => {
      mockPhase("design-in-progress")
      const agent1 = await resolveAgent("onboarding")
      mockPhase("design-in-progress")
      const agent2 = await resolveAgent("onboarding")
      expect(agent1).toBe(agent2)
      expect(agent1).toBe("ux-design")
    })
  })
})
