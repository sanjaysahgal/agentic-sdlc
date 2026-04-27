import { describe, it, expect } from "vitest"
import {
  DEFAULT_TENANT,
  tenantId,
  featureId,
  threadTs,
  userId,
  featureKey,
  threadKey,
  featureKeyToString,
  threadKeyToString,
} from "../../runtime/routing/types"
import {
  AGENT_REGISTRY,
  lookupAgent,
  lookupAgentForPhase,
  isAgentId,
} from "../../runtime/routing/agent-registry"

// Phase 1 is type-level work; the consumers (pure routers) come in Phase 2. These tests
// pin down the small runtime surface — branded constructors, key projections, and
// registry lookups — so coverage stays above threshold and any future regression in
// these helpers is caught immediately.

describe("runtime/routing/types — branded constructors", () => {
  it("DEFAULT_TENANT is the literal 'default'", () => {
    expect(DEFAULT_TENANT as string).toBe("default")
  })

  it("tenantId/featureId/threadTs/userId are pass-through brands at runtime", () => {
    expect(tenantId("default") as string).toBe("default")
    expect(featureId("onboarding") as string).toBe("onboarding")
    expect(threadTs("1234.5678") as string).toBe("1234.5678")
    expect(userId("U_ABC") as string).toBe("U_ABC")
  })

  it("featureKey defaults to DEFAULT_TENANT", () => {
    const k = featureKey("onboarding")
    expect(k.tenant as string).toBe("default")
    expect(k.feature as string).toBe("onboarding")
  })

  it("featureKey accepts an explicit tenant", () => {
    const k = featureKey("onboarding", tenantId("acme"))
    expect(k.tenant as string).toBe("acme")
  })

  it("threadKey defaults to DEFAULT_TENANT", () => {
    const k = threadKey("1234.5678")
    expect(k.tenant as string).toBe("default")
    expect(k.thread as string).toBe("1234.5678")
  })

  it("featureKeyToString projects to bare feature string", () => {
    expect(featureKeyToString(featureKey("onboarding"))).toBe("onboarding")
  })

  it("threadKeyToString projects to bare thread ts string", () => {
    expect(threadKeyToString(threadKey("1234.5678"))).toBe("1234.5678")
  })
})

describe("runtime/routing/agent-registry — invariants and lookups", () => {
  it("contains pm, ux-design, architect, concierge", () => {
    const ids = AGENT_REGISTRY.map((e) => e.id).sort()
    expect(ids).toEqual(["architect", "concierge", "pm", "ux-design"])
  })

  it("lookupAgent returns the entry by id", () => {
    expect(lookupAgent("pm")?.displayName).toContain("Product Manager")
    expect(lookupAgent("ux-design")?.displayName).toContain("UX Design")
    expect(lookupAgent("architect")?.displayName).toContain("Architect")
    expect(lookupAgent("concierge")?.displayName).toContain("Concierge")
  })

  it("lookupAgentForPhase resolves the canonical agent for each phase", () => {
    expect(lookupAgentForPhase("product-spec-in-progress")?.id).toBe("pm")
    expect(lookupAgentForPhase("product-spec-approved-awaiting-design")?.id).toBe("ux-design")
    expect(lookupAgentForPhase("design-in-progress")?.id).toBe("ux-design")
    expect(lookupAgentForPhase("design-approved-awaiting-engineering")?.id).toBe("architect")
    expect(lookupAgentForPhase("engineering-in-progress")?.id).toBe("architect")
  })

  it("lookupAgentForPhase returns undefined for the complete phase", () => {
    // The `complete` phase is unowned — concierge lives outside the feature lifecycle.
    expect(lookupAgentForPhase("complete")).toBeUndefined()
  })

  it("isAgentId narrows known ids and rejects unknown strings", () => {
    expect(isAgentId("pm")).toBe(true)
    expect(isAgentId("ux-design")).toBe(true)
    expect(isAgentId("architect")).toBe(true)
    expect(isAgentId("concierge")).toBe(true)
    expect(isAgentId("design")).toBe(false) // legacy alias — see FLAG-D, fixed Phase 5
    expect(isAgentId("coder")).toBe(false)
    expect(isAgentId("")).toBe(false)
  })

  it("phase ownership is single-valued (I11)", () => {
    const seen = new Map<string, string>()
    for (const entry of AGENT_REGISTRY) {
      for (const phase of entry.phases) {
        const prior = seen.get(phase)
        expect(prior === undefined || prior === entry.id).toBe(true)
        seen.set(phase, entry.id)
      }
    }
  })
})
