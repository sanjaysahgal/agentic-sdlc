import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { summarizeUnlockedDiscussion, buildEnrichedMessage } from "../../runtime/conversation-summarizer"

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
    expect(result).toContain("[Prior conversation context — in progress, not yet locked:")
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
