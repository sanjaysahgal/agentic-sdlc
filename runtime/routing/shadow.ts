// Phase 3 Stage 2 — production dual-run shadow mode.
//
// Called once per Slack message at the entry of handleFeatureChannelMessage and
// handleGeneralChannelAgentMessage. Reads the same state the production handler
// reads, runs the new pure router with that state, and emits one of:
//
//   [ROUTING-V2-PROPOSED] feature=<x> phase=<y> entry=<z> kind=<k> agent=<a> mode=<m>
//   [ROUTING-V2-SHADOW-ERROR] feature=<x> reason=<reason>
//
// The function is fire-and-forget: it must never throw, never block the
// handler, and never alter conversation-store state. The only effect is a log
// line consumed by scripts/shadow-coverage-report.ts.
//
// Production wiring detail: the feature handler computes the phase via an
// existing GitHub call; rather than re-fetch it here, callers pass it in.
// This keeps the shadow on the cold path's existing data and avoids an
// extra API hit per message.

import {
  type FeatureKey,
  type ThreadKey,
  type FeatureEntry,
  type GeneralEntry,
  type FeaturePhase,
  type RoutingDecision,
  featureKey as makeFeatureKey,
  threadKey as makeThreadKey,
  userId as toUserId,
} from "./types"
import {
  buildFeatureRoutingInput,
  buildGeneralRoutingInput,
} from "./snapshot"
import { routeFeatureMessage } from "./route-feature-message"
import { routeGeneralMessage } from "./route-general-message"

// Classify the entry point from the raw text. The production handler doesn't
// keep a clean E1..E8 enum today; the shadow does the classification fresh
// per message. For Phase 4 cutover, this becomes the canonical entry classifier
// and the production handler is rewritten to feed it directly.
//
// The classifier looks at:
//   - explicit @-prefix at the start of the message → E5/E6/E7
//   - slash-spawned thread continuation (entryHint `/pm` etc.) → E2/E3/E4
//   - everything else → E1 (direct message)
//
// E8 (follow-up in slash-spawned thread without prefix) is captured by a
// thread-agent lookup; for Stage 2 we treat E8 as E1 (no prefix). Phase 5
// formalizes E8 with explicit threadAgent state.
export function classifyFeatureEntry(rawText: string, entryHint?: string): FeatureEntry {
  if (entryHint === "/pm")        return "E2"
  if (entryHint === "/design")    return "E3"
  if (entryHint === "/architect") return "E4"
  // KEYWORD-JUSTIFIED: matching @agent: prefix — machine-generated, not user prose
  if (/^@pm[:\s]/i.test(rawText))         return "E5"
  if (/^@design[:\s]/i.test(rawText))     return "E6"
  if (/^@architect[:\s]/i.test(rawText))  return "E7"
  return "E1"
}

export function classifyGeneralEntry(rawText: string, entryHint?: string): GeneralEntry {
  if (entryHint === "/pm")        return "G2"
  if (entryHint === "/design")    return "G3"
  if (entryHint === "/architect") return "G4"
  // KEYWORD-JUSTIFIED: matching @agent: prefix — machine-generated, not user prose
  if (/^@pm[:\s]/i.test(rawText))         return "G2"
  if (/^@design[:\s]/i.test(rawText))     return "G3"
  if (/^@architect[:\s]/i.test(rawText))  return "G4"
  return "G1"
}

function decisionAgent(d: RoutingDecision): string {
  if (d.kind === "run-agent")                    return d.agent
  if (d.kind === "run-escalation-confirmed")     return d.targetAgent
  if (d.kind === "run-escalation-continuation")  return d.targetAgent
  if (d.kind === "resume-after-escalation")      return d.originAgent
  if (d.kind === "show-hold-message")            return d.heldAgent
  return "-"
}

function decisionMode(d: RoutingDecision): string {
  if (d.kind === "run-agent") return d.mode
  return "-"
}

export function logShadowProposalForFeature(params: {
  featureName: string
  rawText:     string
  user:        string | undefined
  phase:       FeaturePhase | string
  entryHint?:  string
}): void {
  try {
    const phase = (params.phase as FeaturePhase) ?? "product-spec-in-progress"
    const entry = classifyFeatureEntry(params.rawText, params.entryHint)
    const key: FeatureKey = makeFeatureKey(params.featureName)
    const input = buildFeatureRoutingInput({
      key,
      entry,
      phase,
      intent: { kind: "slack-message", rawText: params.rawText, userId: toUserId(params.user ?? "U_UNKNOWN") },
      user:   params.user,
    })
    const decision = routeFeatureMessage(input)
    console.log(
      `[ROUTING-V2-PROPOSED] feature=${params.featureName} phase=${phase} entry=${entry} kind=${decision.kind} agent=${decisionAgent(decision)} mode=${decisionMode(decision)}`,
    )
  } catch (err) {
    console.log(`[ROUTING-V2-SHADOW-ERROR] feature=${params.featureName} reason=${String(err).slice(0, 200)}`)
  }
}

export function logShadowProposalForGeneral(params: {
  threadTs:   string
  rawText:    string
  user:       string | undefined
  entryHint?: string
}): void {
  try {
    const entry = classifyGeneralEntry(params.rawText, params.entryHint)
    const key: ThreadKey = makeThreadKey(params.threadTs)
    const input = buildGeneralRoutingInput({
      threadKey: key,
      entry,
      intent: { kind: "slack-message", rawText: params.rawText, userId: toUserId(params.user ?? "U_UNKNOWN") },
    })
    const decision = routeGeneralMessage(input)
    console.log(
      `[ROUTING-V2-PROPOSED] channel=general thread=${params.threadTs} entry=${entry} kind=${decision.kind} agent=${decisionAgent(decision)} mode=${decisionMode(decision)}`,
    )
  } catch (err) {
    console.log(`[ROUTING-V2-SHADOW-ERROR] channel=general thread=${params.threadTs} reason=${String(err).slice(0, 200)}`)
  }
}
