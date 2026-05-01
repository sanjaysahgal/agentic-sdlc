import { describe, it, expect } from "vitest"
import {
  extractCategoryRules,
  applyCategoryRules,
  findResidualCategoryViolations,
} from "../../runtime/category-rule-extractor"

/**
 * B9 v1 — unit tests for the deterministic category-rule extractor.
 *
 * Companion regression test (bug #16) covers the canonical Bug-E scenario
 * end-to-end. These unit tests cover parser correctness across the
 * supported patterns + the applier's word-boundary semantics + the
 * post-Haiku residual-detection helper.
 */

describe("extractCategoryRules — pattern coverage", () => {
  it('extracts "any X becomes Y" with straight quotes', () => {
    const rules = extractCategoryRules(`Any "immediately" becomes "within 1 second"`)
    expect(rules).toEqual([{ from: "immediately", to: "within 1 second" }])
  })

  it('extracts "all X become Y" with single quotes', () => {
    const rules = extractCategoryRules(`All 'smooth' become 'in under 200ms'`)
    expect(rules).toEqual([{ from: "smooth", to: "in under 200ms" }])
  })

  it('extracts "every X → Y"', () => {
    const rules = extractCategoryRules(`Every "quickly" → "within 2 seconds"`)
    expect(rules).toEqual([{ from: "quickly", to: "within 2 seconds" }])
  })

  it('extracts "every X -> Y" (ASCII arrow)', () => {
    const rules = extractCategoryRules(`Every "fast" -> "within 200ms"`)
    expect(rules).toEqual([{ from: "fast", to: "within 200ms" }])
  })

  it('extracts "all instances of X become Y"', () => {
    const rules = extractCategoryRules(`All instances of "soon" become "within 5 minutes"`)
    expect(rules).toEqual([{ from: "soon", to: "within 5 minutes" }])
  })

  it('extracts "any X should be Y"', () => {
    const rules = extractCategoryRules(`Any "soft" should be "with 200ms ease-in"`)
    expect(rules).toEqual([{ from: "soft", to: "with 200ms ease-in" }])
  })

  it('extracts "replace all X with Y"', () => {
    const rules = extractCategoryRules(`Replace all "smooth" with "in under 200ms"`)
    expect(rules).toEqual([{ from: "smooth", to: "in under 200ms" }])
  })

  it('extracts "replace X with Y" (no "all")', () => {
    const rules = extractCategoryRules(`Replace "TBD" with "specified value"`)
    expect(rules).toEqual([{ from: "TBD", to: "specified value" }])
  })

  it('extracts "replace X by Y"', () => {
    const rules = extractCategoryRules(`Replace "warm" by "with 4-pixel red glow"`)
    expect(rules).toEqual([{ from: "warm", to: "with 4-pixel red glow" }])
  })

  it('extracts "change every X to Y"', () => {
    const rules = extractCategoryRules(`Change every "polished" to "with 8px radius corners"`)
    expect(rules).toEqual([{ from: "polished", to: "with 8px radius corners" }])
  })

  it('extracts smart-quoted patterns (left/right)', () => {
    const rules = extractCategoryRules(`Any “immediately” becomes “within 1 second”`)
    expect(rules).toEqual([{ from: "immediately", to: "within 1 second" }])
  })

  it("extracts multiple rules from the same recommendation", () => {
    const recs = `My recommendations:
1. Any "immediately" becomes "within 1 second".
2. Replace all "smooth" with "in under 200ms".
3. Every "quickly" → "within 2 seconds".`
    const rules = extractCategoryRules(recs)
    expect(rules).toHaveLength(3)
    expect(rules).toContainEqual({ from: "immediately", to: "within 1 second" })
    expect(rules).toContainEqual({ from: "smooth", to: "in under 200ms" })
    expect(rules).toContainEqual({ from: "quickly", to: "within 2 seconds" })
  })

  it("dedupes by `from` keeping the last write", () => {
    const recs = `Any "fast" becomes "within 500ms". Any "fast" becomes "within 200ms".`
    const rules = extractCategoryRules(recs)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({ from: "fast", to: "within 200ms" })
  })

  it("returns empty when no quantifier is present (single-criterion edits are NOT category rules)", () => {
    // Conservative: without "any/all/every/replace/change", we don't substitute globally.
    expect(extractCategoryRules(`AC#5: change "fast" to mean within 200ms.`)).toEqual([])
    expect(extractCategoryRules(`The word "fast" is too vague.`)).toEqual([])
  })

  it("returns empty for empty/null input", () => {
    expect(extractCategoryRules("")).toEqual([])
  })

  it("returns empty when a quoted phrase is too long (likely not a substitution rule)", () => {
    const longFrom = "a".repeat(100)
    const recs = `Any "${longFrom}" becomes "Y"`
    expect(extractCategoryRules(recs)).toEqual([])
  })
})

describe("applyCategoryRules — substitution semantics", () => {
  it("replaces all instances case-insensitively", () => {
    const spec = `AC#1: respond immediately. AC#2: confirm Immediately. AC#3: process IMMEDIATELY.`
    const out = applyCategoryRules(spec, [{ from: "immediately", to: "within 1 second" }])
    expect(out).toBe(`AC#1: respond within 1 second. AC#2: confirm within 1 second. AC#3: process within 1 second.`)
  })

  it("respects word boundaries — does not match substrings", () => {
    const spec = `AC#1: serve breakfast fast. AC#2: fasten the seatbelt. AC#3: respond fast.`
    const out = applyCategoryRules(spec, [{ from: "fast", to: "within 200ms" }])
    // Only the standalone "fast" gets replaced; "breakfast" and "fasten" survive.
    expect(out).toBe(`AC#1: serve breakfast within 200ms. AC#2: fasten the seatbelt. AC#3: respond within 200ms.`)
  })

  it("applies multiple rules in order", () => {
    const spec = `Be smooth and quickly responsive.`
    const out = applyCategoryRules(spec, [
      { from: "smooth", to: "with 16ms frame budget" },
      { from: "quickly", to: "within 2 seconds" },
    ])
    expect(out).toBe(`Be with 16ms frame budget and within 2 seconds responsive.`)
  })

  it("is a no-op when no rules match the spec", () => {
    const spec = `AC#1: be specific.`
    const out = applyCategoryRules(spec, [{ from: "vague", to: "specific" }])
    expect(out).toBe(spec)
  })

  it("is determinstic (Principle 11): same input → same output", () => {
    const spec = `respond immediately to immediately-fired events`
    const rules = [{ from: "immediately", to: "within 1 second" }]
    expect(applyCategoryRules(spec, rules)).toBe(applyCategoryRules(spec, rules))
  })
})

describe("findResidualCategoryViolations — post-Haiku verification", () => {
  it("returns empty when all from-words have been substituted out", () => {
    const cleanSpec = `AC#1: respond within 1 second. AC#2: process within 2 seconds.`
    const rules = [{ from: "immediately", to: "within 1 second" }, { from: "quickly", to: "within 2 seconds" }]
    expect(findResidualCategoryViolations(cleanSpec, rules)).toEqual([])
  })

  it("returns the surviving rule when Haiku re-introduced a from-word", () => {
    // Haiku's merge somehow rewrote a criterion and put "immediately" back in.
    const dirtySpec = `AC#1: respond within 1 second. AC#2: process immediately.`
    const rules = [{ from: "immediately", to: "within 1 second" }]
    const residuals = findResidualCategoryViolations(dirtySpec, rules)
    expect(residuals).toEqual(rules)
  })

  it("respects word boundaries (does not flag breakfast for fast)", () => {
    const spec = `Serve breakfast on time.`
    const rules = [{ from: "fast", to: "within 200ms" }]
    expect(findResidualCategoryViolations(spec, rules)).toEqual([])
  })
})

describe("end-to-end: extract → apply → verify (canonical Bug-E flow)", () => {
  it("PM gives a category rule, applier substitutes everywhere, post-check is clean", () => {
    const dirtyPmSpec = `## Acceptance Criteria
1. AC#1: User receives confirmation immediately after sign-up.
2. AC#2: AI responds immediately when prompted.
3. AC#3: Errors surface immediately on form submission.
4. AC#4: Messages persist across sessions.
5. AC#5: Logout completes immediately.`

    const pmRecs = `Any "immediately" becomes "within 1 second" — that's the platform SLA.`

    const rules = extractCategoryRules(pmRecs)
    expect(rules).toEqual([{ from: "immediately", to: "within 1 second" }])

    const patched = applyCategoryRules(dirtyPmSpec, rules)
    // All 4 instances of "immediately" should be substituted (AC#1, #2, #3, #5)
    expect((patched.match(/within 1 second/g) ?? []).length).toBe(4)
    // No instances of "immediately" should remain
    expect(patched).not.toMatch(/\bimmediately\b/i)

    const residuals = findResidualCategoryViolations(patched, rules)
    expect(residuals).toEqual([])
  })
})
