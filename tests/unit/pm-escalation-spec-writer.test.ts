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
    // B24 — return value is { mergedSpec, diffSummary }; mergedSpec contains the patch.
    expect(result).not.toBeNull()
    expect(result!.mergedSpec).toContain("once per session")
    expect(result!.diffSummary).toBeDefined()
    expect(typeof result!.diffSummary.brief).toBe("string")
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

  it("system prompt instructs Haiku to STRIP all UI copy — copy is a designer decision, not a PM decision", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Copy/wording belongs to designer — Haiku must strip specific strings from PM recommendations
    expect(systemPrompt.toLowerCase()).toMatch(/strip.*copy|copy.*designer|designer.*writes.*words|designer.*writes.*actual/)
    // Must not have the old qualifier that permitted "required user-facing strings"
    expect(systemPrompt).not.toContain("unless it is the required user-facing string")
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

  it("max_tokens is 4096 — large enough for full spec patch when many recommendations are applied", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(4096)
  })

  it("system prompt instructs Haiku to RESOLVE contradictions — never output two criteria that say opposite things", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must explicitly instruct to resolve conflicts, not faithfully reproduce both
    expect(systemPrompt.toLowerCase()).toMatch(/resolve.*contradiction|contradict|conflict/)
    expect(systemPrompt.toLowerCase()).toMatch(/never.*two criteria|remove.*contradict|contradictory criterion/)
  })

  it("system prompt instructs Haiku to COMPLETE or REMOVE incomplete criteria — never leave a stub in the spec", async () => {
    await patchProductSpecWithRecommendations({
      featureName: "onboarding", question: BLOCKING_QUESTION, recommendations: RECOMMENDATIONS, humanConfirmation: HUMAN_CONFIRM,
    })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must explicitly instruct to handle incomplete/truncated criteria
    expect(systemPrompt.toLowerCase()).toMatch(/incomplete|incomplete criteria|remove it/)
    expect(systemPrompt.toLowerCase()).toMatch(/tbd|todo|placeholder/)
  })
})

// ─── Post-patch visual detail audit ─────────────────────────────────────────
//
// After Haiku generates a patch, the spec-writer runs a structural scan for
// visual/animation details that should never appear in a PM product spec.
// If found, a second Haiku pass strips them before saving.

describe("patchProductSpecWithRecommendations — post-patch visual detail audit", () => {
  const SPEC_WITH_VISUAL_DETAILS = `# Onboarding Product Spec

## Acceptance Criteria
- User can register with email and password.
- The logged-out indicator displays a glow animation with opacity cycling 25% → 35% → 25% over 2.5 seconds.
- Session expires after 30 minutes of inactivity.

## Edge Cases
- Network failure during registration shows generic error.
`

  const SPEC_NO_VISUAL_DETAILS = `# Onboarding Product Spec

## Acceptance Criteria
- User can register with email and password.
- The logged-out indicator is persistently visible whenever the user is not authenticated.
- Session expires after 30 minutes of inactivity.

## Edge Cases
- Network failure during registration shows generic error.
`

  beforeEach(() => {
    mockCreate.mockReset()
    mockReadFile.mockReset()
    mockSaveApproved.mockReset()
    mockSaveApproved.mockResolvedValue("already-on-main")
  })

  it("triggers second Haiku pass when merged spec contains opacity percentage in a criterion", async () => {
    // First call: main patch. Returns a patch that includes visual detail (opacity %).
    // Second call: strip pass. Returns cleaned spec.
    mockReadFile.mockResolvedValue(SPEC_WITH_VISUAL_DETAILS)
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "## Acceptance Criteria\n- User can register.\n- The logged-out indicator displays a glow animation with opacity cycling 25% → 35% → 25% over 2.5 seconds.\n- Session expires after 30 minutes." }] }) // patch
      .mockResolvedValueOnce({ content: [{ type: "text", text: SPEC_NO_VISUAL_DETAILS }] }) // strip pass

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // Two Haiku calls: patch + strip
    expect(mockCreate).toHaveBeenCalledTimes(2)

    // Strip pass system prompt must explicitly target opacity, animation timing, color values
    const stripPrompt = mockCreate.mock.calls[1][0].system as string
    expect(stripPrompt.toLowerCase()).toMatch(/opacity|animation|gradient/)
    expect(stripPrompt.toLowerCase()).toMatch(/remove|strip/)
  })

  it("skips second Haiku pass when merged spec has no visual details", async () => {
    mockReadFile.mockResolvedValue(SPEC_NO_VISUAL_DETAILS)
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "## Acceptance Criteria\n- User can register.\n- The logged-out indicator is persistently visible.\n- Session expires after 30 minutes." }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // Only one Haiku call — no strip pass needed
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("saves the strip-pass result — not the un-stripped merged spec — when visual details are detected", async () => {
    mockReadFile.mockResolvedValue(SPEC_WITH_VISUAL_DETAILS)
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "## Acceptance Criteria\n- glow opacity 25% → 35% over 2.5 seconds." }] }) // patch with visual details
      .mockResolvedValueOnce({ content: [{ type: "text", text: SPEC_NO_VISUAL_DETAILS }] }) // strip pass returns clean spec

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // saveApprovedSpec received the strip-pass output, not the un-stripped merged spec
    const savedContent = mockSaveApproved.mock.calls[0][0].content as string
    expect(savedContent).not.toContain("25% → 35%")
    expect(savedContent).not.toContain("2.5 seconds")
    // Return value is also the cleaned spec
    expect(result).not.toContain("25% → 35%")
  })
})

// ─── B22 regression: visual-detail strip pass scope correction ──────────────
//
// Step 2a verification observations #24/#25: the pre-B22 VISUAL_DETAIL_PATTERNS
// regex array matched any `Xms` / `X seconds` / `X minutes` pattern anywhere
// in the spec. PM legitimately recommended "within 200ms of access token
// expiry detection" → strip pass triggered → Haiku removed ALL timing values
// across 6 unrelated ACs (catastrophic spec corruption). B22 narrows the
// timing patterns to require design-vocabulary context (animation, cycle,
// loop, fade, transition, ease) within close proximity. Pure product SLAs
// stay untouched.

describe("B22 — visual-detail strip pass scope correction (regression for Step 2a observation #24/#25)", () => {
  it("does NOT trigger strip pass on PM-spec with product-SLA timing in acceptance criteria (the canonical bug case)", async () => {
    // Spec patched with the exact pattern from Step 2a observation #24/#25:
    // - "within 200ms of access token expiry detection" (PM's recommended SLA)
    // - "within 1 second of valid authentication token receipt" (existing AC)
    // - "after 60 minutes of inactivity" (existing AC)
    // - "applied server-side within one request-response cycle" (existing AC)
    // Pre-B22, the strip pass would have fired and Haiku would have removed
    // ALL of these. Post-B22, none of them match the narrowed regex → no
    // strip pass → only ONE Anthropic call (the patch), not two.
    const SPEC_WITH_PRODUCT_SLAS = `# Onboarding Product Spec

## Acceptance Criteria
- The logged-out indicator disappears within 1 second of valid authentication token receipt.
- The "Not signed in" indicator reappears within 200ms of access token expiry detection on the client.
- Unauthenticated sessions expire after 60 minutes of inactivity; timer reset is applied server-side within one request-response cycle.

## Edge Cases
- Session expiry warning appears 10 minutes before timeout.
`
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: SPEC_WITH_PRODUCT_SLAS }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // CRITICAL B22 ASSERTION: only ONE Anthropic call (the patch). If the strip
    // pass had triggered (pre-B22 behavior on these product SLAs), there would
    // be TWO calls. This is the structural proof that product SLAs are not
    // misclassified as visual details.
    expect(mockCreate).toHaveBeenCalledTimes(1)

    // The saved spec must preserve the product SLAs (they were not stripped).
    const savedContent = mockSaveApproved.mock.calls[0][0].content
    expect(savedContent).toContain("within 1 second")
    expect(savedContent).toContain("within 200ms")
    expect(savedContent).toContain("60 minutes")
    expect(savedContent).toContain("within one request-response cycle")
  })

  it("DOES trigger strip pass on PM-spec with animation-context timing (legitimate visual detail leak)", async () => {
    // The strip pass should still fire when timing IS in animation context —
    // these are legitimate visual details that should not be in a PM spec.
    const SPEC_WITH_ANIMATION_TIMING = `# Onboarding Product Spec

## Acceptance Criteria
- The auth indicator appears with a fade-in animation over 300ms.
- The pulsing glow uses a 2.5 second cycle.
- The login button transitions opacity 25% → 50% on hover.
`
    const STRIPPED_SPEC = `# Onboarding Product Spec

## Acceptance Criteria
- The auth indicator appears.
- The pulsing glow is visible.
- The login button responds to hover.
`
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: SPEC_WITH_ANIMATION_TIMING }] })  // patch
      .mockResolvedValueOnce({ content: [{ type: "text", text: STRIPPED_SPEC }] })                // strip pass

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // Strip pass DID fire — TWO Anthropic calls. Animation timing is correctly
    // detected as visual detail and removed.
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("does NOT trigger strip pass on a spec that mixes product SLAs and behavioral language (no animation context)", async () => {
    // The most realistic case: spec has timing values but ALL are product SLAs,
    // none in animation context. Pre-B22 this would falsely trigger the strip
    // pass on every "X minutes" / "X seconds" pattern.
    const SPEC_PURE_BEHAVIORAL = `# Onboarding Product Spec

## Acceptance Criteria
- New users sign up within 30 seconds of first interaction.
- Returning users see their dashboard within 2 seconds of authentication.
- Idle session times out after 15 minutes; user receives warning 5 minutes before.
- Server-side validation completes in under 500ms per request.
`
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: SPEC_PURE_BEHAVIORAL }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // No strip pass — these are all product SLAs, no animation context.
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const savedContent = mockSaveApproved.mock.calls[0][0].content
    expect(savedContent).toContain("30 seconds")
    expect(savedContent).toContain("2 seconds")
    expect(savedContent).toContain("15 minutes")
    expect(savedContent).toContain("under 500ms")
  })

  it("DOES trigger strip pass on color/opacity/gradient/glow patterns (unconditional visual signals)", async () => {
    // Unambiguous visual patterns must always trigger — the B22 fix only
    // narrows TIMING patterns; color/opacity/gradient/glow/easing remain
    // unconditional.
    const SPEC_WITH_VISUAL = `# Onboarding Product Spec

## Acceptance Criteria
- Background is #0A0E27 with 25% opacity.
- Accent uses a radial gradient from violet to teal.
- Login button has a 4px glow radius.
`
    const STRIPPED_VISUAL = `# Onboarding Product Spec

## Acceptance Criteria
- Background appears.
- Accent is visible.
- Login button is highlighted.
`
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: SPEC_WITH_VISUAL }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: STRIPPED_VISUAL }] })

    await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: RECOMMENDATIONS,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("structural: source contains the B22 narrowed timing patterns (animation/transition/fade/ease/cycle context required)", () => {
    const fs = require("node:fs") as typeof import("node:fs")
    const path = require("node:path") as typeof import("node:path")
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"), "utf8")

    // The buggy pre-B22 broad timing pattern must be GONE.
    const buggyBroadMs = /\\b\\\\d\+\\\\\.\?\\\\d\*\\\\s\*\(ms\|milliseconds\?\)\\\\b\/i,/
    expect(source).not.toMatch(buggyBroadMs)

    // The new narrow patterns must be present (each requires animation-context vocabulary).
    expect(source).toContain("(?:animation|transition|fade|ease)")
    expect(source).toContain("(?:cycle|loop|fade|transition|ease|animation)")

    // The Haiku strip-prompt must explicitly preserve product SLAs.
    expect(source).toContain("PRESERVE — do NOT remove these (they are product-level SLAs, not animation):")
    expect(source).toContain("When in doubt, PRESERVE")
  })
})

// ─── B21 — Inference-style AC-citation BLOCKING in writeback ────────────────
// Catastrophic Step 2a observations #13/#14/#21: PM in escalation-resume cited
// "200ms matches the threshold used in AC 4 and AC 27" — but both ACs actually
// say "within 1 second". The B11 v1 verifier did not catch this (it only looked
// for QUOTED phrases or non-existent AC numbers). B21 extends the verifier to
// detect inference-style citations (numeric value claimed for a cited AC that
// doesn't actually contain that value), wires it into the writer as BLOCKING,
// so the writeback is rejected (returns null) before any spec mutation occurs.

describe("B21 — content verifier BLOCKING in PM spec writeback (regression for Step 2a #13/#14/#21)", () => {
  it("BLOCKS the writeback when PM recommendation contains inference-style AC hallucination — returns null, no Anthropic call, no save", async () => {
    const productSpec = `# Onboarding Product Spec

## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation.
3. The user can log in.
4. The system applies the new policy within 1 second of receipt.
27. A subsequent guarantee fires within 1 second of access-token expiry detection.
`
    const fabricatedRecommendation = `My recommendation: 200ms threshold. This matches the threshold used in AC 4 and AC 27 — both already use this value.`

    mockReadFile.mockResolvedValue(productSpec)

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: fabricatedRecommendation,
      humanConfirmation: HUMAN_CONFIRM,
    })

    // BLOCKING contract: writeback rejected, NO Haiku call, NO save.
    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSaveApproved).not.toHaveBeenCalled()
  })

  it("BLOCKS the writeback when PM recommendation cites a non-existent AC", async () => {
    const productSpec = `## Acceptance Criteria
1. First.
2. Second.
3. Third.
`
    // AC 27 doesn't exist; PM is inventing a citation.
    const recommendation = `Per AC 27 — "should require email verification" — this is the gap I'd close.`

    mockReadFile.mockResolvedValue(productSpec)

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: recommendation,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(result).toBeNull()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSaveApproved).not.toHaveBeenCalled()
  })

  it("DOES NOT BLOCK when the PM recommendation has NO AC citations", async () => {
    // No AC# references at all → verifier finds nothing → writeback proceeds normally.
    mockReadFile.mockResolvedValue(EXISTING_SPEC)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_PATCH }] })

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: "My recommendation: show the in-conversation nudge once per session.",
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(result).not.toBeNull()
    expect(mockCreate).toHaveBeenCalledOnce()
    expect(mockSaveApproved).toHaveBeenCalledOnce()
  })

  it("DOES NOT BLOCK when PM cites an AC and the inference timing is consistent with the AC body", async () => {
    const productSpec = `# Onboarding Product Spec

## Acceptance Criteria
1. The system applies the new policy within 200ms of receipt.
`
    // PM cites the right value for the right AC.
    const consistentRecommendation = `My recommendation: 200ms is consistent with AC 1 which already uses this value.`

    mockReadFile.mockResolvedValue(productSpec)
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_PATCH }] })

    const result = await patchProductSpecWithRecommendations({
      featureName: "onboarding",
      question: BLOCKING_QUESTION,
      recommendations: consistentRecommendation,
      humanConfirmation: HUMAN_CONFIRM,
    })

    expect(result).not.toBeNull()
    expect(mockCreate).toHaveBeenCalledOnce()
  })
})
