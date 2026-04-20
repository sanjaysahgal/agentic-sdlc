import { describe, it, expect } from "vitest"
import { splitQualityIssue, buildActionMenu, parseFixAllIntent, clearPhaseAuditCaches } from "../../interfaces/slack/handlers/message"
import type { ActionItem } from "../../interfaces/slack/handlers/message"

// ────────────────────────────────────────────────────────────────────────────────
// splitQualityIssue
// ────────────────────────────────────────────────────────────────────────────────
describe("splitQualityIssue", () => {
  it("splits on ' — ' separator", () => {
    const result = splitQualityIssue("Screen 1b max-width undefined — Set max-width to 672px")
    expect(result).toEqual({ issue: "Screen 1b max-width undefined", fix: "Set max-width to 672px" })
  })

  it("returns full string as issue when no separator", () => {
    const result = splitQualityIssue("Missing fade-edge gradient")
    expect(result).toEqual({ issue: "Missing fade-edge gradient", fix: "fix before approval" })
  })

  it("handles multiple ' — ' separators — splits on first", () => {
    const result = splitQualityIssue("A — B — C")
    expect(result).toEqual({ issue: "A", fix: "B — C" })
  })

  it("handles empty string", () => {
    const result = splitQualityIssue("")
    expect(result).toEqual({ issue: "", fix: "fix before approval" })
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// buildActionMenu
// ────────────────────────────────────────────────────────────────────────────────
describe("buildActionMenu", () => {
  it("returns empty string when all categories are empty", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [] },
      { emoji: ":pencil:", label: "Design Issues", issues: [] },
    ])
    expect(result).toBe("")
  })

  it("builds numbered items across categories", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [
        { issue: "--bg: spec `#0A0E27`", fix: "change to `#0A0A0F`" },
      ] },
      { emoji: ":pencil:", label: "Design Issues", issues: [
        { issue: "Screen 1b duplicate", fix: "Remove duplicate" },
        { issue: "24px vs 16px gap", fix: "Use 16px" },
      ] },
    ])
    expect(result).toContain("1. --bg: spec `#0A0E27`")
    expect(result).toContain("2. Screen 1b duplicate")
    expect(result).toContain("3. 24px vs 16px gap")
    expect(result).toContain("OPEN ITEMS")
    expect(result).toContain("fix all")
  })

  it("skips empty categories", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [] },
      { emoji: ":pencil:", label: "Design Issues", issues: [
        { issue: "Gap", fix: "Fix" },
      ] },
    ])
    expect(result).not.toContain("Brand Drift")
    expect(result).toContain("Design Issues (1)")
  })

  it("shows category count in parentheses", () => {
    const result = buildActionMenu([
      { emoji: ":pencil:", label: "Design Issues", issues: [
        { issue: "A", fix: "B" },
        { issue: "C", fix: "D" },
        { issue: "E", fix: "F" },
      ] },
    ])
    expect(result).toContain("Design Issues (3)")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// parseFixAllIntent — additional edge cases beyond action-menu.test.ts
// ────────────────────────────────────────────────────────────────────────────────
describe("parseFixAllIntent — edge cases", () => {
  it("rejects empty string", () => {
    expect(parseFixAllIntent("")).toEqual({ isFixAll: false, selectedIndices: null })
  })

  it("rejects unrelated message containing 'fix'", () => {
    expect(parseFixAllIntent("can you fix the color?")).toEqual({ isFixAll: false, selectedIndices: null })
  })

  it("handles 'fix all' with trailing whitespace", () => {
    const result = parseFixAllIntent("fix all  ")
    expect(result.isFixAll).toBe(true)
    expect(result.selectedIndices).toBeNull()
  })

  it("handles hyphen ranges — fix 1-5", () => {
    const result = parseFixAllIntent("fix 1-5")
    expect(result.isFixAll).toBe(true)
    expect(result.selectedIndices).toEqual([1, 2, 3, 4, 5])
  })

  it("handles mixed ranges and individual — fix 1-3, 5, 7-9", () => {
    const result = parseFixAllIntent("fix 1-3, 5, 7-9")
    expect(result.isFixAll).toBe(true)
    expect(result.selectedIndices).toEqual([1, 2, 3, 5, 7, 8, 9])
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// clearPhaseAuditCaches
// ────────────────────────────────────────────────────────────────────────────────
describe("clearPhaseAuditCaches", () => {
  it("does not throw when called (caches may be empty)", () => {
    expect(() => clearPhaseAuditCaches()).not.toThrow()
  })
})
