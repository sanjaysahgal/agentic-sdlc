// Phase 5 wart fix — architect / designer readiness directive builder.
//
// Closes the "system says X but X isn't true" gap surfaced by manual testing
// 2026-04-27 (BACKLOG: "Architect readiness messaging must reflect full
// upstream chain state — P14/P15 enforcement gap"):
//
//   Turn A `/architect hi`:           "✅ Nothing blocking — you can review and approve when ready."
//   Turn B `Hi, I want to work...`:   "Architect. 4 PM-scope gaps and 41 design-scope gaps that need resolution..."
//
// Same state, same agent, same mode, different responses. Principle 11
// violation (non-determinism), Principle 14 violation (Turn A doesn't
// surface upstream chain), Principle 15 violation (analogous-path parity
// broken within the same agent).
//
// The fix: the readiness state is **assembled deterministically before the
// agent runs** and injected as a structural directive that names the exact
// counts the agent must surface, by source, in its response. The agent's
// LLM cannot accidentally minimize the report based on user phrasing
// because the directive specifies the verbatim line.
//
// This module is pure (no I/O, no clock, no randomness). The wiring in
// `interfaces/slack/handlers/message.ts` reads spec content, runs audits,
// reads escalation state, and passes the structured input to
// `buildReadinessReport`. Tests pin every state combination.
//
// Cross-agent parity (Principle 15): the same builder is called from both
// the architect path and the designer path. Designer's "upstream" is
// `[pm]`; architect's is `[pm, design]`. PM has no upstream, so PM does
// not call this builder.

import type { AgentId, SpecType } from "./routing/types"
import { lookupAgent } from "./routing/agent-registry"

// ── Public types ──────────────────────────────────────────────────────────────

export type ReadinessAuditSource = {
  // Which agent's audit produced these findings. Architect's
  // `auditDesignSpec` and the designer's own `auditDesignSpec` can produce
  // different counts on the same spec (architect catches engineering-
  // readiness gaps that designer wouldn't); labeling by source lets the
  // agent's response explain the split honestly.
  readonly auditingAgent: AgentId
  // The spec being audited.
  readonly specType:      SpecType
  // Count of findings; the directive names this count verbatim.
  readonly findingCount:  number
  // Optional formatted findings list (each line "1. issue — recommendation").
  // Surfaced verbatim to the agent so it can describe specific items
  // without re-deriving them.
  readonly findingLines?: string
}

export type ActiveEscalation = {
  readonly targetAgent: AgentId
  readonly originAgent: AgentId
  readonly itemCount:   number
  // Optional one-line summary the agent can echo ("PM is engaged on 4
  // findings — see thread above").
  readonly summary?:    string
}

export type ReadinessReportInput = {
  // The agent currently running (the one whose readiness is being
  // assessed). Architect when invoked at engineering phase, Designer at
  // design phase. The directive frames the readiness from this agent's
  // perspective.
  readonly callingAgent: AgentId

  // The spec the calling agent owns and is preparing to hand off. Status
  // = "ready" (own audit clean), "dirty" (own audit found gaps), or
  // "missing" (no draft yet).
  readonly ownSpec: {
    readonly specType:     SpecType
    readonly status:       "ready" | "dirty" | "missing"
    readonly findingCount: number
    readonly findingLines?: string
  }

  // Audits the calling agent ran against upstream specs. For architect:
  // [pm, design]. For designer: [pm]. Each entry is one spec audited by
  // one agent. The architect may run BOTH `auditDesignSpec` (designer's
  // perspective, copied) AND its own engineering-readiness check on the
  // design spec — both go in here as separate sources so the directive
  // can label the split.
  readonly upstreamAudits: readonly ReadinessAuditSource[]

  // The active escalation, if any, currently held in
  // `pendingEscalation` or `escalationNotification` for this feature. If
  // set, the directive surfaces it as the next user-visible step.
  readonly activeEscalation: ActiveEscalation | null

  // Feature name — quoted in the directive. Required so the report is
  // self-anchored (matches the orientation requirement from I21).
  readonly featureName: string
}

export type ReadinessReport = {
  // Aggregate state — the agent's response prose can switch on this.
  readonly aggregate: "ready" | "dirty-own" | "dirty-upstream" | "escalation-active" | "ready-pending-approval"

  // Total findings across every source (own + upstream).
  readonly totalFindingCount: number

  // The structural directive the agent receives in its system / user-
  // message context. The directive prescribes the EXACT readiness summary
  // line the agent must report. Whitespace + numbers are surfaced
  // verbatim per Principle 11.
  readonly directive: string
}

// ── Public function ──────────────────────────────────────────────────────────

export function buildReadinessReport(input: ReadinessReportInput): ReadinessReport {
  const totalFindingCount =
    input.ownSpec.findingCount + input.upstreamAudits.reduce((sum, a) => sum + a.findingCount, 0)

  const aggregate: ReadinessReport["aggregate"] = (() => {
    if (input.activeEscalation) return "escalation-active"
    if (input.ownSpec.status === "dirty") return "dirty-own"
    if (input.upstreamAudits.some((a) => a.findingCount > 0)) return "dirty-upstream"
    if (input.ownSpec.status === "ready" && totalFindingCount === 0) return "ready"
    return "ready-pending-approval"
  })()

  return { aggregate, totalFindingCount, directive: formatDirective(input, aggregate, totalFindingCount) }
}

// ── Directive formatter (the structural enforcement vehicle) ──────────────────

function formatDirective(
  input:     ReadinessReportInput,
  aggregate: ReadinessReport["aggregate"],
  total:     number,
): string {
  const callingShort = lookupAgent(input.callingAgent)?.shortName ?? input.callingAgent
  const ownLine      = formatOwnSpecLine(input.ownSpec, input.featureName)
  const upstreamLine = formatUpstreamLine(input.upstreamAudits)
  const escLine      = formatEscalationLine(input.activeEscalation)
  const nextStep     = formatNextStep(aggregate, input)

  const lines: string[] = [
    `[PLATFORM READINESS DIRECTIVE — ${callingShort} on \`${input.featureName}\`]`,
    "",
    `This is the deterministic readiness state for this feature, computed BEFORE you respond.`,
    `Your response MUST report these counts verbatim, by source, in this order. Do NOT minimize, omit, or reinterpret based on the user's phrasing — the same state produces the same numbers on every turn (Principle 11).`,
    "",
    `1. ${ownLine}`,
    `2. ${upstreamLine}`,
    `3. ${escLine}`,
    "",
    `Total findings across all audits: ${total}.`,
    `Aggregate state: ${aggregate}.`,
    `Your next step in this response: ${nextStep}`,
  ]

  return lines.join("\n")
}

function formatOwnSpecLine(own: ReadinessReportInput["ownSpec"], featureName: string): string {
  const noun = own.findingCount === 1 ? "finding" : "findings"
  switch (own.status) {
    case "missing":
      return `Own ${own.specType} spec for \`${featureName}\`: no draft on the spec branch yet.`
    case "ready":
      return `Own ${own.specType} spec for \`${featureName}\`: internal audit clean (0 findings).`
    case "dirty":
      return `Own ${own.specType} spec for \`${featureName}\`: ${own.findingCount} ${noun} from your own audit.`
  }
}

function formatUpstreamLine(audits: readonly ReadinessAuditSource[]): string {
  if (audits.length === 0) {
    return `Upstream spec audits: none applicable.`
  }
  const parts = audits.map((a) => {
    const auditingShort = lookupAgent(a.auditingAgent)?.shortName ?? a.auditingAgent
    const noun = a.findingCount === 1 ? "finding" : "findings"
    return `${a.findingCount} ${a.specType} ${noun} (${auditingShort}'s audit)`
  })
  const total = audits.reduce((sum, a) => sum + a.findingCount, 0)
  if (total === 0) {
    return `Upstream spec audits: ${parts.join(", ")} — all clean.`
  }
  return `Upstream spec audits: ${parts.join(" + ")} = ${total} total upstream findings.`
}

function formatEscalationLine(esc: ActiveEscalation | null): string {
  if (!esc) return `Active escalation: none — there is no held PM, Designer, or Architect right now.`
  const targetShort = lookupAgent(esc.targetAgent)?.shortName ?? esc.targetAgent
  const originShort = lookupAgent(esc.originAgent)?.shortName ?? esc.originAgent
  const noun = esc.itemCount === 1 ? "item" : "items"
  const summary = esc.summary ? ` (${esc.summary})` : ""
  return `Active escalation: ${targetShort} is engaged on ${esc.itemCount} ${noun} from the ${originShort}${summary}.`
}

function formatNextStep(
  aggregate: ReadinessReport["aggregate"],
  input:     ReadinessReportInput,
): string {
  if (aggregate === "escalation-active" && input.activeEscalation) {
    const targetShort = lookupAgent(input.activeEscalation.targetAgent)?.shortName ?? input.activeEscalation.targetAgent
    return `Tell the user the ${targetShort} is engaged and reply only after that resolves; do not propose handoff yet.`
  }
  if (aggregate === "dirty-upstream") {
    return `Surface the upstream gap counts by source and offer to escalate per PM-first ordering (PM gaps first, then Design gaps).`
  }
  if (aggregate === "dirty-own") {
    return `Surface your own audit gap count and offer to draft tightenings.`
  }
  if (aggregate === "ready-pending-approval") {
    return `State the spec is ready for your phase's approval gate when the user is ready.`
  }
  return `State the spec is implementation-ready and offer to confirm handoff.`
}
