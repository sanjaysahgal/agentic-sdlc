import { describe, it, expect } from "vitest"
import {
  groupFindingsByCategory,
  buildCategorizedEscalationBrief,
  checkUpstreamReadiness,
  verifyEscalationResolution,
} from "../../runtime/escalation-orchestrator"
import type { DeterministicFinding } from "../../runtime/deterministic-auditor"

// ────────────────────────────────────────────────────────────────────────────────
// groupFindingsByCategory
// ────────────────────────────────────────────────────────────────────────────────

describe("groupFindingsByCategory", () => {
  it("groups findings by criterion", () => {
    const findings: DeterministicFinding[] = [
      { criterion: "VAGUE_TIMING", issue: "AC#4 uses immediately", recommendation: "use 200ms" },
      { criterion: "VAGUE_TIMING", issue: "AC#13 uses immediately", recommendation: "use 500ms" },
      { criterion: "VAGUE_LANGUAGE", issue: "AC#8 uses clear", recommendation: "define behavior" },
    ]
    const categories = groupFindingsByCategory(findings)
    expect(categories).toHaveLength(2)
    expect(categories[0].criterion).toBe("VAGUE_TIMING")
    expect(categories[0].count).toBe(2)
    expect(categories[1].criterion).toBe("VAGUE_LANGUAGE")
    expect(categories[1].count).toBe(1)
  })

  it("sorts categories by count descending", () => {
    const findings: DeterministicFinding[] = [
      { criterion: "A", issue: "a1", recommendation: "" },
      { criterion: "B", issue: "b1", recommendation: "" },
      { criterion: "B", issue: "b2", recommendation: "" },
      { criterion: "B", issue: "b3", recommendation: "" },
    ]
    const categories = groupFindingsByCategory(findings)
    expect(categories[0].criterion).toBe("B")
    expect(categories[0].count).toBe(3)
    expect(categories[1].criterion).toBe("A")
  })

  it("shows all items as examples when <5 in category", () => {
    const findings: DeterministicFinding[] = [
      { criterion: "X", issue: "x1", recommendation: "" },
      { criterion: "X", issue: "x2", recommendation: "" },
      { criterion: "X", issue: "x3", recommendation: "" },
    ]
    const categories = groupFindingsByCategory(findings)
    expect(categories[0].examples).toHaveLength(3)
    expect(categories[0].allIssues).toHaveLength(3)
  })

  it("shows first 3 as examples when ≥5 in category", () => {
    const findings: DeterministicFinding[] = Array.from({ length: 7 }, (_, i) => ({
      criterion: "FORM_FACTOR",
      issue: `Screen ${i} missing mobile`,
      recommendation: "add mobile layout",
    }))
    const categories = groupFindingsByCategory(findings)
    expect(categories[0].examples).toHaveLength(3)
    expect(categories[0].allIssues).toHaveLength(7)
    expect(categories[0].count).toBe(7)
  })

  it("returns empty array for no findings", () => {
    expect(groupFindingsByCategory([])).toEqual([])
  })

  it("is deterministic — same input, same output", () => {
    const findings: DeterministicFinding[] = [
      { criterion: "A", issue: "a1", recommendation: "" },
      { criterion: "B", issue: "b1", recommendation: "" },
    ]
    const r1 = JSON.stringify(groupFindingsByCategory(findings))
    const r2 = JSON.stringify(groupFindingsByCategory(findings))
    expect(r1).toBe(r2)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// buildCategorizedEscalationBrief
// ────────────────────────────────────────────────────────────────────────────────

describe("buildCategorizedEscalationBrief", () => {
  const categories = [
    { criterion: "VAGUE_TIMING", count: 4, examples: ["AC#4 immediately", "AC#13 immediately", "AC#21 immediately"], allIssues: ["a", "b", "c", "d"] },
    { criterion: "VAGUE_LANGUAGE", count: 2, examples: ["AC#8 clear", "AC#15 clear"], allIssues: ["e", "f"] },
  ]

  it("includes total finding count and category count", () => {
    const brief = buildCategorizedEscalationBrief(categories, "pm", "architect")
    expect(brief).toContain("6 deterministic findings")
    expect(brief).toContain("2 categories")
  })

  it("includes target agent label", () => {
    const brief = buildCategorizedEscalationBrief(categories, "pm", "architect")
    expect(brief).toContain("PRODUCT MANAGER")
  })

  it("includes requesting agent context", () => {
    const brief = buildCategorizedEscalationBrief(categories, "pm", "architect")
    expect(brief).toContain("engineering")
  })

  it("includes category names with counts", () => {
    const brief = buildCategorizedEscalationBrief(categories, "pm", "ux-design")
    expect(brief).toContain("VAGUE_TIMING")
    expect(brief).toContain("4 findings")
    expect(brief).toContain("VAGUE_LANGUAGE")
    expect(brief).toContain("2 findings")
  })

  it("shows '(N more similar findings)' when examples are truncated", () => {
    const brief = buildCategorizedEscalationBrief(categories, "pm", "architect")
    expect(brief).toContain("1 more similar finding")
  })

  it("instructs agent to resolve at category level", () => {
    const brief = buildCategorizedEscalationBrief(categories, "pm", "architect")
    expect(brief).toContain("category level")
    expect(brief).toContain("My recommendation")
  })

  it("uses design labels for design target", () => {
    const brief = buildCategorizedEscalationBrief(categories, "design", "architect")
    expect(brief).toContain("UX DESIGNER")
    expect(brief).toContain("design spec")
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// checkUpstreamReadiness
// ────────────────────────────────────────────────────────────────────────────────

describe("checkUpstreamReadiness", () => {
  const cleanPmSpec = "## Acceptance Criteria\n- AC#1: User sees a 10-second countdown timer\n## Non-Goals\n- Desktop app is out of scope for v1\n## Open Questions\n(none)"
  const dirtyPmSpec = "## Acceptance Criteria\n- AC#1: The transition should be smooth and seamless\n## Non-Goals\n(none)"
  const cleanDesignSpec = "## Screens\n### Welcome\nLayout defined\n## Open Questions\n(none)"

  it("design agent: returns ready when PM spec is clean", () => {
    const result = checkUpstreamReadiness("ux-design", { pmSpec: cleanPmSpec })
    expect(result.ready).toBe(true)
    expect(result.blockingSpec).toBeNull()
    expect(result.escalationBrief).toBeNull()
  })

  it("design agent: returns not ready with brief when PM spec has findings", () => {
    const result = checkUpstreamReadiness("ux-design", { pmSpec: dirtyPmSpec })
    expect(result.ready).toBe(false)
    expect(result.blockingSpec).toBe("pm")
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.escalationBrief).toContain("PRODUCT MANAGER")
  })

  it("design agent: returns ready when no PM spec available", () => {
    const result = checkUpstreamReadiness("ux-design", {})
    expect(result.ready).toBe(true)
  })

  it("architect: checks PM first — returns PM findings even if design also has findings", () => {
    const result = checkUpstreamReadiness("architect", { pmSpec: dirtyPmSpec, designSpec: "## Screens\nTBD" })
    expect(result.ready).toBe(false)
    expect(result.blockingSpec).toBe("pm")
    // Design findings are NOT included — PM-first ordering
    expect(result.escalationBrief).toContain("PRODUCT MANAGER")
    expect(result.escalationBrief).not.toContain("UX DESIGNER")
  })

  it("architect: checks design only after PM is clean", () => {
    const dirtyDesignSpec = "## Screens\n### Welcome\nTODO: define layout\n## Open Questions\n- What about mobile?"
    const result = checkUpstreamReadiness("architect", { pmSpec: cleanPmSpec, designSpec: dirtyDesignSpec })
    expect(result.ready).toBe(false)
    expect(result.blockingSpec).toBe("design")
    expect(result.escalationBrief).toContain("UX DESIGNER")
  })

  it("architect: returns ready when both specs clean", () => {
    const result = checkUpstreamReadiness("architect", { pmSpec: cleanPmSpec, designSpec: cleanDesignSpec })
    expect(result.ready).toBe(true)
  })

  it("is deterministic — same specs always produce same result", () => {
    const r1 = JSON.stringify(checkUpstreamReadiness("architect", { pmSpec: dirtyPmSpec }))
    const r2 = JSON.stringify(checkUpstreamReadiness("architect", { pmSpec: dirtyPmSpec }))
    expect(r1).toBe(r2)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// verifyEscalationResolution
// ────────────────────────────────────────────────────────────────────────────────

describe("verifyEscalationResolution", () => {
  const cleanPmSpec = "## Acceptance Criteria\n- AC#1: User sees a 10-second countdown timer\n## Non-Goals\n- Desktop app out of scope\n## Open Questions\n(none)"
  const stillDirtyPmSpec = "## Acceptance Criteria\n- AC#1: User sees a smooth transition\n## Non-Goals\n(none)"

  it("returns ready when spec is clean after patch", () => {
    const result = verifyEscalationResolution("pm", cleanPmSpec, "ux-design")
    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("returns not ready with new brief when findings remain", () => {
    const result = verifyEscalationResolution("pm", stillDirtyPmSpec, "ux-design")
    expect(result.ready).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.escalationBrief).toContain("PRODUCT MANAGER")
  })

  it("is deterministic", () => {
    const r1 = JSON.stringify(verifyEscalationResolution("pm", stillDirtyPmSpec, "architect"))
    const r2 = JSON.stringify(verifyEscalationResolution("pm", stillDirtyPmSpec, "architect"))
    expect(r1).toBe(r2)
  })
})
