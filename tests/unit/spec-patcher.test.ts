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

  it("subsection-level merge — patch of one ### preserves sibling ### sections", () => {
    const existing = `# Feature — Design Spec

## Screens
### Screen 1
Original Screen 1 content.

### Screen 2
Screen 2 content.

### Screen 3
Screen 3 content.`

    const patch = `## Screens
### Screen 1
updated content for screen 1`

    const result = applySpecPatch(existing, patch)
    // Patched subsection is updated
    expect(result).toContain("### Screen 1\nupdated content for screen 1")
    // Sibling subsections are preserved — this was the bug
    expect(result).toContain("Screen 2 content.")
    expect(result).toContain("Screen 3 content.")
  })

  it("subsection-level merge — new ### subsection is appended, existing preserved", () => {
    const existing = `# Feature — Design Spec

## Screens
### Screen 1
Existing screen 1 content.`

    const patch = `## Screens
### Screen 2
New screen 2 content.`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("Existing screen 1 content.")
    expect(result).toContain("New screen 2 content.")
  })

  it("flat ## section with no ### subsections still replaces wholesale", () => {
    const existing = `# Feature — Design Spec

## Screens
flat content, no subsections`

    const patch = `## Screens
updated flat content`

    const result = applySpecPatch(existing, patch)
    expect(result).toContain("updated flat content")
    expect(result).not.toContain("flat content, no subsections")
  })
})
