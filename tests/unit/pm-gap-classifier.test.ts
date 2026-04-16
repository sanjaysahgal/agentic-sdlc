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

  it("uses max_tokens 1024 — sufficient for 6+ gaps without truncation", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })

    await classifyForPmGaps({ agentResponse: "some prose" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 1024 })
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

  it("extracts a single DESIGN: line into designItems", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "DESIGN: Exact element type for the guest session indicator (icon vs chip vs inline text)." }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some agent prose" })

    expect(result.designItems).toHaveLength(1)
    expect(result.designItems[0]).toContain("indicator")
    expect(result.gaps).toHaveLength(0)
    expect(result.architectItems).toHaveLength(0)
  })

  it("extracts mixed GAP: and DESIGN: lines into separate arrays", async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: "GAP: Error experience for failed guest session claim is undefined.\nDESIGN: Placement of the session timer relative to the prompt bar.\nDESIGN: Animation timing for the session expiry warning (entry direction, duration, easing).",
      }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some prose" })

    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toContain("Error experience")
    expect(result.designItems).toHaveLength(2)
    expect(result.designItems[0]).toContain("Placement")
    expect(result.designItems[1]).toContain("Animation")
    expect(result.architectItems).toHaveLength(0)
  })

  it("returns designItems when only DESIGN: lines present, gaps is empty", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "DESIGN: Where exactly the wordmark sits relative to the prompt bar.\nDESIGN: Whether the notification uses a glow or shadow effect." }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some prose" })

    expect(result.gaps).toHaveLength(0)
    expect(result.designItems).toHaveLength(2)
    expect(result.architectItems).toHaveLength(0)
  })

  it("skips a DESIGN: line with empty body after trimming", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "DESIGN:   \nDESIGN: Real design item." }],
    })

    const result = await classifyForPmGaps({ agentResponse: "some prose" })

    expect(result.designItems).toHaveLength(1)
    expect(result.designItems[0]).toBe("Real design item.")
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

  it("system prompt gives visual/UX decisions their own DESIGN: category — not routed to PM", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Visual/UX decisions must be classified as DESIGN:, keeping them out of PM-scope GAP: output
    expect(systemPrompt).toContain("DESIGN:")
    expect(systemPrompt.toLowerCase()).toMatch(/visual|ux|element type|placement/)
  })

  it("system prompt names layout and visual styling as NOT PM-scope with concrete examples", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must name specific visual examples so classifier doesn't flag layout/styling gaps as PM
    expect(systemPrompt.toLowerCase()).toMatch(/wordmark|glow|gradient|opacity|shadow/)
    expect(systemPrompt.toLowerCase()).toMatch(/layout|screen structure|visual hierarchy/)
  })

  it("system prompt defines the PM as owning the WHAT — not the HOW", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Core PM identity: customer journey / user experience, not implementation
    expect(systemPrompt.toLowerCase()).toMatch(/what.*how|how.*what/)
    expect(systemPrompt.toLowerCase()).toMatch(/customer journey|user delight|retention/)
  })

  it("system prompt names session store schema and account-linking mechanism as architecture-scope (not PM)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // These concrete examples prevent the classifier from routing implementation questions to PM
    expect(systemPrompt.toLowerCase()).toContain("session store")
    expect(systemPrompt.toLowerCase()).toContain("account-linking")
  })

  it("system prompt gives the PM→architect decision rule: schema/mechanism/data model = architect", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Decision signal: these words in a question → architect, not PM
    expect(systemPrompt.toLowerCase()).toMatch(/schema|mechanism|data model/)
    expect(systemPrompt.toLowerCase()).toMatch(/architect/)
  })

  it("system prompt frames PM gaps as user experience or product requirements — not technical specs", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // GAP output framing: PM decision = user experience or product requirement
    expect(systemPrompt.toLowerCase()).toMatch(/user experience|product requirement/)
  })

  it("system prompt defines DESIGN: as the prefix for visual/UX decisions the designer owns", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("DESIGN:")
  })

  it("system prompt names element type, placement, and animation timing as design-scope examples", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // These concrete examples prevent the classifier from routing visual/UX questions to PM
    expect(systemPrompt.toLowerCase()).toMatch(/element type|placement|timing/)
    expect(systemPrompt.toLowerCase()).toMatch(/animation|duration|easing/)
  })

  it("system prompt distinguishes design-scope from architecture-scope — designer resolves design items independently", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Key distinction: designer owns these, no PM or architect input needed
    expect(systemPrompt.toLowerCase()).toMatch(/designer.*independently|independently.*designer|resolves.*independently|independently.*resolv/)
  })

  it("system prompt instructs Haiku to output 'DESIGN: <sentence>' per design-scope item found", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("DESIGN:")
    // Must be in the output format instructions, not just as a category name
    expect(systemPrompt).toMatch(/DESIGN:.*one sentence|output.*DESIGN:|DESIGN:.*visual/)
  })

  it("system prompt explicitly classifies 'PM spec says X, design spec says Y — which is right?' as DESIGN-scope for visual/animation details", async () => {
    // Root cause of Apr 2026 misclassification: design agent asked which animation opacity
    // value was correct (PM spec: 25%→35% over 2.5s, design spec: 50-100% over 4s).
    // Classifier saw "PM spec" and returned GAP: instead of DESIGN:.
    // System prompt must explicitly address this pattern.
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must state that spec contradictions on visual/animation values are always DESIGN-scope
    expect(systemPrompt.toLowerCase()).toMatch(/spec.*contradiction|contradiction.*spec|contradict.*visual|visual.*contradict/)
    // Must name the specific patterns that triggered the misclassification
    expect(systemPrompt.toLowerCase()).toMatch(/opacity|animation.*duration|duration.*animation/)
    // Must explicitly say NEVER classify as PM gap
    expect(systemPrompt.toLowerCase()).toMatch(/never.*classify.*pm|always.*design|design.*scope/)
  })

  it("system prompt lists opacity cycles and animation durations as DESIGN-scope examples — not PM-scope", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Opacity cycle and animation duration are canonical DESIGN examples after Apr 2026 incident
    expect(systemPrompt.toLowerCase()).toMatch(/opacity.*cycle|opacity.*cycling|opacity.*percent/)
    expect(systemPrompt.toLowerCase()).toMatch(/animation.*duration|duration.*animation|animation.*cycle/)
  })

  it("system prompt instructs Haiku to check the approved PM spec before classifying — already-answered questions are DESIGN not GAP", async () => {
    // Root cause of Apr 2026 false positive: session expiry duration (AC#23: 60 min) was
    // explicitly in the approved PM spec but Gate 4 classifier still returned GAP:.
    // The classifier had the PM spec as context but no explicit instruction to cross-reference it.
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "NONE" }] })
    await classifyForPmGaps({ agentResponse: "some prose" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must instruct classifier to read the PM spec first before classifying
    expect(systemPrompt.toLowerCase()).toMatch(/read.*spec.*first|check.*spec.*first|approved.*spec.*first|spec.*before classif/)
    // Must instruct that already-answered questions are NOT PM gaps
    expect(systemPrompt.toLowerCase()).toMatch(/already.*answered|answered.*already|already.*explicit|explicit.*answer/)
  })
})
