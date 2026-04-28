// Phase 5 / I21 — orientation-on-resume enforcement.
//
// When PM, Designer, or Architect runs in escalation-engaged mode (after a
// `run-escalation-confirmed` or `resume-after-escalation` decision), the
// response MUST lead with a one-paragraph orientation block before the
// substantive recommendations. This is platform-enforced, not prompt-rule-
// dependent (Principle 8): the model can ignore prompt instructions, but the
// platform reads the response, structurally verifies the required elements
// are present, and re-runs with an enforcement override if any are missing.
//
// Same enforcement pattern as `enforceOpinionatedRecommendations` in
// `runtime/spec-auditor.ts`: pure detector + override builder + orchestrator
// loop. Per Principle 8a (verify presence of required output, never detect
// absence by matching bad text), the detector counts the orientation
// elements that ARE present, not the bad-voice phrases that aren't.
//
// Wiring lands at Phase 4 cutover. This module exposes the primitives so the
// production agent runners can call `enforceOrientationOnResume` around any
// `run-escalation-confirmed` or `resume-after-escalation` invocation.

import type { AgentId, FeaturePhase, SpecType } from "./routing/types"
import { lookupAgent } from "./routing/agent-registry"
import { phaseShortName } from "./routing/hold-message-renderer"

// ── Public types ──────────────────────────────────────────────────────────────

export type OrientationContext = {
  // The agent that was held / is now resuming. Receives the brief; produces
  // the response we're enforcing.
  readonly targetAgent:       AgentId

  // The downstream agent that escalated. Named in the orientation paragraph
  // so the user knows who flagged what.
  readonly originAgent:       AgentId

  // Quoted in the orientation paragraph to anchor the message.
  readonly featureName:       string

  // The phase the originAgent was running when the escalation fired. Renders
  // as "during <Engineering|Design|...>, the <originAgent> flagged N items".
  readonly downstreamPhase:   FeaturePhase

  // The spec the targetAgent owns — the spec this orientation is about. The
  // template phrasing is "the <upstreamSpecType> spec for `<feature>` is
  // approved on main". Derived from the targetAgent's `ownsSpec` registry
  // field at the call site (we accept it as an input so this module stays
  // pure and registry-independent for testing).
  readonly upstreamSpecType:  SpecType

  // Markdown link target for the upstream spec — required so the user can
  // jump to the source from the orientation paragraph. The detector
  // structurally checks for the presence of any markdown link in the
  // orientation paragraph; the directive recommends the spec path here.
  readonly upstreamSpecPath:  string

  // Count of items the originAgent flagged. The detector structurally checks
  // that this digit appears in the orientation paragraph (it's the only way
  // the user can sanity-check the engagement scope).
  readonly itemCount:         number
}

export type OrientationCheck = {
  readonly ok: boolean
  // Each missing element is a short reason string useful in error logs and
  // in the override directive. Order is stable (insertion order); same input
  // always produces the same list (Principle 11).
  readonly missing: readonly string[]
}

export type OrientationEnforcementResult = {
  readonly response:    string
  readonly reRanCount:  number
  readonly finalCheck:  OrientationCheck
}

// ── Detector — the structural gate ────────────────────────────────────────────

const ORIENTATION_PREFIX = "*Orientation:*"

// Mode-statement vocabulary. The detector requires the orientation paragraph
// to contain at least one of these stems, so the agent declares HOW it's
// participating (escalation-engaged, consulting on, reviewing, etc.) rather
// than launching straight into recommendations. Stems chosen to admit any
// natural phrasing the model might produce.
const MODE_STEMS = ["engag", "escalat", "consult", "review", "respond"]

// First-person voice markers. Principle 8a: we check for PRESENCE of correct
// voice (the agent identifies itself as the actor) rather than the absence
// of bad voice ("you're being engaged" passive). Word-boundary anchors so
// "Iceland" doesn't false-match "I".
const FIRST_PERSON_RE = /\b(I|I'm|I'll|I've|my)\b/

// Markdown link `[text](url)` — used both in the orientation block and in
// the post-orientation body. The detector requires at least one inside the
// orientation paragraph specifically.
const MARKDOWN_LINK_RE = /\[[^\]]+\]\([^)]+\)/

export function detectOrientationBlock(response: string, ctx: OrientationContext): OrientationCheck {
  const missing: string[] = []

  const trimmed = response.trimStart()
  if (!trimmed.startsWith(ORIENTATION_PREFIX)) {
    missing.push(`missing leading '${ORIENTATION_PREFIX}' marker`)
  }

  // The orientation paragraph runs from the start of the response to the
  // first blank line. Anything past that is the substantive body. We
  // tolerate a missing prefix but still scan the first paragraph for
  // content — a response with the right shape but wrong header is still
  // closer to compliant than one with neither.
  const paragraph = trimmed.split(/\n\s*\n/)[0] ?? ""

  if (!paragraph.includes(`\`${ctx.featureName}\``)) {
    missing.push(`feature name not backticked in orientation: \`${ctx.featureName}\``)
  }

  const originShort = lookupAgent(ctx.originAgent)?.shortName ?? ctx.originAgent
  if (!new RegExp(`\\b${escapeRegExp(originShort)}\\b`, "i").test(paragraph)) {
    missing.push(`originAgent role not named in orientation: ${originShort}`)
  }

  if (!new RegExp(`\\b${ctx.itemCount}\\b`).test(paragraph)) {
    missing.push(`item count not stated in orientation: ${ctx.itemCount}`)
  }

  if (!MARKDOWN_LINK_RE.test(paragraph)) {
    missing.push("no markdown spec link in orientation")
  }

  const lower = paragraph.toLowerCase()
  if (!MODE_STEMS.some((stem) => lower.includes(stem))) {
    missing.push(`no mode statement (one of: ${MODE_STEMS.join(", ")})`)
  }

  if (!FIRST_PERSON_RE.test(paragraph)) {
    missing.push("no first-person voice (I / I'm / I'll / I've / my)")
  }

  return { ok: missing.length === 0, missing }
}

// ── Override directive — re-run with this prepended to the system message ─────

export function buildOrientationOverride(ctx: OrientationContext, check?: OrientationCheck): string {
  const originShort  = lookupAgent(ctx.originAgent)?.shortName  ?? ctx.originAgent
  const targetShort  = lookupAgent(ctx.targetAgent)?.shortName  ?? ctx.targetAgent
  const phaseLabel   = phaseShortName(ctx.downstreamPhase)
  const itemNoun     = ctx.itemCount === 1 ? "item" : "items"
  const missingList  = check?.missing.length
    ? `\n\nYour previous response was missing: ${check.missing.map((m) => `\n  - ${m}`).join("")}`
    : ""

  return [
    `[PLATFORM OVERRIDE — orientation-on-resume / I21]`,
    ``,
    `You are the ${targetShort}, just resumed after the ${originShort} flagged ${ctx.itemCount} ${itemNoun}`,
    `in the ${ctx.upstreamSpecType} spec for \`${ctx.featureName}\` during the ${phaseLabel} phase.`,
    ``,
    `Your response MUST begin with a one-paragraph orientation block in this exact shape:`,
    ``,
    `${ORIENTATION_PREFIX} The ${ctx.upstreamSpecType} spec for \`${ctx.featureName}\` is approved on main`,
    `([link](${ctx.upstreamSpecPath})). During ${phaseLabel}, the ${originShort} ran the upstream-spec`,
    `audit and flagged ${ctx.itemCount} ${itemNoun}. I'm in escalation-engaged mode — reviewing those`,
    `items and proposing tightenings.`,
    ``,
    `Then a blank line, then your substantive recommendations.`,
    ``,
    `Voice rules (non-negotiable):`,
    `- First-person agent ("I'm reviewing", "my recommendation", "I'll draft").`,
    `- Second-person user ("you", "your call").`,
    `- No passive constructions like "you're being engaged" — the engagement is implicit.`,
    ``,
    `Required structural elements (the platform verifies these are present):`,
    `1. Leading "${ORIENTATION_PREFIX}" marker.`,
    `2. Backticked feature name: \`${ctx.featureName}\`.`,
    `3. The ${originShort} named explicitly.`,
    `4. The exact item count (${ctx.itemCount}) stated as a digit.`,
    `5. A markdown link, e.g. [link](${ctx.upstreamSpecPath}).`,
    `6. A mode statement using one of: ${MODE_STEMS.join(", ")}.`,
    `7. At least one first-person pronoun (I / I'm / I'll / I've / my).${missingList}`,
  ].join("\n")
}

// ── Orchestrator — the gate that wraps any agent runner ───────────────────────
//
// Production callers pass a `runFn` that invokes the agent (with the optional
// override prepended to the system message). The orchestrator runs at most
// `maxRetries + 1` times: one initial run, plus up to `maxRetries` re-runs
// with progressively more aggressive overrides. Default `maxRetries: 1` —
// one cheap retry is enough to fix prompt-drift; more is rarely useful and
// wastes tokens.
//
// Returns the final response (compliant or last-attempt-still-bad), the
// re-run count, and the final detector check. Production decides what to do
// when `finalCheck.ok === false` after exhausting retries (log + post the
// best-effort response is the current default). Tests assert on all three
// fields directly.

export async function enforceOrientationOnResume(
  runFn: (override: string | null) => Promise<string>,
  ctx:   OrientationContext,
  options?: { maxRetries?: number },
): Promise<OrientationEnforcementResult> {
  const maxRetries = options?.maxRetries ?? 1

  let response = await runFn(null)
  let check    = detectOrientationBlock(response, ctx)
  let reRanCount = 0

  while (!check.ok && reRanCount < maxRetries) {
    const directive = buildOrientationOverride(ctx, check)
    response = await runFn(directive)
    check    = detectOrientationBlock(response, ctx)
    reRanCount++
  }

  return { response, reRanCount, finalCheck: check }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
