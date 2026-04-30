import { describe, it, expect, vi, beforeEach } from "vitest"

// Regression test for bug #10: architect→PM escalations resumed to designer instead of architect.
//
// Root cause: PendingEscalation didn't carry an `originAgent` field. The router's universal-guard
// guessed the originating agent based on `targetAgent`:
//
//     const originAgent = universalPending.targetAgent === "design" ? "architect" : "ux-design"
//
// This worked for design→PM (target=pm, guess=ux-design ✓) and architect→design
// (target=design, guess=architect ✓), but FAILED for architect→PM (target=pm, guess=ux-design ✗).
// The result: when the architect detected upstream PM gaps and queued a PM escalation, the
// platform routed control to the designer after PM finished — leaving the architect's engineering
// spec stranded.
//
// Surfaced 2026-04-30 while driving the `onboarding` feature past the architect→PM escalation:
// PM gave correct recommendations but the response said "continue design" because the
// platform's downstream routing thought design originated the escalation.
//
// Fix: add `originAgent` field to PendingEscalation, set it explicitly at every
// setPendingEscalation call site, and read it directly in the router.

describe("bug #10 — PendingEscalation carries originAgent so architect→PM escalations resume to architect", () => {
  it("setPendingEscalation in conversation-store stores originAgent verbatim", async () => {
    const { setPendingEscalation, getPendingEscalation, clearPendingEscalation, disableFilePersistence } = await import("../../runtime/conversation-store")
    disableFilePersistence()
    const key = { product: "test", feature: "f1" }
    setPendingEscalation(key, {
      targetAgent: "pm",
      originAgent: "architect",
      question: "vague language in AC#1",
      designContext: "",
    })
    const got = getPendingEscalation(key)
    expect(got).not.toBeNull()
    expect(got!.originAgent).toBe("architect")
    expect(got!.targetAgent).toBe("pm")
    clearPendingEscalation(key)
  })

  it("the three documented scenarios round-trip correctly", async () => {
    const { setPendingEscalation, getPendingEscalation, clearPendingEscalation, disableFilePersistence } = await import("../../runtime/conversation-store")
    disableFilePersistence()
    const key = { product: "test", feature: "f2" }

    // Scenario A: design → PM (the historically working case)
    setPendingEscalation(key, { targetAgent: "pm", originAgent: "ux-design", question: "q", designContext: "" })
    expect(getPendingEscalation(key)?.originAgent).toBe("ux-design")

    // Scenario B: architect → design (the historically working case)
    clearPendingEscalation(key)
    setPendingEscalation(key, { targetAgent: "design", originAgent: "architect", question: "q", designContext: "" })
    expect(getPendingEscalation(key)?.originAgent).toBe("architect")

    // Scenario C: architect → PM (the historically BROKEN case — bug #10)
    clearPendingEscalation(key)
    setPendingEscalation(key, { targetAgent: "pm", originAgent: "architect", question: "q", designContext: "" })
    const got = getPendingEscalation(key)
    expect(got?.originAgent).toBe("architect")
    expect(got?.targetAgent).toBe("pm")
    clearPendingEscalation(key)
  })
})
