import { describe, it, expect } from "vitest"
import { enforceNoHedging } from "../../runtime/deterministic-auditor"

/**
 * Block N (option 3) — unit tests for the runtime hedge-gate rewriter.
 * Replaces the legacy "strip trailing `?` lines and append canned text"
 * behavior. Tests cover: imperative substitution, sentence-drop for
 * open-ended deferrals, no-op on hedge-free input, no-op on legitimate
 * questions (escalation confirmations), and idempotence.
 */

describe("enforceNoHedging — runtime hedge gate (Block N option 3)", () => {
  it("returns input unchanged when no hedges are detected", () => {
    const input = "Recommendation: use PostgreSQL for the user store. Reasoning: ACID guarantees and proven scale."
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected).toEqual([])
    expect(rewritten).toBe(input)
  })

  it("replaces 'shall I' with 'I'll' (imperative substitute)", () => {
    const input = "Going with Postgres. Shall I draft the schema now?"
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected).toContain("shall I")
    expect(rewritten).toContain("I'll draft the schema now?")
    expect(rewritten).not.toContain("Shall I")
  })

  it("replaces 'would you like me to' with 'I'll'", () => {
    const input = "The schema is ready. Would you like me to generate the migrations?"
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected).toContain("would you like me to")
    expect(rewritten).toContain("I'll generate the migrations?")
  })

  it("drops the entire sentence containing 'what do you think'", () => {
    const input = "Recommendation: Option A. What do you think about Option B?"
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected).toContain("what do you think")
    expect(rewritten).toContain("Recommendation: Option A.")
    expect(rewritten.toLowerCase()).not.toContain("what do you think")
  })

  it("drops the entire sentence containing 'up to you'", () => {
    const input = "I recommend the JWT approach. Up to you whether to add refresh tokens."
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected).toContain("up to you")
    expect(rewritten).toContain("I recommend the JWT approach.")
    expect(rewritten.toLowerCase()).not.toContain("up to you")
  })

  it("does NOT modify text when the deferral phrase is in a legitimate-question context", () => {
    const input = "Should I escalate to PM for this clarification? Confirm with yes."
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected).toEqual([])
    expect(rewritten).toBe(input)
  })

  it("preserves substantive content — does NOT append canned 'I'll proceed' text", () => {
    const input = "Recommendation: use PostgreSQL. Shall I write the schema?"
    const { rewritten } = enforceNoHedging(input)
    expect(rewritten).not.toContain("I'll proceed with the approach outlined above")
  })

  it("is idempotent — second call on the rewritten output is a no-op", () => {
    const input = "Going with Postgres. Shall I draft the schema?"
    const first  = enforceNoHedging(input)
    const second = enforceNoHedging(first.rewritten)
    expect(second.hedgesDetected).toEqual([])
    expect(second.rewritten).toBe(first.rewritten)
  })

  it("handles multiple distinct hedges in one response", () => {
    const input = "Use Postgres. Shall I draft the schema? What do you think about indexing strategy?"
    const { rewritten, hedgesDetected } = enforceNoHedging(input)
    expect(hedgesDetected.length).toBeGreaterThanOrEqual(2)
    expect(rewritten.toLowerCase()).not.toContain("shall i")
    expect(rewritten.toLowerCase()).not.toContain("what do you think")
  })
})
