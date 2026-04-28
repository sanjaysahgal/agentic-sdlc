// Phase 5 / I7-extended — exhaustive tests for renderHoldMessage.
//
// The renderer is pure (no I/O), so these are unit tests with no mocks. Every
// hold-message variant the routers can produce should appear here at least
// once: registry-derived labels, item-count/pluralization, single-sentence
// vs. numbered-list questions, every (heldAgent × downstreamPhase) pair the
// matrix exercises today.
//
// FLAG-C is fixed by ANY of these assertions failing — the prior hardcoded
// "Design is paused — say yes to bring the PM into this thread" string would
// not satisfy them.

import { describe, it, expect } from "vitest"
import {
  renderHoldMessage,
  parseQuestionItems,
  phaseShortName,
  upstreamSpecOf,
  type ShowHoldMessageDecision,
} from "../../runtime/routing/hold-message-renderer"

function decision(over: Partial<ShowHoldMessageDecision> = {}): ShowHoldMessageDecision {
  return {
    kind:             "show-hold-message",
    reason:           "escalation",
    heldAgent:        "pm",
    featureName:      "onboarding",
    downstreamPhase:  "design-in-progress",
    blockingQuestion: "What is the session expiry?",
    preEffects:       [],
    postEffects:      [],
    ...over,
  } as ShowHoldMessageDecision
}

describe("renderHoldMessage — Phase 5 / I7-extended", () => {
  describe("registry-derived labels (FLAG-C fix)", () => {
    it("design-in-progress + held=pm renders Design phase + product spec + PM role", () => {
      const text = renderHoldMessage(decision())
      expect(text).toContain("Design on `onboarding` is blocked")
      expect(text).toContain("product spec")
      expect(text).toContain("Reply *yes* to have the PM draft tightenings")
      expect(text).not.toContain("Design is paused")          // old FLAG-C string
      expect(text).not.toContain("bring the PM into this thread") // old personification
    })

    it("design-in-progress + held=architect renders Design phase + engineering spec + Architect role", () => {
      const text = renderHoldMessage(decision({
        heldAgent: "architect",
        downstreamPhase: "design-in-progress",
        blockingQuestion: "Which form factors must be supported?",
      }))
      expect(text).toContain("Design on `onboarding` is blocked")
      expect(text).toContain("engineering spec")
      expect(text).toContain("Reply *yes* to have the Architect draft tightenings")
    })

    it("engineering-in-progress + held=pm renders Engineering phase + product spec + PM role", () => {
      const text = renderHoldMessage(decision({
        heldAgent: "pm",
        downstreamPhase: "engineering-in-progress",
        blockingQuestion: "1. Vague AC#3\n2. Missing auth requirement",
      }))
      expect(text).toContain("Engineering on `onboarding` is blocked")
      expect(text).toContain("product spec")
      expect(text).toContain("Reply *yes* to have the PM draft tightenings")
    })

    it("engineering-in-progress + held=ux-design renders Engineering phase + design spec + Designer role", () => {
      const text = renderHoldMessage(decision({
        heldAgent: "ux-design",
        downstreamPhase: "engineering-in-progress",
        blockingQuestion: "How should the modal close on mobile?",
      }))
      expect(text).toContain("Engineering on `onboarding` is blocked")
      expect(text).toContain("design spec")
      expect(text).toContain("Reply *yes* to have the Designer draft tightenings")
    })
  })

  describe("item count + pluralization (singular vs plural)", () => {
    it("single-sentence question → 1 unresolved item (singular)", () => {
      const text = renderHoldMessage(decision({ blockingQuestion: "What is the session expiry?" }))
      expect(text).toContain("blocked by 1 unresolved item in the")
      expect(text).not.toContain("1 unresolved items")
    })

    it("two numbered items → 2 unresolved items (plural)", () => {
      const text = renderHoldMessage(decision({ blockingQuestion: "1. Vague AC#3\n2. Missing auth requirement" }))
      expect(text).toContain("blocked by 2 unresolved items in the")
    })

    it("four numbered items → 4 unresolved items + each rendered on its own line", () => {
      const q = "1. AC#1 vague\n2. AC#3 missing rationale\n3. No success metric\n4. Edge case undefined"
      const text = renderHoldMessage(decision({ blockingQuestion: q }))
      expect(text).toContain("blocked by 4 unresolved items in the")
      expect(text).toContain("1. AC#1 vague")
      expect(text).toContain("2. AC#3 missing rationale")
      expect(text).toContain("3. No success metric")
      expect(text).toContain("4. Edge case undefined")
    })
  })

  describe("featureName escaping", () => {
    it("wraps featureName in backticks for Slack code formatting", () => {
      const text = renderHoldMessage(decision({ featureName: "onboarding-v2" }))
      expect(text).toContain("`onboarding-v2`")
    })
  })

  describe("posture coherence (no agent personification, no hardcoded phase)", () => {
    it("never says 'is paused' (FLAG-C)", () => {
      const variants: ShowHoldMessageDecision[] = [
        decision({ downstreamPhase: "design-in-progress",      heldAgent: "pm" }),
        decision({ downstreamPhase: "design-in-progress",      heldAgent: "architect" }),
        decision({ downstreamPhase: "engineering-in-progress", heldAgent: "pm" }),
        decision({ downstreamPhase: "engineering-in-progress", heldAgent: "ux-design" }),
      ]
      for (const v of variants) {
        expect(renderHoldMessage(v)).not.toMatch(/is paused/i)
      }
    })

    it("never says 'bring the X into this thread' (third-party personification)", () => {
      const variants: ShowHoldMessageDecision[] = [
        decision({ heldAgent: "pm" }),
        decision({ heldAgent: "ux-design" }),
        decision({ heldAgent: "architect" }),
      ]
      for (const v of variants) {
        expect(renderHoldMessage(v)).not.toMatch(/bring the .+ into this thread/i)
      }
    })
  })

  describe("determinism (Principle 11)", () => {
    it("same input → byte-identical output across repeated calls", () => {
      const d = decision({ blockingQuestion: "1. one\n2. two\n3. three" })
      const a = renderHoldMessage(d)
      const b = renderHoldMessage(d)
      const c = renderHoldMessage(d)
      expect(a).toBe(b)
      expect(b).toBe(c)
    })
  })
})

describe("parseQuestionItems", () => {
  it("single-sentence question → count=1, items=[question]", () => {
    expect(parseQuestionItems("What is the session expiry?")).toEqual({
      count: 1,
      items: ["What is the session expiry?"],
    })
  })

  it("numbered list → count=N, items=stripped of numbering", () => {
    expect(parseQuestionItems("1. foo\n2. bar\n3. baz")).toEqual({
      count: 3,
      items: ["foo", "bar", "baz"],
    })
  })

  it("empty string → count=0, items=[]", () => {
    expect(parseQuestionItems("")).toEqual({ count: 0, items: [] })
  })

  it("inline numbered list (no newlines) → conversation-store normalizes to multi-line before storage; raw inline parses as 1 numbered item with the trailing content kept verbatim", () => {
    // conversation-store.setPendingEscalation rewrites `(?<=[^\n])(\s+)(\d+\.\s)`
    // → `\n$2` before persisting, so production never reaches the renderer with
    // an unnormalized inline list. This test pins the parser's fallback shape
    // for the rare path where state was set without going through that
    // normalizer (e.g. on-disk migration, fixture data).
    expect(parseQuestionItems("1. foo 2. bar")).toEqual({
      count: 1,
      items: ["foo 2. bar"],
    })
  })
})

describe("phaseShortName", () => {
  it("maps every phase to a label (exhaustiveness)", () => {
    expect(phaseShortName("product-spec-in-progress")).toBe("Product")
    expect(phaseShortName("product-spec-approved-awaiting-design")).toBe("Product")
    expect(phaseShortName("design-in-progress")).toBe("Design")
    expect(phaseShortName("design-approved-awaiting-engineering")).toBe("Design")
    expect(phaseShortName("engineering-in-progress")).toBe("Engineering")
    expect(phaseShortName("complete")).toBe("Feature")
  })
})

describe("upstreamSpecOf", () => {
  it("derives from agent registry (pm→product, ux-design→design, architect→engineering)", () => {
    expect(upstreamSpecOf("pm")).toBe("product")
    expect(upstreamSpecOf("ux-design")).toBe("design")
    expect(upstreamSpecOf("architect")).toBe("engineering")
  })

  it("returns <unknown> for agents with no owned spec (concierge)", () => {
    expect(upstreamSpecOf("concierge")).toBe("<unknown>")
  })
})
