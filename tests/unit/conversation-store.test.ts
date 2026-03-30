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
