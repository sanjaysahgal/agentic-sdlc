import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { auditPhaseCompletion, PM_RUBRIC, PM_DESIGN_READINESS_RUBRIC, DESIGN_RUBRIC, buildDesignRubric } from "../../runtime/phase-completion-auditor"

beforeEach(() => {
  mockCreate.mockReset()
})

describe("auditPhaseCompletion", () => {
  it("returns ready: true and empty findings when Sonnet responds PASS", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    const result = await auditPhaseCompletion({
      specContent: "# Feature Spec\n## Problem\nClear problem.",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("parses a single FINDING line into one finding", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "FINDING: Missing error path for user story 3 | Add error handling for network failure in ## Edge Cases" }],
    })

    const result = await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(false)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].issue).toBe("Missing error path for user story 3")
    expect(result.findings[0].recommendation).toBe("Add error handling for network failure in ## Edge Cases")
  })

  it("parses multiple FINDING lines into multiple findings", async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: "FINDING: Acceptance criterion 2 uses 'fast' without a baseline | Replace with '<200ms response time measured from tap to first render'\nFINDING: Non-Goals section is empty | Add at least one explicit scope exclusion, e.g. 'Does not support offline mode'",
      }],
    })

    const result = await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(false)
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0].issue).toContain("criterion 2")
    expect(result.findings[1].issue).toContain("Non-Goals")
  })

  it("returns ready: true on unexpected response format (fail-safe — does not block)", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot determine whether this spec is complete." }],
    })

    const result = await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "onboarding",
    })

    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("passes spec content as the user message", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    const specContent = "# My Feature Spec\n## Problem\nThis is the spec."
    await auditPhaseCompletion({ specContent, rubric: PM_RUBRIC, featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain(specContent)
  })

  it("injects the rubric string into the system prompt", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    const customRubric = "1. THE CUSTOM CRITERION — must be present and specific."
    await auditPhaseCompletion({ specContent: "spec", rubric: customRubric, featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("THE CUSTOM CRITERION")
  })

  it("uses claude-sonnet-4-6 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    )
  })

  it("trims leading and trailing whitespace from issue and recommendation", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "FINDING:  missing copy  |  add a button label  " }],
    })

    const result = await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    expect(result.findings[0].issue).toBe("missing copy")
    expect(result.findings[0].recommendation).toBe("add a button label")
  })

  it("skips a malformed FINDING line with no pipe delimiter — no crash, returns ready: true", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "FINDING: this line has no pipe delimiter at all" }],
    })

    const result = await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    expect(result.ready).toBe(true)
    expect(result.findings).toHaveLength(0)
  })

  it("includes productVision and systemArchitecture in the user message when provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({
      specContent: "spec",
      rubric: PM_RUBRIC,
      featureName: "test",
      productVision: "We build a health app.",
      systemArchitecture: "React Native, tRPC.",
    })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain("We build a health app.")
    expect(userMessage).toContain("React Native, tRPC.")
  })

  it("includes approvedProductSpec in the user message when provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({
      specContent: "spec",
      rubric: DESIGN_RUBRIC,
      featureName: "test",
      approvedProductSpec: "## Acceptance Criteria\n1. SSO sign-in via Google or Apple.",
    })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain("Approved Product Spec")
    expect(userMessage).toContain("SSO sign-in via Google or Apple")
  })

  it("does not include context section when productVision, systemArchitecture, and approvedProductSpec are absent", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).not.toContain("Product Vision")
    expect(userMessage).not.toContain("System Architecture")
    expect(userMessage).not.toContain("Approved Product Spec")
  })
})

describe("auditPhaseCompletion — FINDING fix instruction (producer test)", () => {
  // The system prompt instructs Sonnet to commit to a single specific fix —
  // no "or" alternatives, no "either/or". This test verifies the instruction
  // exists so users cannot receive "Fix: X or Y" in the action menu.
  it("system prompt instructs model to commit to one specific fix — no alternatives", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })

    await auditPhaseCompletion({ specContent: "spec", rubric: "criterion 1", featureName: "test" })

    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must prohibit alternatives explicitly
    expect(systemPrompt).toContain("no alternatives")
    expect(systemPrompt).toContain(`no "or"`)
    // Must require committing to one fix
    expect(systemPrompt).toContain("one specific fix")
  })
})

describe("PM_RUBRIC and DESIGN_RUBRIC exports", () => {
  it("PM_RUBRIC is exported as a non-empty string", () => {
    expect(typeof PM_RUBRIC).toBe("string")
    expect(PM_RUBRIC.length).toBeGreaterThan(0)
  })

  it("DESIGN_RUBRIC is exported as a non-empty string", () => {
    expect(typeof DESIGN_RUBRIC).toBe("string")
    expect(DESIGN_RUBRIC.length).toBeGreaterThan(0)
  })

  it("DESIGN_RUBRIC contains mobile and desktop form factors by default", () => {
    expect(DESIGN_RUBRIC).toContain("mobile")
    expect(DESIGN_RUBRIC).toContain("desktop")
  })
})

describe("buildDesignRubric — form factor injection", () => {
  it("injects custom form factors into criterion 9", () => {
    const rubric = buildDesignRubric(["mobile", "tablet", "desktop"])
    expect(rubric).toContain("mobile, tablet, desktop")
  })

  it("single form factor — mobile-only product skips desktop requirement", () => {
    const rubric = buildDesignRubric(["mobile"])
    expect(rubric).toContain("mobile")
    expect(rubric).not.toContain("desktop")
  })

  it("form factor criterion names an explicit Non-Goals exception path", () => {
    const rubric = buildDesignRubric(["mobile", "desktop"])
    expect(rubric).toContain("Non-Goals")
  })

  it("returns a non-empty string for any non-empty form factor list", () => {
    const rubric = buildDesignRubric(["mobile"])
    expect(typeof rubric).toBe("string")
    expect(rubric.length).toBeGreaterThan(0)
  })
})

// ─── auditPhaseCompletion — producer tests (system prompt format instructions) ─
//
// Producer-consumer chain rule: consumer tests (above) verify the gate parses FINDING/PASS
// correctly when given those strings. These producer tests verify the system prompt actually
// instructs the LLM to produce that format.

describe("auditPhaseCompletion — producer tests (system prompt contains format instruction)", () => {
  it("system prompt instructs Sonnet to output 'FINDING: <issue> | <recommendation>' per failing criterion", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })
    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("FINDING:")
    expect(systemPrompt).toContain("|")
  })

  it("system prompt instructs Sonnet to output exactly 'PASS' when all criteria pass", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })
    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("PASS")
  })

  it("system prompt instructs Sonnet to output no preamble — only FINDING lines or PASS", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "PASS" }] })
    await auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must explicitly forbid explanation/preamble — otherwise the FINDING: prefix match fails
    expect(systemPrompt.toLowerCase()).toMatch(/no preamble|only finding|output only/i)
  })
})

// ─── buildDesignRubric criterion 10 — producer test ──────────────────────────
//
// Criterion 10 was added to make the post-run N18 gate reachable: Haiku must tag
// unresolved product questions with "[type: product] [blocking: yes]" so the gate
// can detect and escalate them. This test verifies criterion 10 contains that instruction.

describe("buildDesignRubric criterion 10 — open-loop product assumption check", () => {
  // Criterion 10 must be an OPEN-LOOP check: compare design decisions against the product spec
  // context and flag assumptions without PM backing — NOT a closed-loop check that only finds
  // pre-tagged questions already written into the design spec.

  it("criterion 10 instructs Sonnet to compare against both Approved Product Spec and Product Vision", () => {
    const rubric = buildDesignRubric(["mobile", "desktop"])
    expect(rubric).toContain("10.")
    // Must name both context sources — the feature-level PM spec is the primary one
    expect(rubric).toContain("Approved Product Spec")
    expect(rubric).toContain("Product Vision")
  })

  it("criterion 10 PART B — scans PM spec for vague requirements that block design (handle gracefully, preserve)", () => {
    const rubric = buildDesignRubric(["mobile", "desktop"])
    // Must instruct scanning PM spec for vague language — the Slack test failure class
    expect(rubric.toLowerCase()).toMatch(/handle gracefully|preserve conversations|vague/)
    // Must cover the two-part structure: design assumptions AND pm spec vagueness
    expect(rubric).toContain("PART A")
    expect(rubric).toContain("PART B")
  })

  it("criterion 10 instructs Sonnet to output [PM-GAP] prefix per gap (not [type: product] — that tag was removed as root cause of escalation loop)", () => {
    const rubric = buildDesignRubric(["mobile", "desktop"])
    expect(rubric).toContain("[PM-GAP]")
    // [type: product] was removed — PM questions must never be written into the design spec
    expect(rubric).not.toContain("[type: product]")
  })

  it("criterion 10 identifies design assumptions without PM backing — not just pre-tagged questions", () => {
    const rubric = buildDesignRubric(["mobile", "desktop"])
    // Must mention "assumption" or "assumes" — open-loop detection of implicit product decisions
    expect(rubric.toLowerCase()).toMatch(/assum/)
  })

  it("criterion 10 is present in all buildDesignRubric outputs regardless of form factors", () => {
    const mobile = buildDesignRubric(["mobile"])
    const both = buildDesignRubric(["mobile", "desktop", "tablet"])
    expect(mobile).toContain("[PM-GAP]")
    expect(both).toContain("[PM-GAP]")
  })

  it("DESIGN_RUBRIC default export includes criterion 10 (regression guard)", () => {
    expect(DESIGN_RUBRIC).toContain("[PM-GAP]")
    expect(DESIGN_RUBRIC.toLowerCase()).toMatch(/assum/)
  })
})

// ─── buildDesignRubric criterion 11 — producer test ──────────────────────────
//
// Criterion 11 tells Haiku/Sonnet that ANY open question (blocking or non-blocking)
// in ## Open Questions is a finding. Test that both [blocking: yes] and [blocking: no]
// are named in the rubric text so the model knows both are violations.

describe("buildDesignRubric criterion 11 — no open questions (producer test)", () => {
  it("criterion 11 text contains both [blocking: yes] and [blocking: no]", () => {
    const rubric = buildDesignRubric(["mobile", "desktop"])
    expect(rubric).toContain("11.")
    // Both blocking values must be named — model must know non-blocking also blocks approval
    expect(rubric).toContain("[blocking: yes]")
    expect(rubric).toContain("[blocking: no]")
  })

  it("criterion 11 is present in all buildDesignRubric outputs regardless of form factors", () => {
    const mobile = buildDesignRubric(["mobile"])
    const both = buildDesignRubric(["mobile", "desktop", "tablet"])
    expect(mobile).toContain("11.")
    expect(both).toContain("11.")
  })

  it("DESIGN_RUBRIC default export includes criterion 11 (regression guard)", () => {
    expect(DESIGN_RUBRIC).toContain("11.")
  })
})

// ─── Network failure resilience — phase-completion-auditor ────────────────────
//
// phase-completion-auditor.ts already had maxRetries: 0; timeout was added.
// Verify errors propagate immediately with exactly one API call.

describe("auditPhaseCompletion — network failure propagates immediately, no retries", () => {
  it("propagates API error immediately — not swallowed to ready: true", async () => {
    mockCreate.mockRejectedValue(new Error("APITimeoutError: Request timed out"))
    await expect(auditPhaseCompletion({ specContent: "spec", rubric: PM_RUBRIC, featureName: "test" }))
      .rejects.toThrow()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

// ─── PM_DESIGN_READINESS_RUBRIC — producer tests ──────────────────────────────
//
// These tests verify the rubric instructs Sonnet to catch the specific classes of
// design-blocking vagueness that caused the production incident: vague sensory
// descriptors ("ambient") and missing concrete values (session TTL without a number).
// Producer-consumer chain rule: the gate blocks on FINDING lines; these tests verify
// the rubric actually instructs the model to produce FINDING lines for those classes.

describe("PM_DESIGN_READINESS_RUBRIC — export and format", () => {
  it("is exported as a non-empty string", () => {
    expect(typeof PM_DESIGN_READINESS_RUBRIC).toBe("string")
    expect(PM_DESIGN_READINESS_RUBRIC.length).toBeGreaterThan(0)
  })

  // Criterion 1: VAGUE LANGUAGE — covers original incident (ambient, TTL) plus recurring incident
  it("criterion 1 flags vague sensory descriptors — the 'ambient' and 'friendly' class", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("ambient")
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("soft")
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("subtle")
    // Second incident: "clear, friendly message" — "friendly" must be in the word list
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("friendly")
  })

  it("criterion 1 flags missing timing/threshold values — the session TTL class", () => {
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/ttl|timeout|session expiry/)
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/seconds|minutes/)
  })

  it("criterion 1 flags transition vagueness — the 'without visual disruption' class", () => {
    // Second incident: "transitions without visual disruption" — must catch this phrasing
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/without disruption|seamlessly transitions|without interruption/)
  })

  it("criterion 1 flags underspecified error UI — names modal/inline/toast/banner", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("handle gracefully")
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/modal|inline|toast|banner/)
  })

  // Criterion 2: INTERACTION COMPLETENESS — catches "what happens if user taps indicator"
  it("criterion 2 requires every interactive element to define its tap behavior", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("INTERACTION COMPLETENESS")
    // Must instruct checking for tap/press/interact behavior definition
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/tap|press|interact/)
    // Must flag elements without explicit interactivity specification
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/interactive or not/)
  })

  // Criterion 3: ERROR AND FAILURE RECOVERY — catches "account creation failure, no recovery path"
  it("criterion 3 requires every failure mode to have a recovery UX", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("ERROR AND FAILURE RECOVERY")
    // Must name recovery path types
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/retry|redirect|alternative/)
  })

  // Criterion 4: UI MODALITY — catches "inline or overlay for nudge, dismissible or not"
  it("criterion 4 requires modality, dismissibility, and persistence for notifications/nudges", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("UI MODALITY")
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/dismissib/)
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/inline|overlay|modal|banner|toast/)
    // Must require persistence definition
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/persist/)
  })

  // Criterion 5: LOADING AND TRANSITION STATES — catches "2-60 second auth resolution, no loading state"
  it("criterion 5 requires every async operation to define its loading treatment", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).toContain("LOADING AND TRANSITION STATES")
    // Must name loading treatments
    expect(PM_DESIGN_READINESS_RUBRIC.toLowerCase()).toMatch(/skeleton|spinner|progress/)
  })

  it("rubric does not use [PM-GAP] prefix — that is a design-agent-only tag", () => {
    expect(PM_DESIGN_READINESS_RUBRIC).not.toContain("[PM-GAP]")
  })
})
