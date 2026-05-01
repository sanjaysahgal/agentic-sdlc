import { describe, it, expect } from "vitest"

// Regression test for B8 (spec write ownership — Principle 16).
//
// Bug surfaced 2026-04-30 driving onboarding: the architect's upstream-revision-reply
// branch in interfaces/slack/handlers/message.ts called BOTH:
//   1. patchProductSpecWithRecommendations (correct — PM-authored content → product spec)
//   2. patchEngineeringSpecWithDecision    (wrong — PM-authored content → architect's
//      engineering spec under a `### Architect Decision (pre-engineering)` heading)
//
// The wrong call recorded PM's product-spec resolutions in the engineering spec, with
// engineering-spec-decision-writer.ts:38-41 using append-only layout — so every
// architect→PM round of an N-gap onboarding produced N duplicate-heading
// `### Architect Decision (pre-engineering)` blocks. Two sources of truth (Principle 1
// violation), recorded as architect decisions when they were PM decisions, growing
// unboundedly with each escalation.
//
// Fix: codified Principle 16 (Spec write ownership) in CLAUDE.md, removed the
// engineering-spec writeback from the architect's upstream-revision-reply branch,
// added structural invariant tests/invariants/spec-write-ownership.test.ts that
// AST-greps every writeback callsite and pins it to an allow-list. The architect
// re-reads the upstream spec on every run via loadArchitectAgentContext, so no
// information is lost.

describe("bug #14 — architect's upstream-revision-reply branch wrote PM/designer-authored content to engineering spec (manifest B8)", () => {
  it("structural assertion: arch-upstream-revision-reply branch in message.ts does not call patchEngineeringSpecWithDecision", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    const branchMarker = "branch=arch-upstream-revision-reply"
    const markerIdx = source.indexOf(branchMarker)
    expect(markerIdx, `expected the [ROUTER] log marker '${branchMarker}' to be present in message.ts`).toBeGreaterThan(-1)

    // Bound the branch body to ~3000 chars after the marker — generously covers
    // the writeback block (300 lines worth) but doesn't bleed into unrelated branches.
    const branchBody = source.slice(markerIdx, markerIdx + 3000)

    expect(
      branchBody,
      "[B8] arch-upstream-revision-reply must NOT call patchEngineeringSpecWithDecision — that was the violation. PM/designer-authored content lands in their own spec only; architect re-reads from upstream.",
    ).not.toMatch(/patchEngineeringSpecWithDecision\s*\(/)
  })

  it("structural assertion: patchEngineeringSpecWithDecision is called exactly ONCE in message.ts (the legitimate Path A — designer→architect escalation reply)", async () => {
    // The single allowed call records ARCHITECT-authored content (the architect resolved
    // a designer's offer_architect_escalation question) into the architect's own
    // engineering spec — owner-consistent per Principle 16.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )
    const matches = source.match(/patchEngineeringSpecWithDecision\s*\(/g) ?? []
    expect(matches.length).toBe(1)
  })

  it("structural assertion: CLAUDE.md Principle 16 is documented as the canonical rule", async () => {
    // Pin the principle's existence so it can't be silently removed without
    // also retiring the structural invariant test.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const claudeMd = fs.readFileSync(path.resolve(__dirname, "..", "..", "CLAUDE.md"), "utf8")
    expect(claudeMd).toMatch(/### 16\.\s+Spec write ownership/)
    expect(claudeMd).toMatch(/resolved decisions .* land only in (?:that|the owner's) spec/i)
  })

  it("structural assertion: the spec-write-ownership invariant test exists and references B8 by name", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const invariant = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "tests/invariants/spec-write-ownership.test.ts"),
      "utf8",
    )
    expect(invariant).toMatch(/B8/)
    expect(invariant).toMatch(/patchEngineeringSpecWithDecision/)
  })
})
