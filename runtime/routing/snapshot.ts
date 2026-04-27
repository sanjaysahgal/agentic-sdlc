// Phase 2 — the only place that reads conversation-store getters.
//
// The pure routers (route-feature-message.ts, route-general-message.ts) operate on
// plain-data RoutingInput values. This file is the single boundary that:
//
//   1. Reads every per-feature state value at one atomic moment via buildFeatureStateSnapshot.
//   2. Reads per-thread state via buildThreadStateSnapshot.
//   3. Builds FeatureRoutingInput / GeneralRoutingInput from the resolved phase, the
//      classified entry point, and a parsed message intent.
//
// Phase 4 will wire the production handlers to call these builders. Phase 2's matrix
// test uses the row-driven helpers at the bottom of this file to drive parsed SpecRow
// values through the same RoutingInput shape — keeping tests and production aligned.

import {
  type FeatureKey,
  type ThreadKey,
  type AgentId,
  type FeaturePhase,
  type FeatureEntry,
  type GeneralEntry,
  type FeatureStateSnapshot,
  type ThreadStateSnapshot,
  type FeatureRoutingInput,
  type GeneralRoutingInput,
  type RoutingIntent,
  type RoutingDepth,
  userId as toUserId,
} from "./types"
import {
  getConfirmedAgent,
  getPendingEscalation,
  getEscalationNotification,
  getPendingApproval,
  getPendingDecisionReview,
  isUserOriented,
  getHistory,
  getThreadAgent,
  type Message,
  type PendingEscalation,
  type EscalationNotification,
  type PendingApproval,
  type PendingDecisionReview,
} from "../conversation-store"
import { isAgentId } from "./agent-registry"
import type { SpecRow } from "./spec-parser"

// ── Production-time builders ──────────────────────────────────────────────────

export function buildFeatureStateSnapshot(
  key: FeatureKey,
  user: string | undefined,
): FeatureStateSnapshot {
  // Read all per-feature state at one atomic moment. The router never reads conv-store
  // directly; if a future agent writes state mid-turn the dispatcher's re-evaluate
  // post-effect rebuilds the snapshot before the second pass (I17 bounds depth at 1).
  const confirmedRaw = getConfirmedAgent(key)
  const confirmedAgent: AgentId | null = confirmedRaw && isAgentId(confirmedRaw) ? confirmedRaw : null

  return {
    confirmedAgent,
    pendingEscalation:      getPendingEscalation(key),
    escalationNotification: getEscalationNotification(key),
    pendingApproval:        getPendingApproval(key),
    pendingDecisionReview:  getPendingDecisionReview(key),
    isUserOriented:         user ? isUserOriented(key, user) : false,
    history:                getHistory(key),
  }
}

export function buildThreadStateSnapshot(key: ThreadKey): ThreadStateSnapshot {
  const raw = getThreadAgent(key)
  const threadAgent: AgentId | null = raw && isAgentId(raw) ? raw : null
  return { threadAgent }
}

export function buildFeatureRoutingInput(params: {
  key:    FeatureKey
  entry:  FeatureEntry
  phase:  FeaturePhase
  intent: RoutingIntent
  user:   string | undefined
  depth?: RoutingDepth
}): FeatureRoutingInput {
  return {
    channel: "feature",
    key:     params.key,
    entry:   params.entry,
    phase:   params.phase,
    state:   buildFeatureStateSnapshot(params.key, params.user),
    intent:  params.intent,
    depth:   params.depth ?? 0,
  }
}

export function buildGeneralRoutingInput(params: {
  threadKey: ThreadKey
  entry:     GeneralEntry
  intent:    RoutingIntent
  depth?:    RoutingDepth
}): GeneralRoutingInput {
  return {
    channel:   "general",
    threadKey: params.threadKey,
    entry:     params.entry,
    state:     buildThreadStateSnapshot(params.threadKey),
    intent:    params.intent,
    depth:     params.depth ?? 0,
  }
}

// ── Test-only builders that hydrate a SpecRow into a RoutingInput ─────────────
//
// These translate the human-readable cell values from the spec doc into typed
// RoutingInput state. The matrix test uses them as the bridge between docs and
// router, so the contract is: "given this row in the spec, the router must emit
// the row's expected RoutingDecision.kind".
//
// They live alongside the production builders so the data shape can never drift —
// any new state column added to the spec must produce a typed value here, which
// surfaces as a TypeScript error at every call site.

const PLACEHOLDER_KEY: FeatureKey = { tenant: "default" as any, feature: "spec-fixture" as any }

const STANDALONE_AFFIRMATIVES = new Set([
  "yes", "yep", "yeah", "yes (standalone)", "approved", "confirmed", "ok", "okay", "sounds good",
])

// TRIGGER-JUSTIFIED: this is a test-fixture helper, not a per-message classifier in
// production. The matrix test (tests/invariants/routing-matrix.test.ts) calls it
// once per parsed SpecRow to translate the row's userMsg cell into a test input.
// The production-side equivalents are inside route-feature-message.ts and run on
// every message via the pure router — Principle 7 is satisfied there, not here.
export function isStandaloneConfirmationFixture(userMsg: string): boolean {
  return STANDALONE_AFFIRMATIVES.has(userMsg.trim().toLowerCase())
}

export function buildFeatureRoutingInputFromRow(row: SpecRow): FeatureRoutingInput {
  if (row.channel !== "feature" || !row.phase) {
    throw new Error(`buildFeatureRoutingInputFromRow: not a feature row at line ${row.lineNumber}`)
  }
  // Matrix tests default to oriented=true unless the row's expected mode asserts
  // orientation, in which case we hydrate isUserOriented=false so the router
  // produces the orientation branch.
  const oriented = !(row.expected.args.mode ?? "").startsWith("orientation")
  const state: FeatureStateSnapshot = {
    confirmedAgent:         normalizeAgent(row.state["confirmedAgent"]),
    pendingEscalation:      normalizePendingEscalation(row.state["pendingEscalation"]),
    escalationNotification: normalizeEscalationNotification(row.state["escalationNotification"]),
    pendingApproval:        normalizePendingApproval(findStateValue(row.state, ["pendingApproval", "pendingApproval (product)"])),
    pendingDecisionReview:  normalizePendingDecisionReview(row.state["pendingDecisionReview"]),
    isUserOriented:         oriented,
    history:                [] as Message[],
  }

  return {
    channel: "feature",
    key:     PLACEHOLDER_KEY,
    entry:   (row.entry ?? "E1") as FeatureEntry,
    phase:   row.phase,
    state,
    intent:  { kind: "slack-message", rawText: rawTextFromCell(row.userMsg), userId: toUserId("U_TEST") },
    depth:   0,
  }
}

// Spec rows use meta-text in the userMsg column to describe a class of message
// rather than a literal user input — e.g. `"non-affirmative"` means "any message
// that is non-affirmative" and `"(any except affirm/decline)"` means "any message
// that is neither". Translate those to a concrete sample input that exercises the
// intended branch in the router.
function rawTextFromCell(userMsg: string | undefined): string {
  if (!userMsg) return ""
  const t = userMsg.trim()
  if (t === "non-affirmative")                         return "no"
  if (/^\(any except affirm\/decline\)$/i.test(t))     return "tell me more"
  if (/^any\s*\(new thread\)$/i.test(t))               return "hi"
  if (/^any$/i.test(t))                                return "any input"
  return userMsg
}

export function buildGeneralRoutingInputFromRow(row: SpecRow): GeneralRoutingInput {
  if (row.channel !== "general") {
    throw new Error(`buildGeneralRoutingInputFromRow: not a general row at line ${row.lineNumber}`)
  }
  return {
    channel:   "general",
    threadKey: { tenant: "default" as any, thread: "T_TEST" as any },
    entry:     (row.entry ?? "G1") as GeneralEntry,
    state:     { threadAgent: normalizeAgent(row.state["threadAgent"]) },
    intent:    { kind: "slack-message", rawText: row.userMsg ?? "", userId: toUserId("U_TEST") },
    depth:     0,
  }
}

// ── Field normalizers ─────────────────────────────────────────────────────────

function findStateValue(state: Record<string, string>, candidates: string[]): string | undefined {
  for (const c of candidates) if (state[c] !== undefined) return state[c]
  return undefined
}

function isUnset(v: string | undefined): boolean {
  return !v || v === "—" || v.trim() === ""
}

function normalizeAgent(v: string | undefined): AgentId | null {
  if (isUnset(v) || v === "any/none") return null
  const candidate = v!.trim()
  return isAgentId(candidate) ? (candidate as AgentId) : null
}

function normalizePendingEscalation(v: string | undefined): PendingEscalation | null {
  if (isUnset(v)) return null
  const m = v!.match(/target=([a-z-]+)/i)
  if (!m) return null
  // The `target=corrupt` row is intentional FLAG-B fixture data — preserved verbatim.
  return {
    targetAgent:   m[1] as PendingEscalation["targetAgent"],
    question:      "fixture: blocking question",
    designContext: "fixture: design draft",
  }
}

function normalizeEscalationNotification(v: string | undefined): EscalationNotification | null {
  if (isUnset(v)) return null
  const target = v!.match(/target=([a-z-]+)/i)?.[1]
  const origin = v!.match(/origin=([a-z-]+)/i)?.[1]
  if (!target) return null
  return {
    targetAgent: target as EscalationNotification["targetAgent"],
    question:    "fixture: notification question",
    originAgent: origin as EscalationNotification["originAgent"] | undefined,
  }
}

function normalizePendingApproval(v: string | undefined): PendingApproval | null {
  if (isUnset(v)) return null
  // Cell forms: "set", "set (product)", "set (design)", "set (engineering)".
  const m = v!.match(/set\s*\(([a-z]+)\)/i)
  const specType = (m ? m[1] : "product") as PendingApproval["specType"]
  return {
    specType,
    specContent: "fixture: approved spec content",
    filePath:    `fixture/path/${specType}.md`,
    featureName: "spec-fixture",
  }
}

function normalizePendingDecisionReview(v: string | undefined): PendingDecisionReview | null {
  if (isUnset(v)) return null
  return {
    specContent:       "fixture: engineering spec",
    filePath:          "fixture/path/engineering.md",
    featureName:       "spec-fixture",
    resolvedQuestions: ["fixture question 1"],
  }
}
