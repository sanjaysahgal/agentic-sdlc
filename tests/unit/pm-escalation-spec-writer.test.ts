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

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSaveApproved).not.toHaveBeenCalled()
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
    expect(callArgs.messages[0].content).toContain(HUMAN_CONFIRM)
  })

  it("calls saveApprovedSpec with merged spec when Anthropic returns a valid ## patch", async () => {
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_PATCH }] })

    await patchProductSpecWithRecommendations({
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

  it("system prompt instructs Haiku to output only ## sections that changed — not the entire spec", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("only changed sections")
    expect(systemPrompt).toContain("Do not output the entire spec")
  })

  it("system prompt requires concrete measurable entries — prohibits vague language", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("concrete, measurable")
    expect(systemPrompt).toContain("not vague language")
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
    expect(systemPrompt).toContain("Do not add a preamble")
    expect(systemPrompt).toContain("any text outside the ## sections")
  })

  it("uses claude-haiku-4-5-20251001 — fast focused patch generation, not Sonnet", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001")
  })
})
