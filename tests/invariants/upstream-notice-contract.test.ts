// Block B2 — cross-agent contract test: upstream-notice format.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// (Block B2, cross-agent contract tests). The architect's upstream-notice
// text was previously a fragile producer/consumer contract: producer
// built `APPROVED PM SPEC — N GAP[S]:\n...` strings inline; three
// independent consumer regexes parsed them. If the producer or any
// consumer drifted, the other side broke silently — the same bug class
// the system-wide plan retires.
//
// Block B2 extracted the format into `runtime/upstream-notice-format.ts`
// so producer and consumer share constants. This contract test is the
// permanent gate: round-trip every shape (empty, single, multiple, both
// PM and design, only design, etc.) and assert the consumer parses what
// the producer emitted. If either side drifts (e.g. someone changes the
// label string in the format module), tests here fail — not Slack.

import { describe, it, expect } from "vitest"
import {
  formatPmGapNotice,
  formatDesignGapNotice,
  hasPmGaps,
  hasDesignGaps,
  parsePmGapText,
  parseDesignGapText,
  countPlatformGapItems,
  countAgentGapItems,
  type Finding,
} from "../../runtime/upstream-notice-format"

const f = (issue: string, recommendation: string): Finding => ({ issue, recommendation })

describe("upstream-notice-format — producer fundamentals", () => {
  it("formatPmGapNotice empty findings → empty string", () => {
    expect(formatPmGapNotice([])).toBe("")
  })

  it("formatDesignGapNotice empty findings → empty string", () => {
    expect(formatDesignGapNotice([])).toBe("")
  })

  it("formatPmGapNotice single finding → singular GAP (not GAPS)", () => {
    const out = formatPmGapNotice([f("vague timing", "specify ms")])
    expect(out).toContain("APPROVED PM SPEC — 1 GAP:")
    expect(out).not.toContain("1 GAPS")
  })

  it("formatPmGapNotice multiple findings → plural GAPS with N", () => {
    const out = formatPmGapNotice([
      f("vague timing", "specify ms"),
      f("ambiguous AC#3", "rephrase"),
      f("missing UI copy", "add"),
    ])
    expect(out).toContain("APPROVED PM SPEC — 3 GAPS:")
  })

  it("formatPmGapNotice findings tagged [PM]; numbered list with em-dash", () => {
    const out = formatPmGapNotice([f("issue-a", "rec-a"), f("issue-b", "rec-b")])
    expect(out).toContain("1. [PM] issue-a — rec-a")
    expect(out).toContain("2. [PM] issue-b — rec-b")
  })

  it("formatDesignGapNotice findings tagged [Design]", () => {
    const out = formatDesignGapNotice([f("brand-drift", "use --muted")])
    expect(out).toContain("1. [Design] brand-drift — use --muted")
    expect(out).toContain("APPROVED DESIGN SPEC — 1 GAP:")
  })
})

describe("upstream-notice-format — consumer fundamentals", () => {
  it("hasPmGaps detects the PM label", () => {
    expect(hasPmGaps("APPROVED PM SPEC — 2 GAPS:\n1. [PM] x — y")).toBe(true)
    expect(hasPmGaps("nothing here")).toBe(false)
  })

  it("hasDesignGaps detects the design label", () => {
    expect(hasDesignGaps("APPROVED DESIGN SPEC — 1 GAP:\n1. [Design] a — b")).toBe(true)
    expect(hasDesignGaps("APPROVED PM SPEC — 1 GAP:\n1. [PM] x — y")).toBe(false)
  })

  it("parsePmGapText returns null on missing label", () => {
    expect(parsePmGapText("nothing here")).toBeNull()
  })

  it("parseDesignGapText returns null on missing label", () => {
    expect(parseDesignGapText("APPROVED PM SPEC — 1 GAP:\nx")).toBeNull()
  })
})

// ── Round-trip tests — the load-bearing contract gate ────────────────────────

describe("upstream-notice-format — producer/consumer round-trip", () => {
  it("PM-only notice: producer output parses with PM consumer; design consumer reports null", () => {
    const findings = [f("vague timing", "specify ms"), f("ambiguous AC#3", "rephrase")]
    const notice = formatPmGapNotice(findings)
    expect(hasPmGaps(notice)).toBe(true)
    expect(hasDesignGaps(notice)).toBe(false)

    const body = parsePmGapText(notice)
    expect(body).not.toBeNull()
    expect(body).toContain("1. [PM] vague timing — specify ms")
    expect(body).toContain("2. [PM] ambiguous AC#3 — rephrase")

    expect(parseDesignGapText(notice)).toBeNull()
  })

  it("design-only notice: design consumer extracts body; PM consumer reports null", () => {
    const findings = [f("brand-drift", "use --muted")]
    const notice = formatDesignGapNotice(findings)
    expect(hasPmGaps(notice)).toBe(false)
    expect(hasDesignGaps(notice)).toBe(true)

    const body = parseDesignGapText(notice)
    expect(body).toContain("1. [Design] brand-drift — use --muted")
    expect(parsePmGapText(notice)).toBeNull()
  })

  it("combined PM+design notice: both consumers extract their respective blocks; PM body excludes design block (lookahead)", () => {
    const pmFindings     = [f("pm-issue-1", "pm-rec-1"), f("pm-issue-2", "pm-rec-2")]
    const designFindings = [f("design-issue-1", "design-rec-1")]
    const notice = `${formatPmGapNotice(pmFindings)}\n\n${formatDesignGapNotice(designFindings)}`

    expect(hasPmGaps(notice)).toBe(true)
    expect(hasDesignGaps(notice)).toBe(true)

    const pmBody = parsePmGapText(notice)
    expect(pmBody).toContain("1. [PM] pm-issue-1 — pm-rec-1")
    expect(pmBody).toContain("2. [PM] pm-issue-2 — pm-rec-2")
    expect(pmBody).not.toContain("[Design]")          // lookahead must stop before the design block
    expect(pmBody).not.toContain("APPROVED DESIGN")    // header itself must not leak

    const designBody = parseDesignGapText(notice)
    expect(designBody).toContain("1. [Design] design-issue-1 — design-rec-1")
    expect(designBody).not.toContain("[PM]")
  })

  it("singular form round-trips — '1 GAP' (not '1 GAPS') is detected and parsed", () => {
    const notice = formatPmGapNotice([f("only-one", "fix-it")])
    expect(notice).toContain("1 GAP:")
    expect(notice).not.toContain("1 GAPS")
    expect(hasPmGaps(notice)).toBe(true)
    expect(parsePmGapText(notice)).toContain("1. [PM] only-one — fix-it")
  })

  it("plural form round-trips — '7 GAPS' detected and parsed", () => {
    const findings = Array.from({ length: 7 }, (_, i) => f(`issue-${i + 1}`, `rec-${i + 1}`))
    const notice = formatPmGapNotice(findings)
    expect(notice).toContain("7 GAPS:")
    expect(parsePmGapText(notice)).toContain("7. [PM] issue-7 — rec-7")
  })

  it("findings with em-dash inside issue text don't confuse the consumer (em-dash is part of producer separator)", () => {
    // Em-dash already appears as separator; producer uses `—` (U+2014).
    // If a finding's issue contains its own em-dash, the consumer must still
    // parse the full block correctly because parsing is line-based, not
    // separator-based.
    const findings = [f("ambiguous — vague phrase", "rephrase to specifics")]
    const notice = formatPmGapNotice(findings)
    const body = parsePmGapText(notice)
    expect(body).toContain("1. [PM] ambiguous — vague phrase — rephrase to specifics")
  })
})

// ── Drift-detection: the labels are constants; if they change, EVERY consumer
// must change too. This test pins them so changes are deliberate.
describe("upstream-notice-format — label constants are pinned (drift detection)", () => {
  it("PM label literal is exactly 'APPROVED PM SPEC' (changing this breaks every consumer)", () => {
    expect(formatPmGapNotice([f("a", "b")])).toMatch(/^APPROVED PM SPEC —/)
  })

  it("Design label literal is exactly 'APPROVED DESIGN SPEC'", () => {
    expect(formatDesignGapNotice([f("a", "b")])).toMatch(/^APPROVED DESIGN SPEC —/)
  })

  it("Header separator is em-dash (U+2014), not hyphen (U+002D) — changing breaks consumer regex", () => {
    const out = formatPmGapNotice([f("a", "b")])
    expect(out).toContain("—")  // em-dash literal
  })
})

// ── B6 (architect-escalation consolidation gate) — gap-count helpers ────────
describe("upstream-notice-format — gap-count helpers (B6)", () => {
  it("countPlatformGapItems counts each `N. [PM] …` line in a parsed body", () => {
    const findings = [f("issue 1", "rec 1"), f("issue 2", "rec 2"), f("issue 3", "rec 3")]
    const body = parsePmGapText(formatPmGapNotice(findings))!
    expect(countPlatformGapItems(body)).toBe(3)
  })

  it("countPlatformGapItems counts each `N. [Design] …` line in a design body", () => {
    const findings = [f("d1", "r1"), f("d2", "r2")]
    const body = parseDesignGapText(formatDesignGapNotice(findings))!
    expect(countPlatformGapItems(body)).toBe(2)
  })

  it("countPlatformGapItems returns 0 on free-form prose (no label markers)", () => {
    expect(countPlatformGapItems("Just a free-form sentence with no markers.")).toBe(0)
  })

  it("countAgentGapItems counts numbered list items in agent prose (rewording allowed)", () => {
    const agentText = "1. AC#1 needs clarification on timing\n2. The error path for AC#3 is missing\n3. Non-Goals section is empty"
    expect(countAgentGapItems(agentText)).toBe(3)
  })

  it("countAgentGapItems returns 1 when the agent enumerated only one of N platform-detected gaps (B6 trigger condition)", () => {
    const agentText = "1. AC#1 needs clarification on timing — please tighten."
    expect(countAgentGapItems(agentText)).toBe(1)
  })

  it("countAgentGapItems returns 0 when the agent wrote prose without enumeration", () => {
    const agentText = "AC#1 needs tightening and the error path for AC#3 is missing."
    expect(countAgentGapItems(agentText)).toBe(0)
  })

  it("countAgentGapItems is tolerant of leading whitespace (architect prose often indents)", () => {
    const agentText = "  1. first item\n  2. second item"
    expect(countAgentGapItems(agentText)).toBe(2)
  })

  it("determinism (Principle 11): same input always returns same count", () => {
    const text = "1. one\n2. two\n3. three"
    expect(countAgentGapItems(text)).toBe(countAgentGapItems(text))
    expect(countPlatformGapItems("1. [PM] x — y\n2. [PM] a — b")).toBe(countPlatformGapItems("1. [PM] x — y\n2. [PM] a — b"))
  })
})
