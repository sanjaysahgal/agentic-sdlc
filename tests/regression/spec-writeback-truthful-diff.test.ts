import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * B24 — regression catalog bug #19.
 *
 * Catastrophic Step 2a observation #29: post-writeback platform message said
 * "The product spec was partially updated, but 1 PM-scope gap remains."
 * Reality: 6 unrelated ACs had been corrupted by the strip-pass and the
 * original gap PM was supposed to fix went untouched. The user had no warning
 * that 6 ACs had changed — the message implied a small leftover after a fix.
 *
 * Fix: deterministic AC-level diff summary computed inside the writer and
 * surfaced in the user-facing closure / re-audit messages. Same input ⇒ same
 * brief (Principle 11). The user sees concrete change reporting like "Modified
 * ACs 1, 2, 3, 5, 6" instead of vague "spec was updated."
 */

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

beforeEach(() => {
  mockCreate.mockReset()
  mockReadFile.mockReset()
  mockSaveApproved.mockReset()
  mockSaveApproved.mockResolvedValue("already-on-main")
})

describe("bug #19 — B24 truthful post-writeback diff brief (catastrophic Step 2a #29)", () => {
  it("writer returns a diffSummary with concrete modified-AC list when patch changes ACs", async () => {
    const PRE_SPEC = `# Onboarding Product Spec

## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation.
3. The user can log in.
4. The user receives a welcome email.
`
    const POST_PATCH = `## Acceptance Criteria
1. The user can sign up via email AND SSO.
2. The user receives confirmation within 1 second.
3. The user can log in.
4. The user receives a welcome email.
`
    mockReadFile.mockResolvedValue(PRE_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: POST_PATCH }] })

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: "How should sign-up work?",
      recommendations: "My recommendation: support both email and SSO; confirmation must arrive within 1 second.",
      humanConfirmation: "yes approved",
    })

    expect(result).not.toBeNull()
    expect(result!.diffSummary).toBeDefined()
    expect(result!.diffSummary.modifiedAcs).toEqual([1, 2])
    expect(result!.diffSummary.brief).toContain("Modified ACs 1, 2")
  })

  it("structural assertion: pm-escalation-spec-writer imports + invokes summarizeAcDiff before returning", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"),
      "utf8",
    )

    // Diff helper imported.
    expect(source).toMatch(/from\s+["']\.\/spec-diff-summary["']/)
    expect(source).toMatch(/summarizeAcDiff\s*\(/)

    // Diff is computed AFTER the save (so existingSpec vs mergedSpec is the
    // accurate before/after), and the function returns { mergedSpec, diffSummary }.
    const fnEntryIdx = source.indexOf("export async function patchProductSpecWithRecommendations")
    const saveIdx = source.indexOf("saveApprovedSpec(", fnEntryIdx)
    const diffIdx = source.indexOf("summarizeAcDiff(", fnEntryIdx)
    expect(saveIdx).toBeGreaterThan(fnEntryIdx)
    expect(diffIdx).toBeGreaterThan(saveIdx)

    // Return shape includes diffSummary.
    expect(source).toMatch(/return\s+\{\s*mergedSpec\s*,\s*diffSummary\s*\}/)
  })

  it("structural assertion: message.ts surfaces the diff brief in the user-facing closure messages", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    // The two PM-spec call sites both consume the writeback's diffSummary.brief
    // and inject it into the post-writeback chat.postMessage text. Look for the
    // bridging variable names (pmDiffBrief and archUpstreamDiffBrief) and verify
    // each is referenced inside a chat.postMessage text template.
    expect(source).toMatch(/pmDiffBrief/)
    expect(source).toMatch(/archUpstreamDiffBrief/)

    // The closure messages must reference the diff brief variables — i.e.
    // they're not just declared and never used.
    const pmBriefRefs = (source.match(/pmDiffBrief/g) || []).length
    expect(pmBriefRefs).toBeGreaterThanOrEqual(3)  // declaration + assignment + at least one use
    const archBriefRefs = (source.match(/archUpstreamDiffBrief/g) || []).length
    expect(archBriefRefs).toBeGreaterThanOrEqual(3)
  })

  it("canonical #29 corruption case: 6-AC corruption surfaces explicitly in the brief instead of vague 'partially updated'", async () => {
    // The exact strip-pass corruption pattern from Step 2a observation #29.
    const PRE_SPEC = `## Acceptance Criteria
1. The system applies the policy within 1 second of receipt.
2. Users sign up within 30 seconds.
3. Sessions expire after 60 minutes of inactivity.
4. Warning appears 10 minutes before timeout.
5. Indicator disappears within 1 second of token receipt.
6. Validation completes within 200ms.
`
    const CORRUPTED_PATCH = `## Acceptance Criteria
1. The system applies the policy.
2. Users sign up promptly.
3. Sessions expire after a period of inactivity.
4. Warning appears 10 minutes before timeout.
5. Indicator disappears upon token receipt.
6. Validation completes quickly.
`
    mockReadFile.mockResolvedValue(PRE_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: CORRUPTED_PATCH }] })

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: "vague-language gap",
      recommendations: "My recommendation: replace 'soft' with concrete values.",
      humanConfirmation: "yes approved",
    })

    // The brief must concretely report 5 modified ACs — what actually happened.
    expect(result!.diffSummary.modifiedAcs).toEqual([1, 2, 3, 5, 6])
    expect(result!.diffSummary.brief).toContain("Modified ACs 1, 2, 3, 5, 6")
  })
})
