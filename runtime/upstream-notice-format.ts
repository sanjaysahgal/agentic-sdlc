// Block B2 — shared upstream-notice format.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// (Block B2, cross-agent contract tests), the architect's upstream-notice
// text was previously a fragile producer/consumer contract: the producer
// (interfaces/slack/handlers/message.ts:2895) built strings like
// `APPROVED PM SPEC — N GAP[S]:\n...` and three independent consumer
// regexes (lines 3131, 3144, 3158, 3166) parsed them. If either side
// changed the format string without the other, the consumer would
// silently produce empty or malformed parses — exactly the bug class
// the system-wide plan is designed to retire.
//
// This module is the single source of truth for the format. Producer
// and consumer both go through these helpers; the round-trip is
// structurally guaranteed. The contract test
// `tests/invariants/upstream-notice-contract.test.ts` exercises the
// round-trip on every shape of input.
//
// DESIGN-REVIEWED: shared-format-module per Principle 12. (1) Scales:
// pure functions, no I/O, no LLM, O(N) in finding count. (2) Owned by
// this module exclusively; producer + consumer in `message.ts` import
// from here. (3) Cross-cutting: the same producer/consumer split exists
// for designer→PM and architect→design escalations; future agents that
// need similar upstream notices reuse these helpers, never duplicate
// the format string.

export type Finding = {
  readonly issue:          string
  readonly recommendation: string
}

// ── Format constants — single source of truth ────────────────────────────────

// These constants are the contract. Changing any of them must be paired
// with updating the producer + consumer + the contract test in lockstep.
// The test asserts that the producer's output parses correctly with the
// consumer's regex — a structural round-trip gate.
const PM_LABEL     = "APPROVED PM SPEC"
const DESIGN_LABEL = "APPROVED DESIGN SPEC"

// ── Producer ─────────────────────────────────────────────────────────────────

// Builds a single labeled block of findings. Used by the architect upstream-
// notice producer. The plural inflection is preserved from the legacy
// implementation (singular for 1 finding, plural otherwise).
function pluralize(label: string, count: number): string {
  return count === 1 ? `${label}` : `${label}S`
}

export function formatPmGapNotice(findings: readonly Finding[]): string {
  if (findings.length === 0) return ""
  const lines = findings.map((f, i) => `${i + 1}. [PM] ${f.issue} — ${f.recommendation}`).join("\n")
  return `${PM_LABEL} — ${findings.length} ${pluralize("GAP", findings.length)}:\n${lines}`
}

export function formatDesignGapNotice(findings: readonly Finding[]): string {
  if (findings.length === 0) return ""
  const lines = findings.map((f, i) => `${i + 1}. [Design] ${f.issue} — ${f.recommendation}`).join("\n")
  return `${DESIGN_LABEL} — ${findings.length} ${pluralize("GAP", findings.length)}:\n${lines}`
}

// ── Consumer ─────────────────────────────────────────────────────────────────

// Detection helpers — `true` when the notice contains a labeled block.
export function hasPmGaps(notice: string): boolean {
  return notice.includes(PM_LABEL)
}

export function hasDesignGaps(notice: string): boolean {
  return notice.includes(DESIGN_LABEL)
}

// Extract the body of a labeled block (the line list after the header).
// Returns null when the label is absent or the block is malformed.
//
// Lookahead semantics: PM block runs from `APPROVED PM SPEC — N GAP[S]:\n`
// up to (but not including) the start of `APPROVED DESIGN SPEC` or end of
// notice. Design block runs from its label to end of notice. This matches
// the legacy regex behavior exactly so the round-trip passes against any
// existing operator-saved notice.
const PM_BODY_RE     = new RegExp(`${PM_LABEL} — \\d+ GAPS?:\\n([\\s\\S]*?)(?=${DESIGN_LABEL}|$)`)
const DESIGN_BODY_RE = new RegExp(`${DESIGN_LABEL} — \\d+ GAPS?:\\n([\\s\\S]*?)$`)

export function parsePmGapText(notice: string): string | null {
  const m = notice.match(PM_BODY_RE)
  return m?.[1]?.trim() ?? null
}

export function parseDesignGapText(notice: string): string | null {
  const m = notice.match(DESIGN_BODY_RE)
  return m?.[1]?.trim() ?? null
}

// ── Gap-count helpers (B6 — architect-escalation consolidation gate) ─────────
//
// `countPlatformGapItems` matches the strict producer format (`N. [PM] …` or
// `N. [Design] …`) — used to count gaps in a parsed body. This is the
// platform's source-of-truth count of deterministic findings.
//
// `countAgentGapItems` matches a generic numbered list item (`N. …`) anywhere
// in free-form prose — used to count how many distinct items the architect
// enumerated when calling `offer_upstream_revision(question="…")`. The agent
// rewords the platform brief, so a strict label match is too restrictive;
// any numbered item counts as one enumerated gap.
//
// Both are pure deterministic counters per Principle 11.

export function countPlatformGapItems(parsedBody: string): number {
  return (parsedBody.match(/^\d+\.\s+\[(?:PM|Design)\]\s/gm) ?? []).length
}

export function countAgentGapItems(text: string): number {
  return (text.match(/^\s*\d+\.\s+\S/gm) ?? []).length
}
