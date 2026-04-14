import { describe, it, expect } from "vitest"
import { sanitizePmSpecDraft } from "../../runtime/pm-spec-sanitizer"

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CLEAN_SPEC = `# Onboarding Product Spec

## Problem
Users cannot start using the product without creating an account.

## Acceptance Criteria
- User can register with email and password.
- User can sign in via SSO.

## Edge Cases
- Network failure during registration shows a generic error.

## Open Questions
- [type: product] [blocking: yes] What is the recovery path when SSO fails for a returning user?
`

const SPEC_WITH_DESIGN_DIRECTION = `# Onboarding Product Spec

## Problem
Users cannot start using the product without creating an account.

## Acceptance Criteria
- User can register with email and password.

## Design Direction
**Dark mode primary.** Visual language: minimal, high negative space.

**Color palette:**
- Background: \`#0A0E27\`
- Accent gradient: 135° from \`#8B7FE8\` to \`#4FADA8\`

**Signature treatment: Pulsing glow effect**
- Opacity cycle: 25% → 35% → 25% over 2.5 seconds, ease-in-out cubic bezier

## Edge Cases
- Network failure shows a generic error.
`

const SPEC_WITH_COLOR_PALETTE = `# Spec

## Acceptance Criteria
- User can register.

## Color Palette
- Primary: #0A0E27
- Secondary: rgba(245, 245, 245, 0.6)

## Edge Cases
- Network failure shows error.
`

const SPEC_WITH_CROSS_DOMAIN_QUESTIONS = `# Onboarding Product Spec

## Acceptance Criteria
- User can register.

## Open Questions
- [type: product] [blocking: yes] What happens when SSO fails?
- [type: engineering] [blocking: no] Session TTL is provisionally 60 minutes — needs infrastructure confirmation.
- [type: design] [blocking: no] Should the logged-out indicator use a glow or a badge?
- [type: product] [blocking: no] Should free tier users see the upgrade prompt on every session?
`

// ─── stripDesignScopeSections ────────────────────────────────────────────────

describe("sanitizePmSpecDraft — design-scope section stripping", () => {
  it("returns spec unchanged when no design-scope sections are present", () => {
    const result = sanitizePmSpecDraft(CLEAN_SPEC)
    expect(result.wasModified).toBe(false)
    expect(result.strippedSections).toHaveLength(0)
    expect(result.content).toBe(CLEAN_SPEC.trimEnd())
  })

  it("strips ## Design Direction section entirely", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_DESIGN_DIRECTION)
    expect(result.wasModified).toBe(true)
    expect(result.strippedSections).toContain("Design Direction")
    expect(result.content).not.toContain("## Design Direction")
    expect(result.content).not.toContain("#0A0E27")
    expect(result.content).not.toContain("cubic bezier")
  })

  it("preserves Acceptance Criteria and Edge Cases after stripping Design Direction", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_DESIGN_DIRECTION)
    expect(result.content).toContain("## Acceptance Criteria")
    expect(result.content).toContain("User can register with email and password")
    expect(result.content).toContain("## Edge Cases")
    expect(result.content).toContain("Network failure shows a generic error")
  })

  it("strips ## Color Palette section", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_COLOR_PALETTE)
    expect(result.wasModified).toBe(true)
    expect(result.strippedSections).toContain("Color Palette")
    expect(result.content).not.toContain("## Color Palette")
    expect(result.content).not.toContain("#0A0E27")
  })

  it("strips ## Animation section", () => {
    const spec = `## Acceptance Criteria\n- User can register.\n\n## Animation\n- Heartbeat pulse 2.5s\n\n## Edge Cases\n- Network error.`
    const result = sanitizePmSpecDraft(spec)
    expect(result.wasModified).toBe(true)
    expect(result.strippedSections).toContain("Animation")
    expect(result.content).not.toContain("## Animation")
    expect(result.content).not.toContain("Heartbeat pulse")
  })

  it("strips ## Visual section (and variations like ## Visual Design, ## Visual Language)", () => {
    const spec = `## Acceptance Criteria\n- User can register.\n\n## Visual Design\n- Minimal, high negative space.\n\n## Edge Cases\n- Network error.`
    const result = sanitizePmSpecDraft(spec)
    expect(result.wasModified).toBe(true)
    expect(result.content).not.toContain("## Visual Design")
    expect(result.content).not.toContain("Minimal, high negative space")
  })

  it("strips ## Typography section", () => {
    const spec = `## Acceptance Criteria\n- User can register.\n\n## Typography\n- Inter 16px body\n\n## Edge Cases\n- Error.`
    const result = sanitizePmSpecDraft(spec)
    expect(result.wasModified).toBe(true)
    expect(result.content).not.toContain("## Typography")
  })

  it("does NOT strip ## Open Questions, ## Problem, ## Acceptance Criteria, or ## Edge Cases", () => {
    const result = sanitizePmSpecDraft(CLEAN_SPEC)
    expect(result.content).toContain("## Problem")
    expect(result.content).toContain("## Acceptance Criteria")
    expect(result.content).toContain("## Edge Cases")
    expect(result.content).toContain("## Open Questions")
  })

  it("collapses multiple consecutive blank lines left by section removal", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_DESIGN_DIRECTION)
    expect(result.content).not.toMatch(/\n{3,}/)
  })
})

// ─── stripCrossDomainOpenQuestions ───────────────────────────────────────────

describe("sanitizePmSpecDraft — cross-domain open question stripping", () => {
  it("removes [type: engineering] lines from ## Open Questions", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_CROSS_DOMAIN_QUESTIONS)
    expect(result.wasModified).toBe(true)
    expect(result.strippedOpenQuestions.length).toBeGreaterThan(0)
    expect(result.content).not.toContain("[type: engineering]")
    expect(result.content).not.toContain("Session TTL is provisionally")
  })

  it("removes [type: design] lines from ## Open Questions", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_CROSS_DOMAIN_QUESTIONS)
    expect(result.content).not.toContain("[type: design]")
    expect(result.content).not.toContain("glow or a badge")
  })

  it("preserves [type: product] lines in ## Open Questions", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_CROSS_DOMAIN_QUESTIONS)
    expect(result.content).toContain("[type: product]")
    expect(result.content).toContain("What happens when SSO fails?")
    expect(result.content).toContain("Should free tier users see the upgrade prompt")
  })

  it("reports stripped question count correctly", () => {
    const result = sanitizePmSpecDraft(SPEC_WITH_CROSS_DOMAIN_QUESTIONS)
    // 1 engineering + 1 design = 2 stripped
    expect(result.strippedOpenQuestions).toHaveLength(2)
  })

  it("returns wasModified=false for spec with only [type: product] questions", () => {
    const result = sanitizePmSpecDraft(CLEAN_SPEC)
    expect(result.wasModified).toBe(false)
    expect(result.strippedOpenQuestions).toHaveLength(0)
  })
})

// ─── Combined ────────────────────────────────────────────────────────────────

describe("sanitizePmSpecDraft — combined stripping", () => {
  it("strips both design section AND cross-domain questions in one pass", () => {
    const combined = SPEC_WITH_DESIGN_DIRECTION.replace(
      "## Edge Cases\n- Network failure shows a generic error.",
      `## Edge Cases\n- Network failure shows a generic error.\n\n## Open Questions\n- [type: product] [blocking: yes] What is the retry path?\n- [type: engineering] [blocking: no] Infra TTL confirmation needed.`
    )
    const result = sanitizePmSpecDraft(combined)
    expect(result.wasModified).toBe(true)
    expect(result.strippedSections).toContain("Design Direction")
    expect(result.strippedOpenQuestions).toHaveLength(1)
    expect(result.content).not.toContain("## Design Direction")
    expect(result.content).not.toContain("[type: engineering]")
    expect(result.content).toContain("[type: product]")
    expect(result.content).toContain("## Acceptance Criteria")
  })
})
