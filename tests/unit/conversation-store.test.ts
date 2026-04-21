import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

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
    expect(getHistory("thread-unknown")).toEqual([])
  })

  it("appendMessage adds message to thread history", async () => {
    const { getHistory, appendMessage } = await import("../../runtime/conversation-store")
    appendMessage("thread-1", { role: "user", content: "Hello" })
    expect(getHistory("thread-1")).toEqual([{ role: "user", content: "Hello" }])
  })

  it("appendMessage is additive — second call appends, does not replace", async () => {
    const { getHistory, appendMessage } = await import("../../runtime/conversation-store")
    appendMessage("thread-1", { role: "user", content: "Hello" })
    appendMessage("thread-1", { role: "assistant", content: "Hi there" })
    const history = getHistory("thread-1")
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual({ role: "user", content: "Hello" })
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there" })
  })

  it("thread isolation — messages in thread A do not appear in thread B", async () => {
    const { getHistory, appendMessage } = await import("../../runtime/conversation-store")
    appendMessage("thread-A", { role: "user", content: "Message A" })
    appendMessage("thread-B", { role: "user", content: "Message B" })
    expect(getHistory("thread-A")).toHaveLength(1)
    expect(getHistory("thread-B")).toHaveLength(1)
    expect(getHistory("thread-A")[0].content).toBe("Message A")
    expect(getHistory("thread-B")[0].content).toBe("Message B")
  })

  it("getConfirmedAgent returns null initially", async () => {
    const { getConfirmedAgent } = await import("../../runtime/conversation-store")
    expect(getConfirmedAgent("thread-1")).toBeNull()
  })

  it("setConfirmedAgent stores agent and getConfirmedAgent retrieves it", async () => {
    const { getConfirmedAgent, setConfirmedAgent } = await import("../../runtime/conversation-store")
    setConfirmedAgent("thread-1", "pm")
    expect(getConfirmedAgent("thread-1")).toBe("pm")
  })

  it("setConfirmedAgent calls fs.writeFileSync to persist", async () => {
    const { setConfirmedAgent } = await import("../../runtime/conversation-store")
    setConfirmedAgent("thread-1", "pm")
    expect(fsMocks.writeFileSync).toHaveBeenCalled()
  })

  it("clearHistory removes thread history", async () => {
    const { getHistory, appendMessage, clearHistory } = await import("../../runtime/conversation-store")
    appendMessage("thread-1", { role: "user", content: "Hello" })
    clearHistory("thread-1")
    expect(getHistory("thread-1")).toEqual([])
  })

  it("clearHistory removes confirmed agent for thread", async () => {
    const { getConfirmedAgent, setConfirmedAgent, clearHistory } = await import("../../runtime/conversation-store")
    setConfirmedAgent("thread-1", "pm")
    clearHistory("thread-1")
    expect(getConfirmedAgent("thread-1")).toBeNull()
  })

  it("clearHistory calls fs.writeFileSync to persist cleared state", async () => {
    const { clearHistory } = await import("../../runtime/conversation-store")
    clearHistory("thread-1")
    expect(fsMocks.writeFileSync).toHaveBeenCalled()
  })

  it("startup does not throw when .confirmed-agents.json does not exist", async () => {
    // fs.readFileSync is mocked to throw — importing the module must not throw
    await expect(import("../../runtime/conversation-store")).resolves.toBeDefined()
  })

  // ─── pending escalation ───────────────────────────────────────────────────

  it("getPendingEscalation returns null when no escalation is set", async () => {
    const { getPendingEscalation } = await import("../../runtime/conversation-store")
    expect(getPendingEscalation("thread-1")).toBeNull()
  })

  it("setPendingEscalation stores escalation and getPendingEscalation retrieves it", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const escalation = { targetAgent: "pm" as const, question: "Should social login be supported?", designContext: "## Screens\n..." }
    setPendingEscalation("thread-1", escalation)
    expect(getPendingEscalation("thread-1")).toEqual(escalation)
  })

  it("setPendingEscalation stores productSpec when provided and retrieves it", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const escalation = { targetAgent: "pm" as const, question: "Q?", designContext: "", productSpec: "## Acceptance Criteria\n1. SSO sign-in." }
    setPendingEscalation("thread-1", escalation)
    expect(getPendingEscalation("thread-1")?.productSpec).toBe("## Acceptance Criteria\n1. SSO sign-in.")
  })

  it("setPendingEscalation productSpec is optional — omitting it does not break retrieval", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation("thread-1", { targetAgent: "pm", question: "Q?", designContext: "" })
    expect(getPendingEscalation("thread-1")?.productSpec).toBeUndefined()
  })

  it("clearPendingEscalation removes the escalation", async () => {
    const { getPendingEscalation, setPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation("thread-1", { targetAgent: "pm", question: "Q", designContext: "" })
    clearPendingEscalation("thread-1")
    expect(getPendingEscalation("thread-1")).toBeNull()
  })

  it("escalation is thread-isolated — clearing thread-1 does not affect thread-2", async () => {
    const { getPendingEscalation, setPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation("thread-1", { targetAgent: "pm", question: "Q1", designContext: "" })
    setPendingEscalation("thread-2", { targetAgent: "pm", question: "Q2", designContext: "" })
    clearPendingEscalation("thread-1")
    expect(getPendingEscalation("thread-1")).toBeNull()
    expect(getPendingEscalation("thread-2")?.question).toBe("Q2")
  })

  // ─── question normalization ───────────────────────────────────────────────

  it("normalizes inline numbered items to newline-separated", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const inline = "1. What is the session expiry? 2. Should SSO be supported? 3. Which tiers get access?"
    setPendingEscalation("thread-1", { targetAgent: "pm", question: inline, designContext: "" })
    const stored = getPendingEscalation("thread-1")!.question
    expect(stored).toBe("1. What is the session expiry?\n2. Should SSO be supported?\n3. Which tiers get access?")
  })

  it("does not double-add newlines when items already newline-separated", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const alreadySplit = "1. Gap one.\n2. Gap two.\n3. Gap three."
    setPendingEscalation("thread-1", { targetAgent: "pm", question: alreadySplit, designContext: "" })
    expect(getPendingEscalation("thread-1")!.question).toBe("1. Gap one.\n2. Gap two.\n3. Gap three.")
  })

  it("leaves plain-text question unchanged when no numbered items present", async () => {
    const { getPendingEscalation, setPendingEscalation } = await import("../../runtime/conversation-store")
    const plain = "Should social login be supported?"
    setPendingEscalation("thread-1", { targetAgent: "pm", question: plain, designContext: "" })
    expect(getPendingEscalation("thread-1")!.question).toBe(plain)
  })

  // ─── state persistence (restart survival) ────────────────────────────────

  it("setPendingEscalation calls fs.writeFileSync to persist state to disk", async () => {
    const { setPendingEscalation } = await import("../../runtime/conversation-store")
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    setPendingEscalation("thread-1", { targetAgent: "pm", question: "Q", designContext: "" })
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("clearPendingEscalation calls fs.writeFileSync to persist cleared state to disk", async () => {
    const { setPendingEscalation, clearPendingEscalation } = await import("../../runtime/conversation-store")
    setPendingEscalation("thread-1", { targetAgent: "pm", question: "Q", designContext: "" })
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    clearPendingEscalation("thread-1")
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("pendingEscalation is cleared on startup — stale escalation state from prior session does not block routing", async () => {
    // Simulate: a previously-set escalation was persisted to .conversation-state.json
    // and the process restarted (module re-imported). On restart, pending escalations
    // are cleared because the user confirmation was lost when the bot crashed.
    const savedState = {
      pendingEscalations: {
        "onboarding": { targetAgent: "pm", question: "What is the session expiry?", designContext: "" }
      },
      pendingApprovals: {},
      escalationNotifications: {},
    }
    // readFileSync called in order: confirmed-agents (throw), history (throw), state (return saved)
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") }) // confirmed-agents
      .mockImplementationOnce(() => { throw new Error("ENOENT") }) // history
      .mockReturnValueOnce(JSON.stringify(savedState))              // state

    const { getPendingEscalation } = await import("../../runtime/conversation-store")
    const loaded = getPendingEscalation("onboarding")
    expect(loaded).toBeNull()  // cleared on startup — stale state
  })

  // ─── pending approval ─────────────────────────────────────────────────────

  it("getPendingApproval returns null when no approval is set", async () => {
    const { getPendingApproval } = await import("../../runtime/conversation-store")
    expect(getPendingApproval("thread-1")).toBeNull()
  })

  it("setPendingApproval stores approval and getPendingApproval retrieves it", async () => {
    const { getPendingApproval, setPendingApproval } = await import("../../runtime/conversation-store")
    const approval = { specType: "product" as const, specContent: "# Spec", filePath: "path.md", featureName: "onboarding" }
    setPendingApproval("thread-1", approval)
    expect(getPendingApproval("thread-1")).toEqual(approval)
  })

  it("setPendingApproval calls fs.writeFileSync to persist state to disk", async () => {
    const { setPendingApproval } = await import("../../runtime/conversation-store")
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    setPendingApproval("thread-1", { specType: "design", specContent: "# Design", filePath: "d.md", featureName: "f" })
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("clearPendingApproval removes the approval", async () => {
    const { getPendingApproval, setPendingApproval, clearPendingApproval } = await import("../../runtime/conversation-store")
    setPendingApproval("thread-1", { specType: "product", specContent: "# S", filePath: "p.md", featureName: "f" })
    clearPendingApproval("thread-1")
    expect(getPendingApproval("thread-1")).toBeNull()
  })

  it("clearPendingApproval calls fs.writeFileSync to persist cleared state to disk", async () => {
    const { setPendingApproval, clearPendingApproval } = await import("../../runtime/conversation-store")
    setPendingApproval("thread-1", { specType: "product", specContent: "# S", filePath: "p.md", featureName: "f" })
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    clearPendingApproval("thread-1")
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  // ─── escalation notification ──────────────────────────────────────────────

  it("getEscalationNotification returns null when none is set", async () => {
    const { getEscalationNotification } = await import("../../runtime/conversation-store")
    expect(getEscalationNotification("onboarding")).toBeNull()
  })

  it("setEscalationNotification stores notification and getEscalationNotification retrieves it", async () => {
    const { getEscalationNotification, setEscalationNotification } = await import("../../runtime/conversation-store")
    const notification = { targetAgent: "pm" as const, question: "What is the session expiry?", recommendations: "1 week" }
    setEscalationNotification("onboarding", notification)
    expect(getEscalationNotification("onboarding")).toEqual(notification)
  })

  it("setEscalationNotification calls fs.writeFileSync to persist state to disk", async () => {
    const { setEscalationNotification } = await import("../../runtime/conversation-store")
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    setEscalationNotification("onboarding", { targetAgent: "pm", question: "Q" })
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("clearEscalationNotification removes the notification", async () => {
    const { getEscalationNotification, setEscalationNotification, clearEscalationNotification } = await import("../../runtime/conversation-store")
    setEscalationNotification("onboarding", { targetAgent: "pm", question: "Q" })
    clearEscalationNotification("onboarding")
    expect(getEscalationNotification("onboarding")).toBeNull()
  })

  it("clearEscalationNotification calls fs.writeFileSync to persist cleared state to disk", async () => {
    const { setEscalationNotification, clearEscalationNotification } = await import("../../runtime/conversation-store")
    setEscalationNotification("onboarding", { targetAgent: "pm", question: "Q" })
    const callsBefore = fsMocks.writeFileSync.mock.calls.length
    clearEscalationNotification("onboarding")
    expect(fsMocks.writeFileSync.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it("disableFilePersistence clears all in-memory state loaded from disk on module import", async () => {
    // Simulate production state on disk with all three map types populated
    const savedState = {
      pendingEscalations: { "onboarding": { targetAgent: "pm", question: "Q", designContext: "" } },
      pendingApprovals: { "onboarding": { specType: "product", specContent: "...", filePath: "x", featureName: "onboarding" } },
      escalationNotifications: { "onboarding": { targetAgent: "pm", question: "Q" } },
    }
    fsMocks.readFileSync
      .mockImplementationOnce(() => { throw new Error("ENOENT") })       // confirmed-agents
      .mockImplementationOnce(() => { throw new Error("ENOENT") })       // history
      .mockReturnValueOnce(JSON.stringify(savedState))                    // state

    const { disableFilePersistence, getPendingEscalation, getPendingApproval, getEscalationNotification, getHistory } = await import("../../runtime/conversation-store")

    // Before disableFilePersistence: disk state is in memory.
    // Pending escalations are cleared on startup (stale state from prior session),
    // but approvals and notifications survive.
    expect(getPendingEscalation("onboarding")).toBeNull()  // cleared on startup
    expect(getPendingApproval("onboarding")?.specType).toBe("product")
    expect(getEscalationNotification("onboarding")?.question).toBe("Q")

    // After disableFilePersistence: all state is wiped — tests start clean
    disableFilePersistence()
    expect(getPendingEscalation("onboarding")).toBeNull()
    expect(getPendingApproval("onboarding")).toBeNull()
    expect(getEscalationNotification("onboarding")).toBeNull()
    expect(getHistory("onboarding")).toEqual([])
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
    const history = getHistory("onboarding")
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
