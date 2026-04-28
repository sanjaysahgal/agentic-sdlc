// Phase 5 / I7-extended — pure renderer for `show-hold-message` decisions.
//
// The router emits a `show-hold-message` decision carrying the structural
// fields (heldAgent, downstreamPhase, featureName, blockingQuestion). This
// renderer is the single place that turns those fields into Slack text.
//
// All labels are registry-derived (Principle 8 — platform enforcement, not
// prompt rules; Principle 11 — deterministic, same input = same output).
// Replaces the hardcoded "Design is paused — say yes to bring the PM into
// this thread" template at `interfaces/slack/handlers/message.ts:464`
// (FLAG-C, fixed Phase 5). Production wiring takes effect at Phase 4 cutover.
//
// The renderer is pure: no I/O, no clock, no randomness. It takes a decision
// (the data the router already assembled) and returns a string. Production
// callers post the string verbatim; tests assert against it directly.

import type { AgentId, FeaturePhase, RoutingDecision, SpecType } from "./types"
import { lookupAgent } from "./agent-registry"

// Subset of RoutingDecision narrowed to the kind we render. Exporting the
// narrowed shape keeps callers from having to widen-then-narrow at the call
// site.
export type ShowHoldMessageDecision = Extract<RoutingDecision, { kind: "show-hold-message" }>

export function renderHoldMessage(decision: ShowHoldMessageDecision): string {
  const downstreamLabel = phaseShortName(decision.downstreamPhase)
  const upstreamSpec    = upstreamSpecOf(decision.heldAgent)
  const heldRole        = lookupAgent(decision.heldAgent)?.shortName ?? decision.heldAgent
  const { count, items } = parseQuestionItems(decision.blockingQuestion)
  const noun     = count === 1 ? "item" : "items"
  const itemList = items.length > 1
    ? items.map((it, i) => `${i + 1}. ${it}`).join("\n")
    : `*"${items[0] ?? decision.blockingQuestion.trim()}"*`

  return [
    `${downstreamLabel} on \`${decision.featureName}\` is blocked by ${count} unresolved ${noun} in the ${upstreamSpec} spec:`,
    "",
    itemList,
    "",
    `Reply *yes* to have the ${heldRole} draft tightenings, or send your own corrections directly.`,
  ].join("\n")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Maps the GitHub-derived phase to the human-readable phase label used in the
// hold-message template. The phases that produce hold messages (per §8.3 / §8.5
// of the spec) are design-in-progress and engineering-in-progress; the rest are
// rendered for completeness so a future state machine extension never crashes
// the renderer.
export function phaseShortName(phase: FeaturePhase): string {
  switch (phase) {
    case "product-spec-in-progress":             return "Product"
    case "product-spec-approved-awaiting-design": return "Product"
    case "design-in-progress":                    return "Design"
    case "design-approved-awaiting-engineering":  return "Design"
    case "engineering-in-progress":               return "Engineering"
    case "complete":                              return "Feature"
  }
}

// The spec the held agent owns is the upstream spec that the escalation is
// blocked on. Inverse of route-feature-message.specOwner; reads straight from
// the registry so a new agent (Coder, Reviewer) gets correct labels by
// declaring `ownsSpec` in its registry entry — no renderer change needed.
export function upstreamSpecOf(agent: AgentId): SpecType | "<unknown>" {
  const entry = lookupAgent(agent)
  return entry?.ownsSpec ?? "<unknown>"
}

// pendingEscalation.question is normalized in conversation-store.setPendingEscalation
// to put each numbered item on its own line ("1. foo\n2. bar"). When the question
// is a single sentence, treat it as a single item so the count and pluralization
// stay accurate.
export function parseQuestionItems(question: string): { count: number; items: string[] } {
  const lines    = question.split("\n").map((l) => l.trim()).filter(Boolean)
  const numbered = lines.filter((l) => /^\d+\.\s/.test(l))
  if (numbered.length === 0) {
    const single = question.trim()
    return single ? { count: 1, items: [single] } : { count: 0, items: [] }
  }
  const items = numbered.map((l) => l.replace(/^\d+\.\s+/, "").trim()).filter(Boolean)
  return { count: items.length, items }
}
