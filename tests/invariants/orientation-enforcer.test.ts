// Phase 5 / I21 — orientation-on-resume enforcement tests.
//
// The detector and override builder are pure (Principle 11 — same input,
// same output, always). The orchestrator is async but takes a mocked runFn
// so tests are deterministic and millisecond-fast. Three layers of coverage:
//
//   1. Detector: every required structural element has a "missing" case;
//      a happy-path case proves a fully-compliant response yields ok: true.
//   2. Override builder: produces a directive that names every required
//      element so the model has a complete spec on retry.
//   3. Orchestrator: respects maxRetries; doesn't retry when the first
//      response is compliant; surfaces the final check verbatim.

import { describe, it, expect, vi } from "vitest"
import {
  detectOrientationBlock,
  buildOrientationOverride,
  enforceOrientationOnResume,
  type OrientationContext,
} from "../../runtime/orientation-enforcer"

// Reusable fixture context. Tests override individual fields as needed.
function ctx(over: Partial<OrientationContext> = {}): OrientationContext {
  return {
    targetAgent:      "pm",
    originAgent:      "architect",
    featureName:      "onboarding",
    downstreamPhase:  "engineering-in-progress",
    upstreamSpecType: "product",
    upstreamSpecPath: "docs/specs/onboarding/product.md",
    itemCount:        3,
    ...over,
  }
}

// A response that contains every required orientation element. Used as the
// happy-path baseline; "missing X" tests construct a copy with element X
// removed so the gate flags exactly that element.
function compliantResponse(c: OrientationContext): string {
  return [
    `*Orientation:* The ${c.upstreamSpecType} spec for \`${c.featureName}\` is approved on main `,
    `([link](${c.upstreamSpecPath})). During Engineering, the Architect ran the upstream-spec audit `,
    `and flagged ${c.itemCount} items. I'm in escalation-engaged mode — reviewing those items.`,
    ``,
    `Here are the tightenings I'd propose:`,
    `1. Tighten AC#3.`,
    `2. Add an empty-state for the dashboard.`,
    `3. Define the session expiry value.`,
  ].join("\n")
}

describe("detectOrientationBlock — Phase 5 / I21", () => {
  describe("happy path (every required element present)", () => {
    it("returns ok: true with empty missing list", () => {
      const c = ctx()
      const result = detectOrientationBlock(compliantResponse(c), c)
      expect(result.ok).toBe(true)
      expect(result.missing).toEqual([])
    })

    it("works for designer pulled by architect (target=ux-design, origin=architect)", () => {
      const c = ctx({ targetAgent: "ux-design", originAgent: "architect", upstreamSpecType: "design" })
      const response = compliantResponse(c)
        .replace("Architect ran the upstream", "Architect ran the upstream")  // already correct
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(true)
    })

    it("works for PM pulled by designer (target=pm, origin=ux-design)", () => {
      const c = ctx({ originAgent: "ux-design", downstreamPhase: "design-in-progress" })
      const response = [
        `*Orientation:* The product spec for \`onboarding\` is approved on main `,
        `([link](docs/specs/onboarding/product.md)). During Design, the Designer ran the upstream-spec audit `,
        `and flagged 3 items. I'm reviewing those items in escalation-engaged mode.`,
        ``,
        `Recommendations:`,
      ].join("\n")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(true)
    })
  })

  describe("missing structural elements (one per gate)", () => {
    it("flags missing leading *Orientation:* marker", () => {
      const c = ctx()
      const response = compliantResponse(c).replace("*Orientation:* ", "")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("*Orientation:*"))).toBe(true)
    })

    it("flags feature name not backticked", () => {
      const c = ctx()
      const response = compliantResponse(c).replace(/`onboarding`/g, "onboarding")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("feature name not backticked"))).toBe(true)
    })

    it("flags originAgent role not named", () => {
      const c = ctx()
      const response = compliantResponse(c).replace(/Architect/g, "the upstream agent")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("originAgent role not named"))).toBe(true)
    })

    it("flags item count not stated as digit", () => {
      const c = ctx({ itemCount: 7 })
      const response = compliantResponse({ ...c, itemCount: 3 })  // wrong digit
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("item count not stated"))).toBe(true)
    })

    it("flags missing markdown link", () => {
      const c = ctx()
      const response = compliantResponse(c).replace(/\[link\]\([^)]+\)/g, "the spec")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("markdown spec link"))).toBe(true)
    })

    it("flags missing mode statement", () => {
      const c = ctx()
      const response = compliantResponse(c)
        .replace(/escalation-engaged mode — reviewing those items/, "ready to go")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("no mode statement"))).toBe(true)
    })

    it("flags missing first-person voice (Principle 8a — presence-of-correct, not absence-of-bad)", () => {
      const c = ctx()
      // Replace I-pronouns with passive/third-person constructions.
      const response = compliantResponse(c)
        .replace(/I'm in escalation-engaged mode — reviewing those items/, "the engagement reviews those items")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.some((m) => m.includes("first-person voice"))).toBe(true)
    })
  })

  describe("multiple missing elements aggregate (single round-trip)", () => {
    it("returns ALL missing elements in one check (not just the first)", () => {
      const c = ctx()
      // A response with no orientation block at all.
      const response = "Here are my recommendations:\n1. Foo\n2. Bar"
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      // Every required element should be flagged so the override directive
      // can name all of them in one round-trip.
      expect(result.missing.length).toBeGreaterThanOrEqual(6)
    })
  })

  describe("only the orientation paragraph counts (body content doesn't satisfy)", () => {
    it("body containing required keywords doesn't satisfy gate if orientation paragraph is missing them", () => {
      const c = ctx()
      // Header has the marker but missing required content; body has the
      // content. Gate should still flag — the contract is "first paragraph".
      const response = [
        `*Orientation:* Resumed.`,
        ``,
        `\`onboarding\`, Architect, 3 items, [link](docs/specs/onboarding/product.md), engaged, I'll draft.`,
      ].join("\n")
      const result = detectOrientationBlock(response, c)
      expect(result.ok).toBe(false)
      expect(result.missing.length).toBeGreaterThan(0)
    })
  })

  describe("determinism (Principle 11)", () => {
    it("same input → byte-identical missing list across repeated calls", () => {
      const c = ctx()
      const response = "no orientation here"
      const a = detectOrientationBlock(response, c)
      const b = detectOrientationBlock(response, c)
      expect(a.missing).toEqual(b.missing)
      expect(a.ok).toBe(b.ok)
    })
  })
})

describe("buildOrientationOverride — Phase 5 / I21", () => {
  it("names every required structural element by number", () => {
    const directive = buildOrientationOverride(ctx())
    expect(directive).toContain("*Orientation:*")
    expect(directive).toContain("`onboarding`")
    expect(directive).toContain("Architect")
    expect(directive).toContain("3 items")
    expect(directive).toContain("docs/specs/onboarding/product.md")
    expect(directive).toMatch(/1\.\s.*Orientation/)
    expect(directive).toMatch(/7\.\s.*first-person/)
  })

  it("names voice rules explicitly (first-person agent, second-person user, no passive)", () => {
    const directive = buildOrientationOverride(ctx())
    expect(directive.toLowerCase()).toContain("first-person agent")
    expect(directive.toLowerCase()).toContain("second-person user")
    expect(directive.toLowerCase()).toContain("passive")
  })

  it("includes the targetAgent's role label so the agent identifies correctly", () => {
    const directive = buildOrientationOverride(ctx({ targetAgent: "ux-design" }))
    expect(directive).toContain("Designer")
  })

  it("uses singular 'item' when itemCount === 1, plural 'items' otherwise", () => {
    expect(buildOrientationOverride(ctx({ itemCount: 1 }))).toMatch(/flagged 1 item\b/)
    expect(buildOrientationOverride(ctx({ itemCount: 2 }))).toMatch(/flagged 2 items\b/)
  })

  it("when given a check, lists the missing elements verbatim from the previous attempt", () => {
    const check = { ok: false, missing: ["missing leading marker", "no link"] }
    const directive = buildOrientationOverride(ctx(), check)
    expect(directive).toContain("Your previous response was missing")
    expect(directive).toContain("missing leading marker")
    expect(directive).toContain("no link")
  })

  it("when given no check, omits the 'previous response' clause", () => {
    const directive = buildOrientationOverride(ctx())
    expect(directive).not.toContain("Your previous response was missing")
  })
})

describe("enforceOrientationOnResume — Phase 5 / I21", () => {
  it("compliant first response → no retries, returns response verbatim", async () => {
    const c = ctx()
    const compliant = compliantResponse(c)
    const runFn = vi.fn().mockResolvedValueOnce(compliant)

    const result = await enforceOrientationOnResume(runFn, c)

    expect(result.reRanCount).toBe(0)
    expect(result.response).toBe(compliant)
    expect(result.finalCheck.ok).toBe(true)
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(runFn).toHaveBeenCalledWith(null)  // initial run gets null override
  })

  it("non-compliant first response → re-runs once with override; returns the retry response", async () => {
    const c = ctx()
    const bad      = "Here are my recommendations.\n1. Foo"
    const compliant = compliantResponse(c)
    const runFn = vi.fn()
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(compliant)

    const result = await enforceOrientationOnResume(runFn, c)

    expect(result.reRanCount).toBe(1)
    expect(result.response).toBe(compliant)
    expect(result.finalCheck.ok).toBe(true)
    expect(runFn).toHaveBeenCalledTimes(2)

    // First call: no override. Second call: override directive containing
    // the required elements.
    expect(runFn.mock.calls[0][0]).toBeNull()
    expect(runFn.mock.calls[1][0]).toContain("*Orientation:*")
    expect(runFn.mock.calls[1][0]).toContain("Your previous response was missing")
  })

  it("non-compliant after retry → returns the last attempt with finalCheck.ok=false", async () => {
    const c = ctx()
    const bad = "no orientation"
    const runFn = vi.fn()
      .mockResolvedValue(bad)  // every call returns bad

    const result = await enforceOrientationOnResume(runFn, c)

    expect(result.reRanCount).toBe(1)  // default maxRetries=1
    expect(result.response).toBe(bad)
    expect(result.finalCheck.ok).toBe(false)
    expect(result.finalCheck.missing.length).toBeGreaterThan(0)
    expect(runFn).toHaveBeenCalledTimes(2)
  })

  it("respects custom maxRetries (e.g. 3 retries → up to 4 total calls)", async () => {
    const c = ctx()
    const runFn = vi.fn().mockResolvedValue("no orientation")

    const result = await enforceOrientationOnResume(runFn, c, { maxRetries: 3 })

    expect(result.reRanCount).toBe(3)
    expect(runFn).toHaveBeenCalledTimes(4)
  })

  it("maxRetries=0 → no retries, surface whatever runFn returns", async () => {
    const c = ctx()
    const runFn = vi.fn().mockResolvedValueOnce("no orientation")

    const result = await enforceOrientationOnResume(runFn, c, { maxRetries: 0 })

    expect(result.reRanCount).toBe(0)
    expect(result.finalCheck.ok).toBe(false)
    expect(runFn).toHaveBeenCalledTimes(1)
  })

  it("override directive includes missing elements from the FIRST check (not stale)", async () => {
    const c = ctx({ itemCount: 5 })
    const partiallyBad = [
      `*Orientation:* The product spec for \`onboarding\` is on main.`,
      `Architect flagged some items. I'll draft.`,
      ``,
      `1. Foo`,
    ].join("\n")
    const runFn = vi.fn().mockResolvedValueOnce(partiallyBad).mockResolvedValueOnce("still bad")

    await enforceOrientationOnResume(runFn, c)

    const overrideArg = runFn.mock.calls[1][0] as string
    // The first response was missing the item count (5), the markdown link,
    // and the mode statement. The override should call all three out.
    expect(overrideArg).toContain("item count")
    expect(overrideArg).toContain("markdown")
  })
})
