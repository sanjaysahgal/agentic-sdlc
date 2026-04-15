import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { classifyForArchGap } from "../../runtime/arch-gap-classifier"

beforeEach(() => {
  mockCreate.mockReset()
})

// ─── Consumer tests — gate logic ──────────────────────────────────────────────

describe("classifyForArchGap — consumer tests (gate logic with mocked Haiku)", () => {
  it("returns DESIGN-ASSUMPTION when Haiku responds DESIGN-ASSUMPTION", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "DESIGN-ASSUMPTION" }] })

    const result = await classifyForArchGap("How are logged-out conversations stored — client-side or server-side?")

    expect(result).toBe("DESIGN-ASSUMPTION")
  })

  it("returns ARCH-GAP when Haiku responds ARCH-GAP", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ARCH-GAP" }] })

    const result = await classifyForArchGap("Does the API support streaming? I need to choose between a typing indicator and loading spinner.")

    expect(result).toBe("ARCH-GAP")
  })

  it("defaults to ARCH-GAP when Haiku returns unexpected content (safe fallback — do not block valid escalations)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "I cannot determine this." }] })

    const result = await classifyForArchGap("Some question")

    expect(result).toBe("ARCH-GAP")
  })

  it("handles DESIGN-ASSUMPTION with trailing whitespace or punctuation", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "DESIGN-ASSUMPTION." }] })

    const result = await classifyForArchGap("What encryption algorithm is used?")

    expect(result).toBe("DESIGN-ASSUMPTION")
  })
})

// ─── Producer tests — prompt contains required keywords ───────────────────────

describe("classifyForArchGap — producer tests (prompt generates correct format)", () => {
  it("calls Haiku with a system prompt containing ARCH-GAP and DESIGN-ASSUMPTION keywords", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ARCH-GAP" }] })

    await classifyForArchGap("Does the API support streaming?")

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("ARCH-GAP")
    expect(call.system).toContain("DESIGN-ASSUMPTION")
  })

  it("includes the THE SINGLE TEST question in the system prompt", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ARCH-GAP" }] })

    await classifyForArchGap("Does the API support streaming?")

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("Would the UI look or behave differently depending on the answer")
  })

  it("passes the escalation question as the user message", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "DESIGN-ASSUMPTION" }] })

    const question = "How is session data stored on the backend?"
    await classifyForArchGap(question)

    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toBe(question)
  })

  it("uses a token budget sufficient to return a single keyword (max_tokens <= 64)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ARCH-GAP" }] })

    await classifyForArchGap("Some question")

    const call = mockCreate.mock.calls[0][0]
    // Response is a single keyword — large token budget is wasteful and slow
    expect(call.max_tokens).toBeLessThanOrEqual(64)
  })
})
