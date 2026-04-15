import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { classifyFixIntent } from "../../runtime/fix-intent-classifier"

beforeEach(() => {
  mockCreate.mockReset()
})

// ─── Consumer tests — gate logic ──────────────────────────────────────────────

describe("classifyFixIntent — consumer tests (gate logic with mocked Haiku)", () => {
  it("FIX-ALL → isFixAll=true, selectedIndices=null", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "FIX-ALL" }] })

    const result = await classifyFixIntent("go ahead and fix all of these")

    expect(result.isFixAll).toBe(true)
    expect(result.selectedIndices).toBeNull()
  })

  it("FIX-ITEMS: 1,3,5 → isFixAll=true, selectedIndices=[1,3,5]", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "FIX-ITEMS: 1,3,5" }] })

    const result = await classifyFixIntent("please fix items 1, 3, and 5")

    expect(result.isFixAll).toBe(true)
    expect(result.selectedIndices).toEqual([1, 3, 5])
  })

  it("NOT-FIX → isFixAll=false", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NOT-FIX" }] })

    const result = await classifyFixIntent("yes those look right")

    expect(result.isFixAll).toBe(false)
  })

  it("unexpected output defaults to NOT-FIX (safe — never accidentally enters fix loop)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "I cannot determine this." }] })

    const result = await classifyFixIntent("some message")

    expect(result.isFixAll).toBe(false)
  })

  it("FIX-ITEMS with single item → selectedIndices=[2]", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "FIX-ITEMS: 2" }] })

    const result = await classifyFixIntent("fix the second one")

    expect(result.isFixAll).toBe(true)
    expect(result.selectedIndices).toEqual([2])
  })

  it("FIX-ITEMS with no valid numbers → NOT-FIX (invalid indices not accepted)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "FIX-ITEMS: abc" }] })

    const result = await classifyFixIntent("fix the ones that are wrong")

    expect(result.isFixAll).toBe(false)
  })
})

// ─── Producer tests — prompt is conservative ──────────────────────────────────

describe("classifyFixIntent — producer tests (prompt structure)", () => {
  it("system prompt contains all three output tokens: FIX-ALL, FIX-ITEMS, NOT-FIX", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NOT-FIX" }] })

    await classifyFixIntent("yes")

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("FIX-ALL")
    expect(call.system).toContain("FIX-ITEMS")
    expect(call.system).toContain("NOT-FIX")
  })

  it("system prompt explicitly lists agreement-only phrases as NOT fix requests", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NOT-FIX" }] })

    await classifyFixIntent("yes")

    const call = mockCreate.mock.calls[0][0]
    // Conservative rule must be explicit — agreement without fix verb is NOT-FIX
    expect(call.system).toContain("NOT fix requests")
    expect(call.system.toLowerCase()).toContain("yes")
    expect(call.system.toLowerCase()).toContain("sounds good")
  })

  it("passes message as user content", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "FIX-ALL" }] })

    await classifyFixIntent("fix all of them please")

    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toBe("fix all of them please")
  })

  it("uses low token budget for single-keyword response (max_tokens <= 32)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "FIX-ALL" }] })

    await classifyFixIntent("fix all")

    const call = mockCreate.mock.calls[0][0]
    expect(call.max_tokens).toBeLessThanOrEqual(32)
  })
})
