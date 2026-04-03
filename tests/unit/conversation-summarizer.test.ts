import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { summarizeUnlockedDiscussion, buildEnrichedMessage, getPriorContext, clearSummaryCache, identifyUncommittedDecisions, generateSaveCheckpoint } from "../../runtime/conversation-summarizer"

function haiku(text: string) {
  return { content: [{ type: "text", text }] }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("summarizeUnlockedDiscussion", () => {
  it("returns empty string when no messages", async () => {
    const result = await summarizeUnlockedDiscussion([])
    expect(result).toBe("")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("calls Haiku with older messages formatted as User/Agent pairs", async () => {
    mockCreate.mockResolvedValue(haiku("- Dark mode direction being explored\n- Animation timing not finalized"))

    await summarizeUnlockedDiscussion([
      { role: "user", content: "What about dark mode?" },
      { role: "assistant", content: "We could use Archon palette" },
    ])

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const call = mockCreate.mock.calls[0][0]
    expect(call.model).toBe("claude-haiku-4-5-20251001")
    expect(call.messages[0].content).toContain("User: What about dark mode?")
    expect(call.messages[0].content).toContain("Agent: We could use Archon palette")
  })

  it("instructs Haiku to focus on unlocked content only", async () => {
    mockCreate.mockResolvedValue(haiku("- Chip positioning under discussion"))

    await summarizeUnlockedDiscussion([{ role: "user", content: "Where should chips go?" }])

    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain("NOT been formally locked or approved")
    expect(prompt).toContain("UNLOCKED content only")
  })

  it("returns the Haiku summary text", async () => {
    mockCreate.mockResolvedValue(haiku("  - Glow timing under discussion\n- Contrast math pending  "))

    const result = await summarizeUnlockedDiscussion([{ role: "user", content: "hi" }])
    expect(result).toBe("- Glow timing under discussion\n- Contrast math pending")
  })

  it("truncates long messages to 800 chars before sending to Haiku", async () => {
    mockCreate.mockResolvedValue(haiku("summary"))
    const longContent = "A".repeat(2000)

    await summarizeUnlockedDiscussion([{ role: "user", content: longContent }])

    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain("A".repeat(800))
    expect(prompt).not.toContain("A".repeat(801))
  })
})

describe("summarizeUnlockedDiscussion — caching", () => {
  it("returns cached summary on second call with same cacheKey — Haiku called only once", async () => {
    mockCreate.mockResolvedValue(haiku("- Glow timing pending"))

    const msgs = [{ role: "user" as const, content: "What about glow?" }]
    const first = await summarizeUnlockedDiscussion(msgs, "thread1:1")
    const second = await summarizeUnlockedDiscussion(msgs, "thread1:1")

    expect(first).toBe("- Glow timing pending")
    expect(second).toBe("- Glow timing pending")
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("calls Haiku again when cacheKey changes (more messages overflowed)", async () => {
    mockCreate.mockResolvedValue(haiku("- New summary"))

    const msgs = [{ role: "user" as const, content: "hi" }]
    await summarizeUnlockedDiscussion(msgs, "thread2:1")
    await summarizeUnlockedDiscussion(msgs, "thread2:2")

    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("skips cache when no cacheKey provided", async () => {
    mockCreate.mockResolvedValue(haiku("- summary"))

    const msgs = [{ role: "user" as const, content: "hi" }]
    await summarizeUnlockedDiscussion(msgs)
    await summarizeUnlockedDiscussion(msgs)

    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})

describe("getPriorContext", () => {
  it("returns empty string when history is within limit", async () => {
    const history = Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, content: `msg ${i}` }))
    const result = await getPriorContext("t1", history, 20)
    expect(result).toBe("")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("calls summarizeUnlockedDiscussion with overflow messages when history exceeds limit", async () => {
    mockCreate.mockResolvedValue(haiku("- Chip position pending"))
    const history = Array.from({ length: 25 }, (_, i) => ({ role: "user" as const, content: `msg ${i}` }))
    const result = await getPriorContext("t2", history, 20)
    expect(result).toBe("- Chip position pending")
    // overflow = history.slice(0, -20) = 5 messages
    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain("msg 0")
    expect(prompt).not.toContain("msg 20")
  })

  it("uses threadTs and olderMessageCount as cache key", async () => {
    mockCreate.mockResolvedValue(haiku("- cached"))
    const history = Array.from({ length: 25 }, (_, i) => ({ role: "user" as const, content: `msg ${i}` }))
    await getPriorContext("t3", history, 20)
    await getPriorContext("t3", history, 20)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe("identifyUncommittedDecisions", () => {
  it("returns empty string when history is empty", async () => {
    const result = await identifyUncommittedDecisions([], "some spec")
    expect(result).toBe("")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("sends both spec and conversation to Haiku", async () => {
    mockCreate.mockResolvedValue(haiku("1. Dark mode default: Archon palette agreed by user"))

    await identifyUncommittedDecisions(
      [{ role: "user", content: "Let's do dark mode" }],
      "## Design Direction\nLight mode default.",
    )

    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain("COMMITTED SPEC")
    expect(prompt).toContain("Light mode default")
    expect(prompt).toContain("CONVERSATION")
    expect(prompt).toContain("dark mode")
  })

  it("instructs Haiku to count only agreed decisions — not proposals or unanswered questions", async () => {
    mockCreate.mockResolvedValue(haiku("none"))
    await identifyUncommittedDecisions([{ role: "user", content: "hi" }], "spec")
    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain("actively agreed")
    expect(prompt).toContain("Do NOT count")
    expect(prompt).toContain("Options the agent proposed but the user has not chosen yet")
    expect(prompt).toContain("numbered list")
  })

  it("prompt instructs Haiku to exclude regression complaints and past-state references", async () => {
    mockCreate.mockResolvedValue(haiku("none"))
    await identifyUncommittedDecisions([{ role: "user", content: "hi" }], "spec")
    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    // Must filter out "we had fixed", "it used to", etc. — these are bug reports, not agreements
    expect(prompt).toContain("we had fixed")
    expect(prompt).toContain("complaints about what broke, not new agreements")
  })

  it("sends the FULL spec to Haiku — no truncation — so Brand section is visible", async () => {
    // Root cause of false positive: spec was sliced to 3000 chars.
    // The Brand section of a full design spec is well past position 3000.
    // Haiku couldn't see committed brand tokens and flagged them as uncommitted.
    const longSpec = "A".repeat(4000) + "\n## Brand\n--violet: #7C6FCD\n--bg: #0A0A0F\n"
    mockCreate.mockResolvedValue(haiku("none"))
    await identifyUncommittedDecisions([{ role: "user", content: "fix brand tokens" }], longSpec)
    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    // Full Brand section must be present in the prompt — not truncated
    expect(prompt).toContain("--violet: #7C6FCD")
    expect(prompt).toContain("--bg: #0A0A0F")
  })

  it("caches result under uncommitted: prefix", async () => {
    mockCreate.mockResolvedValue(haiku("1. Dark mode: I recommend Archon palette — discussed in thread"))
    const msgs = [{ role: "user" as const, content: "dark mode please" }]
    await identifyUncommittedDecisions(msgs, "spec", "thread1:10")
    await identifyUncommittedDecisions(msgs, "spec", "thread1:10")
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe("clearSummaryCache", () => {
  it("removes cached entries for the given threadTs", async () => {
    mockCreate.mockResolvedValue(haiku("summary"))
    const msgs = [{ role: "user" as const, content: "hi" }]
    await summarizeUnlockedDiscussion(msgs, "thread-clear:5")
    clearSummaryCache("thread-clear")
    await summarizeUnlockedDiscussion(msgs, "thread-clear:5")
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("also removes uncommitted: prefixed entries for the given threadTs", async () => {
    mockCreate.mockResolvedValue(haiku("1. Dark mode: I recommend Archon palette — discussed in thread"))
    const msgs = [{ role: "user" as const, content: "dark mode" }]
    await identifyUncommittedDecisions(msgs, "spec", "thread-clear2:5")
    clearSummaryCache("thread-clear2")
    await identifyUncommittedDecisions(msgs, "spec", "thread-clear2:5")
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})

describe("buildEnrichedMessage", () => {
  it("returns only userMessage when no prior context or locked decisions", () => {
    const result = buildEnrichedMessage({ userMessage: "Lock all 3", lockedDecisions: "", priorContext: "" })
    expect(result).toBe("Lock all 3")
  })

  it("prepends prior context block when present", () => {
    const result = buildEnrichedMessage({
      userMessage: "Lock all 3",
      lockedDecisions: "",
      priorContext: "- Glow timing under discussion",
    })
    expect(result).toContain("Background from earlier in this thread")
    expect(result).toContain("NEVER COMMITTED")
    expect(result).toContain("Confirm with the user before acting")
    expect(result).toContain("- Glow timing under discussion")
    expect(result).toContain("Lock all 3")
  })

  it("includes locked decisions block when present", () => {
    const result = buildEnrichedMessage({
      userMessage: "approved",
      lockedDecisions: "Dark mode: Archon palette",
      priorContext: "",
    })
    expect(result).toContain("[Decisions locked in this conversation:")
    expect(result).toContain("Dark mode: Archon palette")
    expect(result).toContain("approved")
  })

  it("prior context appears before locked decisions appears before user message", () => {
    const result = buildEnrichedMessage({
      userMessage: "Lock all 3",
      lockedDecisions: "Dark mode locked",
      priorContext: "Glow timing pending",
    })
    const priorIdx = result.indexOf("Glow timing pending")
    const lockedIdx = result.indexOf("Dark mode locked")
    const msgIdx = result.indexOf("Lock all 3")
    expect(priorIdx).toBeLessThan(lockedIdx)
    expect(lockedIdx).toBeLessThan(msgIdx)
  })
})

describe("generateSaveCheckpoint", () => {
  it("returns committed bullets and empty notCommitted when everything is saved", async () => {
    mockCreate.mockResolvedValue(haiku("COMMITTED:\n• Dark-mode-default (#0A0A0F)\n• Glow 10→15→10%, 2.5s\nNOT_COMMITTED:\nnothing — all discussed decisions are in the spec above"))

    const result = await generateSaveCheckpoint(
      "## Design Direction\nDark mode default, #0A0A0F background",
      [{ role: "user", content: "let's use dark mode" }, { role: "assistant", content: "Done" }]
    )

    expect(result.committed).toContain("Dark-mode-default")
    expect(result.notCommitted).toBe("") // "nothing" phrase → empty
  })

  it("returns notCommitted items when decisions are in thread but not spec", async () => {
    mockCreate.mockResolvedValue(haiku("COMMITTED:\n• Light mode default\nNOT_COMMITTED:\n1. Glow animation timing (2.5s) — discussed, not in spec\n2. Chip positioning above prompt bar"))

    const result = await generateSaveCheckpoint("## Design Direction\nLight mode default", [])

    expect(result.committed).toContain("Light mode default")
    expect(result.notCommitted).toContain("Glow animation timing")
    expect(result.notCommitted).toContain("Chip positioning")
  })

  it("uses Haiku model", async () => {
    mockCreate.mockResolvedValue(haiku("COMMITTED:\n• something\nNOT_COMMITTED:\nnothing"))
    await generateSaveCheckpoint("spec content", [])
    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001")
  })

  it("prompt includes both saved spec and conversation", async () => {
    mockCreate.mockResolvedValue(haiku("COMMITTED:\n• x\nNOT_COMMITTED:\nnothing"))
    await generateSaveCheckpoint("the spec text", [
      { role: "user", content: "user message" },
      { role: "assistant", content: "agent message" },
    ])
    const prompt = mockCreate.mock.calls[0][0].messages[0].content
    expect(prompt).toContain("the spec text")
    expect(prompt).toContain("user message")
    expect(prompt).toContain("COMMITTED:")
    expect(prompt).toContain("NOT_COMMITTED:")
  })

  it("handles Haiku returning only COMMITTED with no NOT_COMMITTED section gracefully", async () => {
    mockCreate.mockResolvedValue(haiku("COMMITTED:\n• Dark mode\n"))
    const result = await generateSaveCheckpoint("spec", [])
    expect(result.committed).toContain("Dark mode")
    expect(result.notCommitted).toBe("")
  })
})
