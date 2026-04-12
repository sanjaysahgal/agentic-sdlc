import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { classifyForPmGaps } from "../../runtime/pm-gap-classifier"

beforeEach(() => {
  mockCreate.mockReset()
})

// ─── Consumer tests — gate logic ──────────────────────────────────────────────

describe("classifyForPmGaps — consumer tests (gate logic with mocked Haiku)", () => {
  it("returns empty gaps when Haiku responds NONE", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })

    const result = await classifyForPmGaps({ agentResponse: "The design looks complete." })

    expect(result.gaps).toHaveLength(0)
  })

  it("extracts a single GAP: line into one gap", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "GAP: Session expiry behavior is undefined in the PM spec." }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some agent prose" })

    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toBe("Session expiry behavior is undefined in the PM spec.")
  })

  it("extracts multiple GAP: lines into multiple gaps", async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: "GAP: Error state for failed SSO is not defined.\nGAP: Tier eligibility for the feature is unspecified.",
      }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some agent prose" })

    expect(result.gaps).toHaveLength(2)
    expect(result.gaps[0]).toContain("SSO")
    expect(result.gaps[1]).toContain("Tier")
  })

  it("trims whitespace from extracted gap text", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "GAP:  leading and trailing space  " }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some agent prose" })

    expect(result.gaps[0]).toBe("leading and trailing space")
  })

  it("skips lines that do not start with GAP: — no crash, gap not included", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "This line has no prefix.\nGAP: Real gap here.\nAlso no prefix." }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some agent prose" })

    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toBe("Real gap here.")
  })

  it("skips a GAP: line with empty body after trimming", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "GAP:   \nGAP: Real gap." }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some agent prose" })

    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toBe("Real gap.")
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })

    await classifyForPmGaps({ agentResponse: "some prose" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
    )
  })

  it("passes agentResponse as part of the user message", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })

    const agentResponse = "The color palette needs finalizing."
    await classifyForPmGaps({ agentResponse })

    const call = mockCreate.mock.calls[0][0]
    const userContent = call.messages[0].content as string
    expect(userContent).toContain(agentResponse)
  })

  it("includes approvedProductSpec in user message when provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })

    await classifyForPmGaps({
      agentResponse: "some prose",
      approvedProductSpec: "## Acceptance Criteria\n1. Users can sign in via SSO.",
    })

    const call = mockCreate.mock.calls[0][0]
    const userContent = call.messages[0].content as string
    expect(userContent).toContain("Approved Product Spec")
    expect(userContent).toContain("Users can sign in via SSO")
  })

  it("omits Approved Product Spec section when approvedProductSpec is not provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })

    await classifyForPmGaps({ agentResponse: "some prose" })

    const call = mockCreate.mock.calls[0][0]
    const userContent = call.messages[0].content as string
    expect(userContent).not.toContain("Approved Product Spec")
  })

  it("propagates API error — not swallowed, single call", async () => {
    mockCreate.mockRejectedValue(new Error("APITimeoutError: Request timed out"))

    await expect(classifyForPmGaps({ agentResponse: "some prose" }))
      .rejects.toThrow()

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

// ─── Producer tests — system prompt format instructions ───────────────────────
//
// Producer-consumer chain rule: consumer tests above verify the gate parses GAP:/NONE
// correctly when given those strings. These producer tests verify the system prompt
// actually instructs Haiku to produce that format — so the producer → consumer chain
// is end-to-end verified.

describe("classifyForPmGaps — producer tests (system prompt contains format instructions)", () => {
  it("system prompt instructs Haiku to output 'GAP: <sentence>' per gap found", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("GAP:")
  })

  it("system prompt instructs Haiku to output exactly 'NONE' when no gaps found", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("NONE")
  })

  it("system prompt instructs Haiku to output no preamble — only GAP lines or NONE", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toMatch(/no preamble|output only|only gap/i)
  })

  it("system prompt names 'handle gracefully' as a PM-scope gap example", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toContain("handle gracefully")
  })

  it("system prompt names qualitative/measurable criteria as PM-scope", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toMatch(/measurable|qualitative/i)
  })

  it("system prompt explicitly excludes design decisions from PM-scope", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toContain("design decision")
  })

  it("system prompt names layout and visual styling as NOT PM-scope with concrete examples", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must name specific visual examples so classifier doesn't flag layout/styling gaps as PM
    expect(systemPrompt.toLowerCase()).toMatch(/wordmark|glow|gradient|opacity|shadow/)
    expect(systemPrompt.toLowerCase()).toMatch(/layout|screen structure|visual hierarchy/)
  })
})
