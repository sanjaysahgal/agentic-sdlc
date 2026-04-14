import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Module mocks ────────────────────────────────────────────────────────────
// No Anthropic call — patchEngineeringSpecWithDecision is a pure string operation.

const mockReadFile = vi.hoisted(() => vi.fn())
const mockSaveDraftEngineeringSpec = vi.hoisted(() => vi.fn())
vi.mock("../../runtime/github-client", () => ({
  readFile: mockReadFile,
  saveDraftEngineeringSpec: mockSaveDraftEngineeringSpec,
}))

vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: () => ({
    paths: { featuresRoot: "specs/features" },
  }),
}))

import { patchEngineeringSpecWithDecision } from "../../runtime/engineering-spec-decision-writer"

// ─── beforeEach ──────────────────────────────────────────────────────────────

beforeEach(() => {
  mockReadFile.mockReset()
  mockSaveDraftEngineeringSpec.mockReset()
  mockSaveDraftEngineeringSpec.mockResolvedValue(undefined)
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("patchEngineeringSpecWithDecision", () => {
  const FEATURE = "onboarding"
  const QUESTION = "What is the max file upload size the API will accept?"
  const DECISION = "The API enforces a 10MB limit per upload — any larger payload returns 413."

  it("creates a stub engineering spec when the branch has no file", async () => {
    mockReadFile.mockResolvedValue(null)
    await patchEngineeringSpecWithDecision({ featureName: FEATURE, question: QUESTION, decision: DECISION })

    expect(mockSaveDraftEngineeringSpec).toHaveBeenCalledOnce()
    const saved: string = mockSaveDraftEngineeringSpec.mock.calls[0][0].content
    expect(saved).toContain("## Pre-Engineering Architectural Decisions")
    expect(saved).toContain(QUESTION)
    expect(saved).toContain(DECISION)
  })

  it("appends to ## Pre-Engineering Architectural Decisions when section already exists", async () => {
    const existing = `# Onboarding Engineering Spec\n\n## Pre-Engineering Architectural Decisions\n\n### Architect Decision (pre-engineering)\n**Question:** Earlier question\n**Decision:** Earlier answer\n`
    mockReadFile.mockResolvedValue(existing)
    await patchEngineeringSpecWithDecision({ featureName: FEATURE, question: QUESTION, decision: DECISION })

    const saved: string = mockSaveDraftEngineeringSpec.mock.calls[0][0].content
    expect(saved).toContain("Earlier question")
    expect(saved).toContain(QUESTION)
    expect(saved).toContain(DECISION)
  })

  it("adds ## Pre-Engineering Architectural Decisions section when spec exists but section does not", async () => {
    const existing = `# Onboarding Engineering Spec\n\n## Open Questions\n- [type: engineering] [blocking: no] Cache TTL?\n`
    mockReadFile.mockResolvedValue(existing)
    await patchEngineeringSpecWithDecision({ featureName: FEATURE, question: QUESTION, decision: DECISION })

    const saved: string = mockSaveDraftEngineeringSpec.mock.calls[0][0].content
    expect(saved).toContain("## Pre-Engineering Architectural Decisions")
    expect(saved).toContain("## Open Questions")
    expect(saved).toContain(QUESTION)
  })

  it("makes no Anthropic API call — pure string operation", async () => {
    mockReadFile.mockResolvedValue(null)
    await patchEngineeringSpecWithDecision({ featureName: FEATURE, question: QUESTION, decision: DECISION })
    // If Anthropic was called it would throw (no mock). Reaching here means no LLM call.
    expect(mockSaveDraftEngineeringSpec).toHaveBeenCalledOnce()
  })

  it("is non-blocking — swallows save errors without throwing", async () => {
    mockReadFile.mockResolvedValue(null)
    mockSaveDraftEngineeringSpec.mockRejectedValue(new Error("GitHub 503"))
    await expect(patchEngineeringSpecWithDecision({ featureName: FEATURE, question: QUESTION, decision: DECISION })).resolves.toBeUndefined()
  })
})
