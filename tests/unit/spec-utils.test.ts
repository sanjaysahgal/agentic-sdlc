import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { extractBlockingQuestions, extractHandoffSection, extractDesignAssumptions, extractAllOpenQuestions } from "../../runtime/spec-utils"

describe("extractBlockingQuestions", () => {
  it("returns empty array when no blocking questions exist", () => {
    const spec = "## Open Questions\n- [type: engineering] [blocking: no] How does glow work?"
    expect(extractBlockingQuestions(spec)).toEqual([])
  })

  it("extracts a single blocking question", () => {
    const spec = "## Open Questions\n- [type: product] [blocking: yes] What is the session TTL?"
    expect(extractBlockingQuestions(spec)).toEqual(["[type: product] [blocking: yes] What is the session TTL?"])
  })

  it("extracts multiple blocking questions and ignores non-blocking ones", () => {
    const spec = [
      "## Open Questions",
      "- [type: product] [blocking: yes] What is the session TTL?",
      "- [type: engineering] [blocking: no] Glow: CSS vs canvas?",
      "- [type: design] [blocking: yes] Which nav pattern to use?",
    ].join("\n")
    const result = extractBlockingQuestions(spec)
    expect(result).toHaveLength(2)
    expect(result[0]).toContain("session TTL")
    expect(result[1]).toContain("nav pattern")
  })

  it("strips leading list markers from extracted questions", () => {
    const spec = "- [type: product] [blocking: yes] What is the TTL?"
    const result = extractBlockingQuestions(spec)
    expect(result[0]).not.toMatch(/^[-*]\s/)
  })

  it("returns empty array for spec with no open questions section", () => {
    expect(extractBlockingQuestions("## Screens\n### Screen 1\nPurpose: landing")).toEqual([])
  })
})

describe("extractHandoffSection", () => {
  it("returns trimmed body for a named section", () => {
    const spec = "## Design Notes\n\nThe empty state must feel encouraging.\n\n## Next Section\nfoo"
    expect(extractHandoffSection(spec, "## Design Notes")).toBe("The empty state must feel encouraging.")
  })

  it("returns empty string when section is absent", () => {
    expect(extractHandoffSection("## Screens\nsome content", "## Design Notes")).toBe("")
  })

  it("handles EOF boundary (no trailing ## heading)", () => {
    const spec = "## Design Notes\n\nOnly item here."
    expect(extractHandoffSection(spec, "## Design Notes")).toBe("Only item here.")
  })

  it("does not bleed into adjacent sections", () => {
    const spec = [
      "## Open Questions",
      "- [type: design] [blocking: yes] Which nav?",
      "",
      "## Design Notes",
      "Use encouragement tone.",
      "",
      "## Screens",
      "Screen 1",
    ].join("\n")
    expect(extractHandoffSection(spec, "## Design Notes")).toBe("Use encouragement tone.")
    expect(extractHandoffSection(spec, "## Open Questions")).not.toContain("Design Notes")
  })
})

describe("extractDesignAssumptions", () => {
  it("returns the body of ## Design Assumptions", () => {
    const spec = "## Design Assumptions\n\n- Session timeout is 30 minutes.\n\n## Next\nfoo"
    expect(extractDesignAssumptions(spec)).toContain("Session timeout")
  })

  it("returns empty string when ## Design Assumptions is absent", () => {
    expect(extractDesignAssumptions("## Screens\nfoo")).toBe("")
  })
})

describe("extractAllOpenQuestions", () => {
  // Fixture loaded from real agent output format — section-scoped, both blocking types
  const fixture = readFileSync(
    join(__dirname, "../fixtures/agent-output/design-spec-open-questions.md"),
    "utf-8",
  )

  it("returns both [blocking: yes] and [blocking: no] lines from ## Open Questions", () => {
    const result = extractAllOpenQuestions(fixture)
    expect(result.length).toBe(2)
    expect(result.some(q => q.includes("[blocking: yes]"))).toBe(true)
    expect(result.some(q => q.includes("[blocking: no]"))).toBe(true)
  })

  it("is section-scoped — does not return [blocking:] text from other sections", () => {
    const result = extractAllOpenQuestions(fixture)
    // The fixture has a [blocking: yes] mention inside ## Design Assumptions — must not appear
    result.forEach(q => {
      expect(q).toContain("[type: design]")
    })
  })

  it("returns empty array when ## Open Questions section has no [blocking:] lines", () => {
    const spec = "## Open Questions\n\nNo questions right now.\n\n## Screens\nfoo"
    expect(extractAllOpenQuestions(spec)).toEqual([])
  })

  it("returns empty array when ## Open Questions section is absent", () => {
    expect(extractAllOpenQuestions("## Screens\nfoo bar")).toEqual([])
  })

  it("strips leading list markers from returned lines", () => {
    const result = extractAllOpenQuestions(fixture)
    result.forEach(q => {
      expect(q).not.toMatch(/^[-*]\s/)
    })
  })
})

