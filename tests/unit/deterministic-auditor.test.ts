import { describe, it, expect } from "vitest"
import {
  auditPmSpec,
  auditPmDesignReadiness,
  auditDesignSpec,
  auditEngineeringSpec,
  detectHedgeLanguage,
  VAGUE_WORDS,
  DEFERRAL_MARKERS,
} from "../../runtime/deterministic-auditor"

// ────────────────────────────────────────────────────────────────────────────────
// Determinism contract: every test runs the audit TWICE and asserts identical results
// ────────────────────────────────────────────────────────────────────────────────

function assertDeterministic(fn: () => unknown) {
  const r1 = JSON.stringify(fn())
  const r2 = JSON.stringify(fn())
  expect(r1).toBe(r2)
}

// ────────────────────────────────────────────────────────────────────────────────
// PM Spec Audit
// ────────────────────────────────────────────────────────────────────────────────

describe("auditPmSpec (@deterministic)", () => {
  it("returns ready=true for clean spec", () => {
    const spec = `## Acceptance Criteria\n- AC#1: User sees a 10-minute countdown timer\n## Non-Goals\n- Desktop app is out of scope for v1\n## Open Questions\n(none)`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("detects open questions", () => {
    const spec = `## Open Questions\n- What DB should we use? [blocking: yes]`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.ready).toBe(false)
    expect(result.findings.some(f => f.criterion === "OPEN_QUESTIONS")).toBe(true)
  })

  it("detects vague language in acceptance criteria", () => {
    const spec = `## Acceptance Criteria\n- AC#1: User experience should be smooth and seamless\n## Non-Goals\n- No desktop support`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.ready).toBe(false)
    expect(result.findings.some(f => f.criterion === "VAGUE_LANGUAGE")).toBe(true)
  })

  it("detects vague timing without numeric values", () => {
    const spec = `## Acceptance Criteria\n- AC#1: Page loads quickly after sign-in\n## Non-Goals\n- No desktop`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.findings.some(f => f.criterion === "VAGUE_TIMING")).toBe(true)
  })

  it("detects vague error behavior phrases", () => {
    const spec = `## Acceptance Criteria\n- AC#1: If sign-in fails, handle gracefully\n## Non-Goals\n- Out of scope: admin`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.findings.some(f => f.criterion === "VAGUE_ERROR_BEHAVIOR")).toBe(true)
  })

  it("detects deferral markers (TBD, TODO)", () => {
    const spec = `## Acceptance Criteria\n- AC#1: Auth method TBD\n## Non-Goals\n- No desktop`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.findings.some(f => f.criterion === "DEFERRAL_MARKERS")).toBe(true)
  })

  it("detects empty Non-Goals", () => {
    const spec = `## Non-Goals\n\n## Acceptance Criteria\n- AC#1: Concrete criterion`
    const result = auditPmSpec(spec)
    assertDeterministic(() => auditPmSpec(spec))
    expect(result.findings.some(f => f.criterion === "NON_GOALS")).toBe(true)
  })

  it("each VAGUE_WORDS entry is detected", () => {
    for (const word of VAGUE_WORDS) {
      const spec = `## Acceptance Criteria\n- AC#1: The interface should be ${word}\n## Non-Goals\n- No desktop`
      const result = auditPmSpec(spec)
      expect(result.findings.some(f => f.criterion === "VAGUE_LANGUAGE"), `Failed to detect: ${word}`).toBe(true)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// PM Design Readiness Audit
// ────────────────────────────────────────────────────────────────────────────────

describe("auditPmDesignReadiness (@deterministic)", () => {
  it("includes all PM spec findings plus additional design-readiness checks", () => {
    const spec = `## Acceptance Criteria\n- AC#1: Smooth login\n## User Stories\n- US-1: User signs in seamlessly\n## Non-Goals\n- No desktop`
    const result = auditPmDesignReadiness(spec)
    assertDeterministic(() => auditPmDesignReadiness(spec))
    expect(result.ready).toBe(false)
    // Should have vague language from both AC and User Stories
    expect(result.findings.filter(f => f.criterion === "VAGUE_LANGUAGE").length).toBeGreaterThanOrEqual(2)
  })

  it("deduplicates findings", () => {
    const spec = `## Acceptance Criteria\n- AC#1: Session expires quickly\n## Non-Goals\n- No desktop`
    const result = auditPmDesignReadiness(spec)
    assertDeterministic(() => auditPmDesignReadiness(spec))
    // Should not have duplicate findings for the same issue
    const issues = result.findings.map(f => f.issue)
    expect(new Set(issues).size).toBe(issues.length)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Design Spec Audit
// ────────────────────────────────────────────────────────────────────────────────

describe("auditDesignSpec (@deterministic)", () => {
  it("returns ready=true for clean spec", () => {
    const spec = `## Screens\n### Screen 1: Home\nLayout for mobile and desktop.\nEntry animation: slide up 300ms ease-out.\n## Open Questions\n(none)`
    const result = auditDesignSpec(spec, { targetFormFactors: ["mobile", "desktop"] })
    assertDeterministic(() => auditDesignSpec(spec, { targetFormFactors: ["mobile", "desktop"] }))
    expect(result.ready).toBe(true)
  })

  it("detects open questions", () => {
    const spec = `## Open Questions\n- How should error state look? [blocking: yes]`
    const result = auditDesignSpec(spec)
    assertDeterministic(() => auditDesignSpec(spec))
    expect(result.findings.some(f => f.criterion === "OPEN_QUESTIONS")).toBe(true)
  })

  it("detects TBD/TODO markers", () => {
    const spec = `## Screens\n### Screen 1: Home\nButton label: TBD`
    const result = auditDesignSpec(spec)
    assertDeterministic(() => auditDesignSpec(spec))
    expect(result.findings.some(f => f.criterion === "DEFERRAL_MARKERS")).toBe(true)
  })

  it("detects vague language in screens", () => {
    const spec = `## Screens\n### Screen 1: Home\nThe layout uses appropriate spacing and subtle animations.`
    const result = auditDesignSpec(spec)
    assertDeterministic(() => auditDesignSpec(spec))
    expect(result.findings.some(f => f.criterion === "VAGUE_LANGUAGE")).toBe(true)
  })

  it("detects animations without timing", () => {
    const spec = `## Screens\n### Screen 1: Home\nThe sheet is animated with a smooth transition when opening.`
    const result = auditDesignSpec(spec)
    assertDeterministic(() => auditDesignSpec(spec))
    expect(result.findings.some(f => f.criterion === "ANIMATION_TIMING")).toBe(true)
  })

  it("passes animation check when timing specified", () => {
    const spec = `## Screens\n### Screen 1: Home\nThe sheet slides up over 300ms ease-out on entry.`
    const result = auditDesignSpec(spec)
    assertDeterministic(() => auditDesignSpec(spec))
    expect(result.findings.filter(f => f.criterion === "ANIMATION_TIMING")).toHaveLength(0)
  })

  it("detects missing form factor coverage", () => {
    const spec = `## Screens\n### Screen 1: Home\nMobile layout only.\n## Non-Goals\n- Performance optimization`
    const result = auditDesignSpec(spec, { targetFormFactors: ["mobile", "desktop"] })
    assertDeterministic(() => auditDesignSpec(spec, { targetFormFactors: ["mobile", "desktop"] }))
    expect(result.findings.some(f => f.criterion === "FORM_FACTOR_COVERAGE")).toBe(true)
  })

  it("skips form factor check when excluded in Non-Goals", () => {
    const spec = `## Screens\n### Screen 1: Home\nMobile layout.\n## Non-Goals\n- Desktop layout is out of scope`
    const result = auditDesignSpec(spec, { targetFormFactors: ["mobile", "desktop"] })
    assertDeterministic(() => auditDesignSpec(spec, { targetFormFactors: ["mobile", "desktop"] }))
    expect(result.findings.filter(f => f.criterion === "FORM_FACTOR_COVERAGE")).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Engineering Spec Audit
// ────────────────────────────────────────────────────────────────────────────────

describe("auditEngineeringSpec (@deterministic)", () => {
  it("returns ready=true for complete spec", () => {
    const spec = `## Open Questions\n(none)\n## API Contracts\n### POST /v1/auth/sso\nAuth: none (public endpoint)\nRequest body: { provider: string, id_token: string }\nResponse: { access_token: string, user_id: string }\n## Data Model\n### users\n- id: uuid\n- email: string\n- sso_provider: string\nMigration: additive — new columns added as nullable first`
    const result = auditEngineeringSpec(spec)
    assertDeterministic(() => auditEngineeringSpec(spec))
    expect(result.ready).toBe(true)
  })

  it("detects open questions", () => {
    const spec = `## Open Questions\n- Which cache strategy? [blocking: no]`
    const result = auditEngineeringSpec(spec)
    assertDeterministic(() => auditEngineeringSpec(spec))
    expect(result.findings.some(f => f.criterion === "OPEN_QUESTIONS")).toBe(true)
  })

  it("detects endpoints without auth specification", () => {
    const spec = `## API Contracts\n### GET /v1/users/me\nReturns the current user profile.\nResponse: { id: string, name: string }`
    const result = auditEngineeringSpec(spec)
    assertDeterministic(() => auditEngineeringSpec(spec))
    expect(result.findings.some(f => f.criterion === "ENDPOINT_AUTH")).toBe(true)
  })

  it("passes auth check when auth is specified", () => {
    const spec = `## API Contracts\n### GET /v1/users/me\nAuth required — Bearer token, role: authenticated_user\nResponse: { id: string, name: string }`
    const result = auditEngineeringSpec(spec)
    assertDeterministic(() => auditEngineeringSpec(spec))
    expect(result.findings.filter(f => f.criterion === "ENDPOINT_AUTH")).toHaveLength(0)
  })

  it("detects data model without field definitions", () => {
    const spec = `## Data Model\n### conversations\nStores conversation data.\nMigration: additive`
    const result = auditEngineeringSpec(spec)
    assertDeterministic(() => auditEngineeringSpec(spec))
    expect(result.findings.some(f => f.criterion === "DATA_MODEL")).toBe(true)
  })

  it("detects missing migration strategy", () => {
    const spec = `## Data Model\n### users\n- id: uuid\n- email: string`
    const result = auditEngineeringSpec(spec)
    assertDeterministic(() => auditEngineeringSpec(spec))
    expect(result.findings.some(f => f.criterion === "MIGRATION_STRATEGY")).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Hedge Detection
// ────────────────────────────────────────────────────────────────────────────────

describe("detectHedgeLanguage (@deterministic)", () => {
  it("returns empty for assertive responses", () => {
    const response = "I'll proceed with PostgreSQL for the data model. The session table uses a 60-minute TTL."
    expect(detectHedgeLanguage(response)).toEqual([])
    assertDeterministic(() => detectHedgeLanguage(response))
  })

  it("detects 'what would you like to focus on'", () => {
    const response = "There are several areas to address. What would you like to focus on first?"
    expect(detectHedgeLanguage(response).length).toBeGreaterThan(0)
    assertDeterministic(() => detectHedgeLanguage(response))
  })

  it("detects 'which option do you prefer'", () => {
    const response = "We could use Redis or Memcached. Which option do you prefer?"
    expect(detectHedgeLanguage(response).length).toBeGreaterThan(0)
  })

  it("does not flag legitimate escalation questions", () => {
    const response = "I found PM gaps. Say yes and I'll bring in the PM agent."
    expect(detectHedgeLanguage(response)).toEqual([])
  })

  it("does not flag approval requests", () => {
    const response = "The spec is ready. Say yes to confirm and approve."
    expect(detectHedgeLanguage(response)).toEqual([])
  })

  it("detects multiple hedge phrases", () => {
    const response = "What would you like to focus on? Should I proceed with option A, or what's your preference?"
    expect(detectHedgeLanguage(response).length).toBeGreaterThanOrEqual(2)
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Determinism contract — run against real spec fixture if available
// ────────────────────────────────────────────────────────────────────────────────

describe("determinism contract", () => {
  it("every audit function returns identical results on identical input", () => {
    const pmSpec = `## Acceptance Criteria\n- AC#1: Smooth login\n## Non-Goals\n- No desktop\n## Open Questions\n- Q [blocking: yes]`
    const designSpec = `## Screens\n### Screen 1: Home\nSubtle animation.\n## Open Questions\n- Q [blocking: no]`
    const engSpec = `## API Contracts\n### GET /v1/test\nReturns data\n## Data Model\n### users\nUser table\n## Open Questions\n(none)`

    // Each function must produce identical results across 3 runs
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(auditPmSpec(pmSpec))).toBe(JSON.stringify(auditPmSpec(pmSpec)))
      expect(JSON.stringify(auditDesignSpec(designSpec))).toBe(JSON.stringify(auditDesignSpec(designSpec)))
      expect(JSON.stringify(auditEngineeringSpec(engSpec))).toBe(JSON.stringify(auditEngineeringSpec(engSpec)))
    }
  })
})
