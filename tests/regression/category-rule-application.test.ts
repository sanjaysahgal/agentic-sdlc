import { describe, it, expect } from "vitest"
import {
  extractCategoryRules,
  applyCategoryRules,
  findResidualCategoryViolations,
} from "../../runtime/category-rule-extractor"

// Regression test for B9 (patcher non-deterministic on category rules).
//
// Bug surfaced 2026-04-30 driving onboarding step 6: PM in escalation-resume
// mode wrote a universal substitution directive — `any "immediately" becomes
// "within 1 second"` — expecting find-and-replace across the whole spec.
// Haiku's spec patcher applied it inconsistently: replaced 2 of 4 instances,
// left 2 untouched. Deterministic auditPmSpec caught the misses on the next
// design run and triggered a re-escalation, but each miss = an extra round
// trip — N round-trips for what should be one.
//
// Fix: deterministic category-rule extractor (runtime/category-rule-extractor.ts)
// pulls the substitution out of Haiku's hands. Parses universal-quantified
// patterns from the recommendation text (any/all/every X becomes Y;
// replace/change all X with Y), applies them via word-boundary string
// replace BEFORE handing the spec to Haiku. Post-Haiku verification: if
// Haiku re-introduced a from-word during merge, apply the rules again as
// a final safety net so the deterministic invariant holds regardless of
// LLM judgment.

describe("bug #16 — patcher non-deterministic on PM category rules (manifest B9)", () => {
  it("canonical Bug-E scenario: PM rule `any 'immediately' becomes 'within 1 second'` substitutes ALL 4 instances deterministically", () => {
    const dirtyPmSpec = `# Onboarding Product Spec

## Acceptance Criteria
1. AC#1: User receives confirmation immediately after sign-up.
2. AC#2: AI responds immediately when prompted.
3. AC#3: Errors surface immediately on form submission.
4. AC#4: Messages persist across sessions.
5. AC#5: Logout completes immediately.

## Open Questions
(none)
`

    const pmRecs = `My recommendation: any "immediately" becomes "within 1 second" — that's the platform SLA we should adopt across all sign-up, response, error, and logout flows.`

    // Step 1 — extract the rule from PM prose (deterministic).
    const rules = extractCategoryRules(pmRecs)
    expect(rules).toEqual([{ from: "immediately", to: "within 1 second" }])

    // Step 2 — apply to the spec deterministically. ALL 4 instances replaced
    // (regardless of what Haiku would have done).
    const patched = applyCategoryRules(dirtyPmSpec, rules)
    expect((patched.match(/within 1 second/g) ?? []).length).toBe(4)
    expect(patched).not.toMatch(/\bimmediately\b/i)

    // Step 3 — post-Haiku residual check. Spec is clean (no "immediately"
    // survives), so no residual rules.
    const residuals = findResidualCategoryViolations(patched, rules)
    expect(residuals).toEqual([])
  })

  it("multi-rule scenario: PM gives 3 category rules in one message — all applied together", () => {
    const dirtyPmSpec = `## Acceptance Criteria
1. AC#1: Smooth animation on sign-up.
2. AC#2: Quickly process the form.
3. AC#3: Immediately confirm to the user.
4. AC#4: Smooth transition to dashboard.`

    const pmRecs = `My recommendations:
1. Any "smooth" becomes "with 16ms frame budget"
2. Any "quickly" becomes "within 2 seconds"
3. Any "immediately" becomes "within 1 second"`

    const rules = extractCategoryRules(pmRecs)
    expect(rules).toHaveLength(3)

    const patched = applyCategoryRules(dirtyPmSpec, rules)
    expect(patched).not.toMatch(/\bsmooth\b/i)
    expect(patched).not.toMatch(/\bquickly\b/i)
    expect(patched).not.toMatch(/\bimmediately\b/i)
    expect(patched).toContain("with 16ms frame budget")
    expect(patched).toContain("within 2 seconds")
    expect(patched).toContain("within 1 second")
  })

  it("post-Haiku residual safety net: if Haiku re-introduces a from-word, the final pass cleans it", () => {
    // Simulate Haiku's merge re-introducing the from-word in a rewritten criterion.
    const haikuMergedSpec = `## Acceptance Criteria
1. AC#1: User receives confirmation within 1 second.
2. AC#2: System responds immediately to user input.`  // Haiku rewrote this and put "immediately" back

    const rules = [{ from: "immediately", to: "within 1 second" }]

    const residuals = findResidualCategoryViolations(haikuMergedSpec, rules)
    expect(residuals).toEqual(rules)  // residual detected

    // Final-pass apply
    const cleanedSpec = applyCategoryRules(haikuMergedSpec, residuals)
    expect(cleanedSpec).not.toMatch(/\bimmediately\b/i)
    expect((cleanedSpec.match(/within 1 second/g) ?? []).length).toBe(2)
  })

  it("conservative: single-criterion edits without universal quantifier are NOT category rules", () => {
    // PM clarifying a single AC's vague word is NOT a global directive.
    const pmRecs = `For AC#5 specifically, change "fast" to mean within 200ms. Other ACs may use "fast" differently.`
    expect(extractCategoryRules(pmRecs)).toEqual([])
  })

  it("structural assertion: the extractor + applier are wired into pm-escalation-spec-writer.ts", async () => {
    // Per Principle 7 (zero human errors of omission), the deterministic
    // category-rule path must be wired into the actual writeback site that
    // exhibited Bug-E. Assert the imports + the call sites are present.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"),
      "utf8",
    )

    expect(source).toMatch(/from\s+["']\.\/category-rule-extractor["']/)
    expect(source).toMatch(/extractCategoryRules\s*\(/)
    expect(source).toMatch(/applyCategoryRules\s*\(/)
    expect(source).toMatch(/findResidualCategoryViolations\s*\(/)
    // Operator log marker for grep-ability
    expect(source).toMatch(/\[ESCALATION\] B9:/)
  })

  it("structural assertion: pre-Haiku application happens BEFORE the Haiku merge call (order matters)", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"),
      "utf8",
    )
    const extractIdx = source.indexOf("extractCategoryRules(")
    expect(extractIdx, "extractCategoryRules call must exist in source").toBeGreaterThan(-1)
    // The file has two `client.messages.create(` calls — the first is inside
    // stripVisualDetailsFromSpec (defined near the top), the second is the
    // actual merge call inside patchProductSpecWithRecommendations. The
    // category-rule extraction must happen before the MERGE call (the second
    // occurrence). Find it via indexOf-from-extractIdx.
    const mergeHaikuIdx = source.indexOf("client.messages.create(", extractIdx)
    expect(mergeHaikuIdx, "Haiku merge call (after extractCategoryRules) must exist in source").toBeGreaterThan(-1)
    expect(extractIdx).toBeLessThan(mergeHaikuIdx)
  })

  // ── B9b: cross-agent parity (Principle 15) ────────────────────────────────
  // The same category-rule application must exist in design-escalation-spec-writer.ts.
  // Designer recommendations during architect→designer escalation can include
  // universal substitution directives just like PM recommendations can. A fix
  // shipped only in PM but not design would re-introduce the N-round-trip bug
  // class on the architect→designer path.

  it("structural assertion (B9b cross-agent parity): the extractor + applier + residual checker are wired into design-escalation-spec-writer.ts", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/design-escalation-spec-writer.ts"),
      "utf8",
    )

    expect(source).toMatch(/from\s+["']\.\/category-rule-extractor["']/)
    expect(source).toMatch(/extractCategoryRules\s*\(/)
    expect(source).toMatch(/applyCategoryRules\s*\(/)
    expect(source).toMatch(/findResidualCategoryViolations\s*\(/)
    expect(source).toMatch(/\[ESCALATION\] B9:/)
  })

  it("structural assertion (B9b): pre-Haiku application happens BEFORE the Haiku merge call in design writer too", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/design-escalation-spec-writer.ts"),
      "utf8",
    )
    const extractIdx = source.indexOf("extractCategoryRules(")
    expect(extractIdx, "extractCategoryRules call must exist in design-escalation-spec-writer.ts source").toBeGreaterThan(-1)
    // design-escalation-spec-writer.ts has only one Haiku call (no
    // strip-visual-details pass like PM has). Find from start.
    const haikuIdx = source.indexOf("client.messages.create(")
    expect(haikuIdx, "Haiku call must exist in design-escalation-spec-writer.ts source").toBeGreaterThan(-1)
    expect(extractIdx).toBeLessThan(haikuIdx)
  })

  it("structural assertion (B9b): both writers use the SAME shared module — no duplicate parsers", async () => {
    // Per Principle 15 + Block B2's single-source-of-truth pattern, both
    // writers import from runtime/category-rule-extractor.ts. A future
    // contributor who copy-pasted the regex into one of the writers would
    // break this assertion.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const pmSource = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"),
      "utf8",
    )
    const designSource = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/design-escalation-spec-writer.ts"),
      "utf8",
    )
    const importRe = /from\s+["']\.\/category-rule-extractor["']/
    expect(pmSource).toMatch(importRe)
    expect(designSource).toMatch(importRe)
  })
})
