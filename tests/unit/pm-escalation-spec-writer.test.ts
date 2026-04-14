import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Module mocks ───────────────────────────────────────────────────────────
// Module-level Anthropic client in pm-escalation-spec-writer.ts requires
// vi.mock at the module level (hoisted) to intercept construction at import time.

const mockCreate = vi.hoisted(() => vi.fn())
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

const mockReadFile     = vi.hoisted(() => vi.fn())
const mockSaveApproved = vi.hoisted(() => vi.fn())
vi.mock("../../runtime/github-client", () => ({
  readFile: mockReadFile,
  saveApprovedSpec: mockSaveApproved,
}))

vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: () => ({
    paths: { featuresRoot: "specs/features" },
  }),
}))

import { patchProductSpecWithRecommendations } from "../../runtime/pm-escalation-spec-writer"

// ─── Fixtures ───────────────────────────────────────────────────────────────
const EXISTING_SPEC = `# Onboarding Product Spec

## Acceptance Criteria
- User can register with email and password.

## Edge Cases
- Network failure during registration shows generic error.
`

const VALID_PATCH = `## Acceptance Criteria
- User can register with email and password.
- In-conversation nudge shows once per session and does not repeat after dismissal.

## Edge Cases
- Network failure during registration shows generic error.
- If nudge is dismissed, it never appears again in that session even after navigation.
`

const BLOCKING_QUESTION = "Should the in-conversation nudge show once per session or repeat after dismissal?"
const RECOMMENDATIONS   = "1. My recommendation: Show once per session — does not repeat after dismissal.\n→ Rationale: Repeating erodes trust."
const HUMAN_CONFIRM     = "I approve all your recommendations"

// ─── beforeEach ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCreate.mockReset()
  mockReadFile.mockReset()
  mockSaveApproved.mockReset()
  mockSaveApproved.mockResolvedValue("already-on-main")
})

// ─── Consumer tests (gate logic) ────────────────────────────────────────────

describe("patchProductSpecWithRecommendations — consumer (gate logic)", () => {
  it("returns early and skips Anthropic when readFile returns empty string (spec not on main)", async () => {
    mockReadFile.mockResolvedValue("")

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSaveApproved).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it("calls Anthropic with the spec, question, and recommendations when spec exists", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_PATCH }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate).toHaveBeenCalledOnce()
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.messages[0].content).toContain(EXISTING_SPEC)
    expect(callArgs.messages[0].content).toContain(BLOCKING_QUESTION)
    expect(callArgs.messages[0].content).toContain(RECOMMENDATIONS)
  })

  it("calls saveApprovedSpec with merged spec when Anthropic returns a valid ## patch", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_PATCH }] })

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockSaveApproved).toHaveBeenCalledOnce()
    const saveArgs = mockSaveApproved.mock.calls[0][0]
    expect(saveArgs.featureName).toBe("onboarding")
    expect(saveArgs.filePath).toContain("onboarding.product.md")
    // Merged spec must contain the new acceptance criterion from the patch
    expect(saveArgs.content).toContain("once per session")
    // Return value must be the merged spec content (for post-patch adversarial audit)
    expect(result).not.toBeNull()
    expect(result).toContain("once per session")
  })

  it("returns null when Anthropic returns text without ## headers (patch invalid)", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I have reviewed the recommendations and they look good." }],
    })

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(result).toBeNull()
  })

  it("skips saveApprovedSpec when Anthropic returns text without ## headers", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I have reviewed the recommendations and they look good." }],
    })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockSaveApproved).not.toHaveBeenCalled()
  })

  it("skips saveApprovedSpec when Anthropic returns empty text", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "" }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockSaveApproved).not.toHaveBeenCalled()
  })

  it("skips saveApprovedSpec when Anthropic returns a non-text content block", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockSaveApproved).not.toHaveBeenCalled()
  })

  it("reads from the correct product spec path (featuresRoot/name/name.product.md)", async () => {
    mockReadFile.mockResolvedValue("")

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockReadFile).toHaveBeenCalledWith("specs/features/onboarding/onboarding.product.md", "main")
  })
})

// ─── Producer tests (system prompt constraints) ──────────────────────────────

describe("patchProductSpecWithRecommendations — producer (system prompt)", () => {
  beforeEach(() => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_PATCH }] })
  })

  it("system prompt instructs Haiku to output only sections that changed — not the entire spec", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toMatch(/only sections that changed|output only.*changed/)
  })

  it("system prompt requires concrete measurable entries — prohibits vague language", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("concrete, measurable")
  })

  it("system prompt routes product decisions to ## Acceptance Criteria and edge cases to ## Edge Cases", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("## Acceptance Criteria")
    expect(systemPrompt).toContain("## Edge Cases")
  })

  it("system prompt prohibits preamble and explanatory text outside ## sections", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("preamble")
    expect(systemPrompt.toLowerCase()).toMatch(/nothing outside|no.*outside|text outside/)
  })

  it("system prompt instructs Haiku to REPLACE vague criteria — not append new ones alongside old", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must explicitly say to replace, not add alongside
    expect(systemPrompt.toLowerCase()).toMatch(/replace.*vague|vague.*replace/)
    expect(systemPrompt.toLowerCase()).toMatch(/remove.*vague|do not keep both|remove.*entirely/)
  })

  it("system prompt names specific vague words that must be replaced — including 'soft', 'ambient', 'non-intrusive'", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // The cycle-causing words must be explicitly named so Haiku knows to replace them
    expect(systemPrompt.toLowerCase()).toContain("soft")
    expect(systemPrompt.toLowerCase()).toContain("ambient")
    expect(systemPrompt.toLowerCase()).toContain("non-intrusive")
    expect(systemPrompt.toLowerCase()).toContain("seamlessly")
  })

  it("system prompt instructs Haiku to STRIP visual/design details from PM recommendations before writing to spec", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must explicitly prohibit color values and component choices from being written to spec
    expect(systemPrompt.toLowerCase()).toMatch(/strip|remove.*visual|visual.*detail/)
    expect(systemPrompt.toLowerCase()).toMatch(/hex|rgba|color/)
    expect(systemPrompt.toLowerCase()).toMatch(/component|badge|chip/)
  })

  it("system prompt requires section output to carry ALL existing criteria — not just the changed ones", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Section body must be complete — applySpecPatch replaces entire section, not individual criteria
    expect(systemPrompt.toLowerCase()).toMatch(/all.*criteria|complete.*section|all existing/)
  })

  it("system prompt instructs Haiku to scan entire spec for remaining vague language beyond current escalation questions", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Hygiene pass must scan the whole spec — not just the areas addressed by current PM recommendations
    expect(systemPrompt.toLowerCase()).toMatch(/hygiene|scan.*entire|scan.*whole|scan.*spec/)
    // Must leave unchanged anything the PM never addressed — no invented decisions
    expect(systemPrompt.toLowerCase()).toMatch(/cannot be inferred|never addressed|leave.*unchanged|do not invent/)
  })

  it("uses claude-haiku-4-5-20251001 — fast focused patch generation, not Sonnet", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001")
  })
})
