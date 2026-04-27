import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { featureKey } from "../../runtime/routing/types"

// conversation-store calls fs.readFileSync at module load (loadConfirmedAgents).
// Mock fs so tests never touch disk and module state is isolated per test.
// Use vi.hoisted() so the mock functions are available when the factory runs
// (vi.mock factories are hoisted above module-level code).
const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT: no such file")
  }),
  writeFileSync: vi.fn(),
}))

vi.mock("fs", () => ({
  default: fsMocks,
}))

describe("conversation-store", () => {
  beforeEach(() => {
    vi.resetModules()
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file")
    })
    fsMocks.writeFileSync.mockReset()
  })

  it("getHistory returns empty array for unknown thread", async () => {
    const { getHistory } = await import("../../runtime/conversation-store")
    expect(getHistory(featureKey("thread-unknown"))).toEqual([])
  })

  it("appendMessage adds message to thread history", async () => {
    const { getHistory, appendMessage } = await import("../../runtime/conversation-store")
    appendMessage(featureKey("thread-1"), { role: "user", content: "Hello" })
    expect(getHistory(featureKey("thread-1"))).toEqual([{ role: "user", content: "Hello" }])
  })

  it("appendMessage is additive — second call appends, does not replace", async () => {
    const { getHistory, appendMessage } = await import("../../runtime/conversation-store")
    appendMessage(featureKey("thread-1"), { role: "user", content: "Hello" })
    appendMessage(featureKey("thread-1"), { role: "assistant", content: "Hi there" })
    const history = getHistory(featureKey("thread-1"))
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual({ role: "user", content: "Hello" })
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" })
  })

  it("thread isolation — messages in thread A do not appear in thread B", async () => {
    const { getHistory, appendMessage } = await import("../../runtime/conversation-store")
    appendMessage(featureKey("thread-A"), { role: "user", content: "Message A" })
    appendMessage(featureKey("thread-B"), { role: "user", content: "Message B" })
    expect(getHistory(featureKey("thread-A"))).toHaveLength(1)
    expect(getHistory(featureKey("thread-B"))).toHaveLength(1)
    expect(getHistory(featureKey("thread-A"))[0].content).toBe("Message A")
    expect(getHistory(featureKey("thread-B"))[0].content).toBe("Message B")
  })

  it("getConfirmedAgent returns null initially", async () => {
    const { getConfirmedAgent } = await import("../../runtime/conversation-store")
    expect(getConfirmedAgent(featureKey("thread-1"))).toBeNull()
  })

  it("setConfirmedAgent stores agent and getConfirmedAgent retrieves it", async () => {
    const { getConfirmedAgent, setConfirmedAgent } = await import("../../runtime/conversation-store")
    setConfirmedAgent(featureKey("thread-1"), "pm")
    expect(getConfirmedAgent(featureKey("thread-1"))).toBe("pm")
  })

  it("setConfirmedAgent calls fs.writeFileSync to persist", async () => {
    const { setConfirmedAgent } = await import("../../runtime/conversation-store")
    setConfirmedAgent(featureKey("thread-1"), "pm")
    expect(fsMocks.writeFileSync).toHaveBeenCalled()
  })

  it("clearHistory removes thread history", async () => {
    const { getHistory, appendMessage, clearHistory } = await import("../../runtime/conversation-store")
    appendMessage(featureKey("thread-1"), { role: "user", content: "Hello" })
    clearHistory(featureKey("thread-1"))
    expect(getHistory(featureKey("thread-1"))).toEqual([])
  })

  it("clearHistory removes confirmed agent for thread", async () => {
    const { getConfirmedAgent, setConfirmedAgent, clearHistory } = await import("../../runtime/conversation-store")
    setConfirmedAgent(featureKey("thread-1"), "pm")
    clearHistory(featureKey("thread-1"))
    expect(getConfirmedAgent(featureKey("thread-1"))).toBeNull()
  })

  it("clearHistory calls fs.writeFileSync to persist cleared state", async () => {
    const { clearHistory } = await import("../../runtime/conversation-store")
    clearHistory(featureKey("thread-1"))
    expect(fsMocks.writeFileSync).toHaveBeenCalled()
  })

  it("startup does not throw when .confirmed-agents.json does not exist", async () => {
    // fs.readFileSync is mocked to throw — importing the module must not throw
    await expect(import("../../runtime/conversation-store")).resolves.toBeDefined()
  })

  // ─── pending escalation ───────────────────────────────────────────────────

  it("getPendingEscalation returns null when no escalation is set", async () => {
    const { getPendingEscalation } = await import("../../runtime/conversation-store")
    expect(getPendingEscalation(featureKey("thread-1"))).toBeNull()
  })

  it("setPendingEscalation stores escalation and getPendingEscalation retrieves it", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const escalation = { targetAgent: "pm" as const, question: "Should social login be supported?", designContext: "## Screens\n..." }
    setPendingEscalation(featureKey("thread-1"), escalation)
    const stored = getPendingEscalation(featureKey("thread-1"))
    expect(stored).toMatchObject(escalation)
    expect(stored?.timestamp).toBeTypeOf("number")
  })

  it("setPendingEscalation stores productSpec when provided and retrieves it", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const escalation = { targetAgent: "pm" as const, question: "Q?", designContext: "", productSpec: "## Acceptance Criteria\n1. SSO sign-in." }
    setPendingEscalation(featureKey("thread-1"), escalation)
    expect(getPendingEscalation(featureKey("thread-1"))?.productSpec).toBe("## Acceptance Criteria\n1. SSO sign-in.")
  })

  it("setPendingEscalation productSpec is optional — omitting it does not break retrieval", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: "Q?", designContext: "" })
    expect(getPendingEscalation(featureKey("thread-1"))?.productSpec).toBeUndefined()
  })

  it("clearPendingEscalation removes the escalation", async () => {
    const { getPendingEscalation, setPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: "Q", designContext: "" })
    clearPendingEscalation(featureKey("thread-1"))
    expect(getPendingEscalation(featureKey("thread-1"))).toBeNull()
  })

  it("escalation is thread-isolated — clearing thread-1 does not affect thread-2", async () => {
    const { getPendingEscalation, setPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: "Q1", designContext: "" })
    setPendingEscalation(featureKey("thread-2"), { targetAgent: "pm", question: "Q2", designContext: "" })
    clearPendingEscalation(featureKey("thread-1"))
    expect(getPendingEscalation(featureKey("thread-1"))).toBeNull()
    expect(getPendingEscalation(featureKey("thread-2"))?.question).toBe("Q2")
  })

  // ─── question normalization ───────────────────────────────────────────────

  it("normalizes inline numbered items to newline-separated", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const inline = "1. What is the session expiry? 2. Should SSO be supported? 3. Which tiers get access?"
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: inline, designContext: "" })
    const stored = getPendingEscalation(featureKey("thread-1"))!.question
    expect(stored).toBe("1. What is the session expiry?\n2. Should SSO be supported?\n3. Which tiers get access?")
  })

  it("does not double-add newlines when items already newline-separated", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const alreadySplit = "1. Gap one.\n2. Gap two.\n3. Gap three."
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: alreadySplit, designContext: "" })
    expect(getPendingEscalation(featureKey("thread-1"))!.question).toBe("1. Gap one.\n2. Gap two.\n3. Gap three.")
  })

  it("leaves plain-text question unchanged when no numbered items present", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const plain = "Should social login be supported?"
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: plain, designContext: "" })
    expect(getPendingEscalation(featureKey("thread-1"))!.question).toBe(plain)
  })

  // ─── state persistence (restart survival) ────────────────────────────────

  it("setPendingEscalation calls fs.writeFileSync to persist state to disk", async () => {
    const { setPendingEscalation } = await import("../../runtime/conversation-store")
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: "Q", designContext: "" })
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("clearPendingEscalation calls fs.writeFileSync to persist cleared state to disk", async () => {
    const { setPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation(featureKey("thread-1"), { targetAgent: "pm", question: "Q", designContext: "" })
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    clearPendingEscalation(featureKey("thread-1"))
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("pendingEscalation is RESTORED on startup — survives restarts for user confirmation", async () => {
    // Simulate: a previously-set escalation was persisted to .conversation-state.json
    // and the process restarted (module re-imported). On restart, pending escalations
    // are restored so the user can still confirm them after a restart.
    const savedState = {
      pendingEscalations: {
        "onboarding": { targetAgent: "pm", question: "What is the session expiry?", designContext: "", timestamp: Date.now() }
      },
      pendingApprovals: {},
      escalationNotifications: {},
    }
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") }) // confirmed-agents
      .mockImplementationOnce(() => { throw new Error("ENOENT") }) // history
      .mockReturnValueOnce(JSON.stringify(savedState))              // state

    const { getPendingEscalation } = await import("../../runtime/conversation-store")
    const loaded = getPendingEscalation(featureKey("onboarding"))
    expect(loaded).not.toBeNull()  // restored on startup — survives restarts
    expect(loaded?.question).toBe("What is the session expiry?")
  })

  // ─── pending approval ─────────────────────────────────────────────────────

  it("getPendingApproval returns null when no approval is set", async () => {
    const { getPendingApproval } = await import("../../runtime/conversation-store")
    expect(getPendingApproval(featureKey("thread-1"))).toBeNull()
  })

  it("setPendingApproval stores approval and getPendingApproval retrieves it", async () => {
    const { getPendingApproval, setPendingApproval } = await import("../../runtime/conversation-store")
    const approval = { specType: "product" as const, specContent: "# Spec", filePath: "path.md", featureName: "onboarding" }
    setPendingApproval(featureKey("thread-1"), approval)
    const stored = getPendingApproval(featureKey("thread-1"))
    expect(stored).toMatchObject(approval)
    expect(stored?.timestamp).toBeTypeOf("number")
  })

  it("setPendingApproval calls fs.writeFileSync to persist state to disk", async () => {
    const { setPendingApproval } = await import("../../runtime/conversation-store")
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    setPendingApproval(featureKey("thread-1"), { specType: "design", specContent: "# Design", filePath: "d.md", featureName: "f" })
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("clearPendingApproval removes the approval", async () => {
    const { getPendingApproval, setPendingApproval, clearPendingApproval } = await import("../../runtime/conversation-store")
    setPendingApproval(featureKey("thread-1"), { specType: "product", specContent: "# S", filePath: "p.md", featureName: "f" })
    clearPendingApproval(featureKey("thread-1"))
    expect(getPendingApproval(featureKey("thread-1"))).toBeNull()
  })

  it("clearPendingApproval calls fs.writeFileSync to persist cleared state to disk", async () => {
    const { setPendingApproval, clearPendingApproval } = await import("../../runtime/conversation-store")
    setPendingApproval(featureKey("thread-1"), { specType: "product", specContent: "# S", filePath: "p.md", featureName: "f" })
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    clearPendingApproval(featureKey("thread-1"))
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  // ─── pending decision review ─────────────────────────────────────────────

  it("getPendingDecisionReview returns null when no review is set", async () => {
    const { getPendingDecisionReview } = await import("../../runtime/conversation-store")
    expect(getPendingDecisionReview(featureKey("thread-1"))).toBeNull()
  })

  it("setPendingDecisionReview stores review and getPendingDecisionReview retrieves it", async () => {
    const { getPendingDecisionReview, setPendingDecisionReview } = await import("../../runtime/conversation-store")
    const review = { specContent: "# Spec", filePath: "path.md", featureName: "onboarding", resolvedQuestions: ["What DB?"] }
    setPendingDecisionReview(featureKey("thread-1"), review)
    const stored = getPendingDecisionReview(featureKey("thread-1"))
    expect(stored).toMatchObject(review)
    expect(stored?.timestamp).toBeTypeOf("number")
  })

  it("clearPendingDecisionReview removes the review", async () => {
    const { getPendingDecisionReview, setPendingDecisionReview, clearPendingDecisionReview } = await import("../../runtime/conversation-store")
    setPendingDecisionReview(featureKey("thread-1"), { specContent: "# S", filePath: "p.md", featureName: "f", resolvedQuestions: ["Q1"] })
    clearPendingDecisionReview(featureKey("thread-1"))
    expect(getPendingDecisionReview(featureKey("thread-1"))).toBeNull()
  })

  // ─── escalation notification ──────────────────────────────────────────────

  it("getEscalationNotification returns null when none is set", async () => {
    const { getEscalationNotification } = await import("../../runtime/conversation-store")
    expect(getEscalationNotification(featureKey("onboarding"))).toBeNull()
  })

  it("setEscalationNotification stores notification and getEscalationNotification retrieves it", async () => {
    const { getEscalationNotification, setEscalationNotification } = await import("../../runtime/conversation-store")
    const notification = { targetAgent: "pm" as const, question: "What is the session expiry?", recommendations: "1 week" }
    setEscalationNotification(featureKey("onboarding"), notification)
    expect(getEscalationNotification(featureKey("onboarding"))).toEqual(notification)
  })

  it("setEscalationNotification calls fs.writeFileSync to persist state to disk", async () => {
    const { setEscalationNotification } = await import("../../runtime/conversation-store")
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    setEscalationNotification(featureKey("onboarding"), { targetAgent: "pm", question: "Q" })
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("clearEscalationNotification removes the notification", async () => {
    const { getEscalationNotification, setEscalationNotification, clearEscalationNotification } = await import("../../runtime/conversation-store")
    setEscalationNotification(featureKey("onboarding"), { targetAgent: "pm", question: "Q" })
    clearEscalationNotification(featureKey("onboarding"))
    expect(getEscalationNotification(featureKey("onboarding"))).toBeNull()
  })

  it("clearEscalationNotification calls fs.writeFileSync to persist cleared state to disk", async () => {
    const { setEscalationNotification, clearEscalationNotification } = await import("../../runtime/conversation-store")
    setEscalationNotification(featureKey("onboarding"), { targetAgent: "pm", question: "Q" })
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    clearEscalationNotification(featureKey("onboarding"))
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("disableFilePersistence clears all in-memory state loaded from disk on module import", async () => {
    // Simulate production state on disk with all three map types populated.
    // Timestamps must be recent (within 24h) to survive TTL cleanup on startup.
    // escalationNotifications are cleared on startup unconditionally — they don't survive restart.
    const savedState = {
      pendingEscalations: { "onboarding": { targetAgent: "pm", question: "Q", designContext: "", timestamp: Date.now() } },
      pendingApprovals: { "onboarding": { specType: "product", specContent: "...", filePath: "x", featureName: "onboarding", timestamp: Date.now() } },
      escalationNotifications: { "onboarding": { targetAgent: "pm", question: "Q" } },
    }
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") })       // confirmed-agents
      .mockImplementationOnce(() => { throw new Error("ENOENT") })       // history
      .mockReturnValueOnce(JSON.stringify(savedState))                    // state

    const { disableFilePersistence, getPendingEscalation, getPendingApproval, getEscalationNotification, getHistory } = await import("../../runtime/conversation-store")

    // Before disableFilePersistence: timestamped state survives startup.
    // escalationNotifications are cleared on startup (no timestamp support).
    expect(getPendingEscalation(featureKey("onboarding"))).not.toBeNull()  // restored (within 24h TTL)
    expect(getPendingApproval(featureKey("onboarding"))?.specType).toBe("product")  // restored (within 24h TTL)
    expect(getEscalationNotification(featureKey("onboarding"))).toBeNull()  // cleared on startup (always)

    // After disableFilePersistence: all state is wiped — tests start clean
    disableFilePersistence()
    expect(getPendingEscalation(featureKey("onboarding"))).toBeNull()
    expect(getPendingApproval(featureKey("onboarding"))).toBeNull()
    expect(getEscalationNotification(featureKey("onboarding"))).toBeNull()
    expect(getHistory(featureKey("onboarding"))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Legacy threadTs migration
// ─────────────────────────────────────────────────────────────────────────────

describe("legacy threadTs migration", () => {
  beforeEach(() => {
    vi.resetModules()
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file")
    })
    fsMocks.writeFileSync.mockReset()
  })

  it("migrates threadTs-keyed entries to _legacy_ on startup", async () => {
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") }) // confirmed-agents
      .mockReturnValueOnce(JSON.stringify({
        "1774391965.646909": [
          { role: "user", content: "old message 1" },
          { role: "assistant", content: "old reply 1" },
        ],
      }))

    const { getLegacyMessages } = await import("../../runtime/conversation-store")
    const legacy = getLegacyMessages()
    expect(legacy).toHaveLength(2)
    expect(legacy[0].content).toBe("old message 1")
    expect(legacy[1].content).toBe("old reply 1")
  })

  it("getLegacyMessages returns empty when no threadTs-keyed entries", async () => {
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") })
      .mockReturnValueOnce(JSON.stringify({
        "onboarding": [{ role: "user", content: "only new msg" }],
      }))

    const { getLegacyMessages } = await import("../../runtime/conversation-store")
    expect(getLegacyMessages()).toHaveLength(0)
  })

  it("getHistory returns only featureName messages (no legacy leak)", async () => {
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") })
      .mockReturnValueOnce(JSON.stringify({
        "1774391965.646909": [{ role: "user", content: "legacy msg" }],
        "onboarding": [{ role: "assistant", content: "new msg" }],
      }))

    const { getHistory } = await import("../../runtime/conversation-store")
    const history = getHistory(featureKey("onboarding"))
    // getHistory is pure — no legacy merge; legacy is surfaced only via getLegacyMessages()
    expect(history).toHaveLength(1)
    expect(history[0].content).toBe("new msg")
  })

  it("migration calls persistConversationHistory (writes to disk)", async () => {
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") })
      .mockReturnValueOnce(JSON.stringify({
        "1774391965.646909": [{ role: "user", content: "legacy msg" }],
      }))

    await import("../../runtime/conversation-store")
    expect(fsMocks.writeFileSync).toHaveBeenCalled()
  })

  it("migration is a no-op when no threadTs-pattern keys exist", async () => {
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") })
      .mockReturnValueOnce(JSON.stringify({
        "onboarding": [{ role: "user", content: "already featureName-keyed" }],
      }))

    await import("../../runtime/conversation-store")
    // No threadTs keys → migrateThreadTsKeys does nothing → no writeFileSync
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled()
  })
})
