import { describe, it, expect } from "vitest"
import { applySpecPatch } from "../../runtime/spec-patcher"

describe("applySpecPatch", () => {
  it("returns patch as-is when existing is empty", () => {
    const patch = "## Design Direction\ndark mode"
    expect(applySpecPatch("", patch)).toBe(patch.trim())
  })

  it("returns patch as-is when existing is whitespace only", () => {
    const patch = "## Design Direction\ndark mode"
    expect(applySpecPatch("   \n  ", patch)).toBe(patch.trim())
  })

  it("replaces a matching section in the existing spec", () => {
    const existing = `# Onboarding — Design Spec

## Design Direction
light mode

## Screens
Screen 1 content`

    const patch = `## Design Direction
dark mode`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("dark mode")
    expect(result).not.toContain("light mode")
    expect(result).toContain("Screen 1 content")
  })

  it("preserves sections not mentioned in the patch", () => {
    const existing = `# Feature — Design Spec

## Design Direction
light mode

## Screens
Screen 1.

## Open Questions
- [type: product] [blocking: no] Question here.`

    const patch = `## Design Direction
dark mode`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("dark mode")
    expect(result).toContain("Screen 1.")
    expect(result).toContain("Open Questions")
    expect(result).toContain("Question here.")
  })

  it("appends new sections not in the existing spec", () => {
    const existing = `# Feature — Design Spec

## Design Direction
light mode`

    const patch = `## Design Direction
dark mode

## Design System Updates
New component: DarkCard`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("dark mode")
    expect(result).toContain("Design System Updates")
    expect(result).toContain("New component: DarkCard")
    // Design Direction must appear before Design System Updates
    expect(result.indexOf("Design Direction")).toBeLessThan(result.indexOf("Design System Updates"))
  })

  it("preserves preamble (# heading, metadata lines before first ##)", () => {
    const existing = `# Onboarding — Design Spec

## Figma
Old figma link`

    const patch = `## Figma
New figma link`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("# Onboarding — Design Spec")
    expect(result).toContain("New figma link")
    expect(result).not.toContain("Old figma link")
  })

  it("handles patch with only one section", () => {
    const existing = `# Feature — Design Spec

## Design Direction
original direction

## Screens
Screen A.

## Accessibility
WCAG AA.

## Open Questions
None.`

    const patch = `## Screens
Updated screen content.`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("original direction")
    expect(result).toContain("Updated screen content.")
    expect(result).not.toContain("Screen A.")
    expect(result).toContain("WCAG AA.")
    expect(result).toContain("Open Questions")
  })

  it("handles subsections (### headings) correctly — treats ## section as atomic unit", () => {
    const existing = `# Feature — Design Spec

## Screens
### Screen 1
Original Screen 1 content.

### Screen 2
Screen 2 content.`

    const patch = `## Screens
### Screen 1
updated`

    const result = applySpecPatch(existing, patch)
    // The entire ## Screens section is replaced with the patch version
    expect(result).toContain("### Screen 1\nupdated")
    // Screen 2 is gone because the patch replaced the entire ## Screens section
    expect(result).not.toContain("Screen 2 content.")
  })
})
