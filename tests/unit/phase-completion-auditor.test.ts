import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { auditPhaseCompletion, PM_RUBRIC, DESIGN_RUBRIC } from "../../runtime/phase-completion-auditor"

beforeEach(() => {
  mockCreate.mockReset()
})

describe("auditPhaseCompletion", () => {
  it("returns ready: true and empty findings when Sonnet responds PASS", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    const result = await auditPhaseCompletion({
      specContent: "# Feature Spec\n## Problem\nClear problem.",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("parses a single FINDING line into one finding", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "FINDING: Missing error path for user story 3 | Add error handling for network failure in ## Edge Cases" }],
    })

    const result = await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].issue).toBe("Missing error path for user story 3")
    expect(result.findings[0].recommendation).toBe("Add error handling for network failure in ## Edge Cases")
  })

  it("parses multiple FINDING lines into multiple findings", async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: "FINDING: Acceptance criterion 2 uses 'fast' without a baseline | Replace with '<200ms response time measured from tap to first render'\nFINDING: Non-Goals section is empty | Add at least one explicit scope exclusion, e.g. 'Does not support offline mode'",
      }],
    })

    const result = await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(false)
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0].issue).toContain("criterion 2")
    expect(result.findings[1].issue).toContain("Non-Goals")
  })

  it("returns ready: true on unexpected response format (fail-safe — does not block)", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot determine whether this spec is complete." }],
    })

    const result = await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("passes spec content as the user message", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    const specContent = "# My Feature Spec\n## Problem\nThis is the spec."
    await auditPhaseCompletion({ specContent, rubric: PM_RUBRIC, featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain(specContent)
  })

  it("injects the rubric string into the system prompt", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    const customRubric = "1. THE CUSTOM CRITERION — must be present and specific."
    await auditPhaseCompletion({ specContent: "spec", rubric: customRubric, featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("THE CUSTOM CRITERION")
  })

  it("uses claude-sonnet-4-6 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    )
  })

  it("trims leading and trailing whitespace from issue and recommendation", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "FINDING:  missing copy  |  add a button label  " }],
    })

    const result = await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    expect(result.findings[0].issue).toBe("missing copy")
    expect(result.findings[0].recommendation).toBe("add a button label")
  })

  it("skips a malformed FINDING line with no pipe delimiter — no crash, returns ready: true", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "FINDING: this line has no pipe delimiter at all" }],
    })

    const result = await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("includes productVision and systemArchitecture in the user message when provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "test",
      productVision: "We build a health app.",
      systemArchitecture: "React Native, tRPC.",
    })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain("We build a health app.")
    expect(userMessage).toContain("React Native, tRPC.")
  })

  it("does not include context section when productVision and systemArchitecture are absent", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).not.toContain("Product Vision")
    expect(userMessage).not.toContain("System Architecture")
  })
})

describe("PM_RUBRIC and DESIGN_RUBRIC exports", () => {
  it("PM_RUBRIC is exported as a non-empty string", () => {
    expect(typeof PM_RUBRIC).toBe("string")
    expect(PM_RUBRIC.length).toBeGreaterThan(0)
  })

  it("DESIGN_RUBRIC is exported as a non-empty string", () => {
    expect(typeof DESIGN_RUBRIC).toBe("string")
    expect(DESIGN_RUBRIC.length).toBeGreaterThan(0)
  })
})
