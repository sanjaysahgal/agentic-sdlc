import { describe, it, expect } from "vitest"
import { extractBlockingQuestions } from "../../runtime/spec-utils"

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

