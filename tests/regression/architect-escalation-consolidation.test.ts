import { describe, it, expect } from "vitest"
import {
  countPlatformGapItems,
  countAgentGapItems,
  formatPmGapNotice,
  formatDesignGapNotice,
  parsePmGapText,
  parseDesignGapText,
} from "../../runtime/upstream-notice-format"

// Regression test for B6 (architect-escalation consolidation gate).
//
// Bug surfaced 2026-04-30: auditPmSpec found N findings on the approved PM
// spec; the architect called offer_upstream_revision(target=pm) with a
// question that enumerated only 1 of those N. The remaining N-1 were silently
// dropped — caught later only by the deterministic re-audit safety net after
// a writeback, costing the user N round-trips for what should be one.
//
// Fix: post-run consolidation gate at message.ts compares
// countAgentGapItems(pendingEscalation.question) against
// countPlatformGapItems(parsePmGapText(upstreamNoticeArch)). When platform > agent,
// override pendingEscalation.question with the consolidated platform brief so
// every detected gap ships in the first escalation. Same logic mirrored for
// the design escalation target. Both branches fully deterministic per
// Principle 11 (no LLM in the gate path).
//
// Unit / structural coverage of the gate. The end-to-end behavior (architect
// run → tool call → gate override → pendingEscalation.question replaced) is
// covered by tests/integration/workflows.test.ts Scenario B6.

describe("bug #13 — architect escalation consolidation: drop-of-N gaps overridden by platform brief (manifest B6)", () => {
  const f = (issue: string, recommendation: string) => ({ issue, recommendation })

  it("count helpers detect the canonical drop-of-N case: platform finds 3 PM gaps, agent enumerates 1", () => {
    // The canonical Bug-B shape: deterministic auditor produces 3 findings →
    // formatted notice contains 3 `1. [PM]…`, `2. [PM]…`, `3. [PM]…` lines.
    // Agent calls offer_upstream_revision(pm) with a 1-item question.
    const findings = [
      f("AC#1 vague — smooth", "Replace with measurable timing"),
      f("AC#2 vague timing — quickly", "Specify duration in seconds"),
      f("AC#3 vague error — handled", "Specify UI treatment"),
    ]
    const platformBrief = parsePmGapText(formatPmGapNotice(findings))!
    const agentQuestion = "1. AC#1 needs tightening — please clarify timing"

    expect(countPlatformGapItems(platformBrief)).toBe(3)
    expect(countAgentGapItems(agentQuestion)).toBe(1)
    // Trigger condition for the gate
    expect(countAgentGapItems(agentQuestion) < countPlatformGapItems(platformBrief)).toBe(true)
  })

  it("count helpers do NOT trigger when the agent enumerates ALL platform-detected gaps", () => {
    const findings = [
      f("AC#1 vague — smooth", "Replace with measurable timing"),
      f("AC#2 vague timing — quickly", "Specify duration in seconds"),
    ]
    const platformBrief = parsePmGapText(formatPmGapNotice(findings))!
    const faithfulAgentQuestion = "1. AC#1 vague language\n2. AC#2 timing not numeric"

    expect(countPlatformGapItems(platformBrief)).toBe(2)
    expect(countAgentGapItems(faithfulAgentQuestion)).toBe(2)
    // Gate must NOT fire — counts are equal
    expect(countAgentGapItems(faithfulAgentQuestion) < countPlatformGapItems(platformBrief)).toBe(false)
  })

  it("count helpers symmetric for the design target: 4 platform gaps, agent enumerates 2 → override condition holds", () => {
    const findings = [
      f("Sign-up screen unspecified", "Add Sign-up entry"),
      f("Error states missing", "Add inline error treatment"),
      f("Animation timing TBD", "Specify ms + easing"),
      f("Form factor coverage incomplete", "Add desktop layout"),
    ]
    const platformBrief = parseDesignGapText(formatDesignGapNotice(findings))!
    const agentQuestion = "1. Sign-up screen needs a spec\n2. Error states need treatment"

    expect(countPlatformGapItems(platformBrief)).toBe(4)
    expect(countAgentGapItems(agentQuestion)).toBe(2)
    expect(countAgentGapItems(agentQuestion) < countPlatformGapItems(platformBrief)).toBe(true)
  })

  it("count helpers are deterministic — same input always returns same count (Principle 11)", () => {
    const findings = [f("a", "1"), f("b", "2"), f("c", "3")]
    const brief = parsePmGapText(formatPmGapNotice(findings))!
    const agent = "1. one\n2. two"

    expect(countPlatformGapItems(brief)).toBe(countPlatformGapItems(brief))
    expect(countAgentGapItems(agent)).toBe(countAgentGapItems(agent))
  })

  it("structural assertion: B6 gate is wired at the architect post-run site in interfaces/slack/handlers/message.ts", async () => {
    // Per Principle 7 (zero human errors of omission), the consolidation gate
    // must actually be called in the architect post-run path. Assert the
    // imports + the branch-specific marker comment are present.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    // Import: countPlatformGapItems and countAgentGapItems must be imported from
    // the canonical upstream-notice-format module.
    expect(source).toMatch(/countPlatformGapItems/)
    expect(source).toMatch(/countAgentGapItems/)

    // Gate fires under the [ESCALATION-GATE] B6 marker so operators can grep logs.
    expect(source).toMatch(/\[ESCALATION-GATE\] B6:/)

    // Both targets covered (PM and design) per Principle 15 cross-agent parity.
    expect(source).toMatch(/PM escalation enumerated/)
    expect(source).toMatch(/design escalation enumerated/)
  })
})
