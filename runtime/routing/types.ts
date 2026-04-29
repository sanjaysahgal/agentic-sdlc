// Phase 1 — Routing types and branded identifiers.
//
// This file is the type-level foundation for the routing state machine refactor
// (see ~/.claude/plans/elegant-percolating-newell.md and docs/ROUTING_STATE_MACHINE.md).
// It introduces brand-based compile-time tenancy so cross-tenant or feature-vs-thread
// mixups become type errors rather than runtime corruption.
//
// Phase 1 acceptance: types compile, behavior unchanged, all tests green.
// Phase 2 will populate the pure routers that consume RoutingInput / RoutingDecision.

// ── Branded identifiers ────────────────────────────────────────────────────────

// Compile-time-only brands. At runtime these are plain strings; TypeScript
// disallows assigning a bare string to a branded type, which catches mixups.
export type TenantId  = string & { readonly _tenant:  unique symbol }
export type FeatureId = string & { readonly _feature: unique symbol }
export type ThreadTs  = string & { readonly _thread:  unique symbol }
export type UserId    = string & { readonly _user:    unique symbol }

// AgentId is the canonical registry key for an agent. The set is closed by the
// AGENT_REGISTRY in runtime/routing/agent-registry.ts; AgentId values that don't
// exist in the registry are an invariant violation (I2 in the spec).
export type AgentId = "pm" | "ux-design" | "architect" | "concierge"

// ── Composite keys ────────────────────────────────────────────────────────────

// A FeatureKey identifies "this feature in this tenant's workspace". Today there
// is only the "default" tenant; multi-tenant runtime is deferred but the type
// layer is ready for it.
export type FeatureKey = {
  readonly tenant:  TenantId
  readonly feature: FeatureId
}

// A ThreadKey identifies a single Slack thread (general/concierge channel only —
// feature channels are keyed by FeatureKey, not by individual thread).
export type ThreadKey = {
  readonly tenant: TenantId
  readonly thread: ThreadTs
}

// ── Constructors and projections ─────────────────────────────────────────────

// The single tenant that exists today. Every key constructor defaults to this
// unless explicitly given another tenant. Multi-tenant runtime support comes
// after the routing refactor lands.
export const DEFAULT_TENANT: TenantId = "default" as TenantId

export function tenantId(s: string): TenantId {
  return s as TenantId
}

export function featureId(s: string): FeatureId {
  return s as FeatureId
}

export function threadTs(s: string): ThreadTs {
  return s as ThreadTs
}

export function userId(s: string): UserId {
  return s as UserId
}

export function featureKey(name: string, tenant: TenantId = DEFAULT_TENANT): FeatureKey {
  return { tenant, feature: featureId(name) }
}

export function threadKey(ts: string, tenant: TenantId = DEFAULT_TENANT): ThreadKey {
  return { tenant, thread: threadTs(ts) }
}

// Internal helpers for the conversation-store: project a struct key down to the
// flat string used in the existing in-memory Map and on-disk JSON. Keeping this
// projection internal preserves the current persistence format byte-for-byte —
// no migration is required at Phase 1.
//
// At scale these helpers will encode tenant into the key (e.g. `${tenant}:${feature}`),
// but today there is only one tenant so we project to the bare feature/thread.
export function featureKeyToString(key: FeatureKey): string {
  return key.feature as string
}

export function threadKeyToString(key: ThreadKey): string {
  return key.thread as string
}

// ── State effect / post-effect data shapes ────────────────────────────────────
//
// Effects are *data*, not closures — the dispatcher (Phase 2) interprets them
// in fixed order. Tests assert against the array directly without simulating
// execution. Every kind here is a leaf node referenced from the spec doc.

import type {
  PendingEscalation,
  EscalationNotification,
  PendingApproval,
  PendingDecisionReview,
} from "../conversation-store"

export type StateEffect =
  | { kind: "set-confirmed-agent";              key: FeatureKey; agent: AgentId }
  | { kind: "clear-confirmed-agent";            key: FeatureKey }
  | { kind: "clear-history-on-phase-change";    key: FeatureKey }
  | { kind: "clear-pending-escalation";         key: FeatureKey }
  | { kind: "set-pending-escalation";           key: FeatureKey; value: PendingEscalation }
  | { kind: "set-escalation-notification";      key: FeatureKey; value: EscalationNotification }
  | { kind: "clear-escalation-notification";    key: FeatureKey }
  | { kind: "set-pending-approval";             key: FeatureKey; value: PendingApproval }
  | { kind: "clear-pending-approval";           key: FeatureKey }
  | { kind: "set-pending-decision-review";      key: FeatureKey; value: PendingDecisionReview }
  | { kind: "advance-decision-review-cursor";   key: FeatureKey }
  | { kind: "clear-pending-decision-review";    key: FeatureKey }
  | { kind: "set-thread-agent";                 key: ThreadKey; agent: AgentId }
  | { kind: "clear-thread-agent";               key: ThreadKey }
  | { kind: "mark-user-oriented";               key: FeatureKey; user: UserId }

export type PostEffect =
  | { kind: "patch-spec";                          specType: "product" | "design" | "engineering"; patch: string }
  | { kind: "writeback-to-main";                   specType: "product" | "design" | "engineering"; content: string }
  | { kind: "post-slack-message";                  text: string }
  | { kind: "re-audit-and-maybe-re-escalate";     featureKey: FeatureKey }
  | { kind: "auto-continue";                       message: string }
  | { kind: "re-evaluate" }

// ── RoutingInput ──────────────────────────────────────────────────────────────
//
// A complete, plain-data snapshot of "everything the router needs to decide what
// happens next". Built by buildStateSnapshot (Phase 2) at the same atomic moment
// for every conversation-store getter; the router itself never reads state.

import type { Message } from "../conversation-store"

// The set of GitHub-derived phases. Mirrors §4 of docs/ROUTING_STATE_MACHINE.md.
// Today's `resolveAgent()` produces these strings; Phase 2 will type its return.
export type FeaturePhase =
  | "product-spec-in-progress"
  | "product-spec-approved-awaiting-design"
  | "design-in-progress"
  | "design-approved-awaiting-engineering"
  | "engineering-in-progress"
  | "complete"

// Closed set of entry points (§2 of the spec doc).
export type FeatureEntry = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8"
export type GeneralEntry = "G1" | "G2" | "G3" | "G4" | "G5"

// The intent classification distinguishes a user-initiated message from a
// post-agent re-evaluation pass (§10 of the spec). Bounded depth (I17) makes
// `0 | 1` the structural ceiling.
export type RoutingDepth = 0 | 1

export type RoutingIntent =
  | { kind: "slack-message"; rawText: string; userId: UserId; dismissIntent?: boolean }
  | { kind: "post-agent"; trigger: PostAgentTrigger }

export type PostAgentTrigger =
  | "pending-escalation-set"
  | "pending-approval-set"
  | "pending-decision-review-set"
  | "writeback-succeeded-clean"
  | "writeback-succeeded-dirty"
  | "writeback-failed"
  | "no-state-change"

// The state snapshot — every per-feature value the router can branch on. Built
// by Phase 2's snapshot.ts. Keeping it explicit (no Map/Record indirection)
// makes matrix tests trivial.
export type FeatureStateSnapshot = {
  readonly confirmedAgent:          AgentId | null
  readonly pendingEscalation:       PendingEscalation       | null
  readonly escalationNotification:  EscalationNotification  | null
  readonly pendingApproval:         PendingApproval         | null
  readonly pendingDecisionReview:   PendingDecisionReview   | null
  readonly isUserOriented:          boolean
  readonly history:                 readonly Message[]
}

export type ThreadStateSnapshot = {
  readonly threadAgent: AgentId | null
}

// Two router input variants — they share the same RoutingDecision return type
// (I19) but their inputs differ because the general channel has no GitHub phase
// and no per-feature spec lifecycle.
export type FeatureRoutingInput = {
  readonly channel:    "feature"
  readonly key:        FeatureKey
  readonly entry:      FeatureEntry
  readonly phase:      FeaturePhase
  readonly state:      FeatureStateSnapshot
  readonly intent:     RoutingIntent
  readonly depth:      RoutingDepth
}

export type GeneralRoutingInput = {
  readonly channel:    "general"
  readonly threadKey:  ThreadKey
  readonly entry:      GeneralEntry
  readonly state:      ThreadStateSnapshot
  readonly intent:     RoutingIntent
  readonly depth:      RoutingDepth
}

export type RoutingInput = FeatureRoutingInput | GeneralRoutingInput

// ── RoutingDecision ──────────────────────────────────────────────────────────
//
// Exhaustive discriminated union (I13). Every Slack-visible behavior the router
// can produce is exactly one variant. Adding a new behavior requires a new kind
// AND a new dispatcher case (the switch is `assertNever`-checked in Phase 2).

export type AgentRunMode =
  | "primary"
  | "primary-product-level"
  | "read-only-consultant"
  | "orientation"

export type SpecType = "product" | "design" | "engineering"

export type DecisionBase = {
  readonly preEffects:  readonly StateEffect[]
  readonly postEffects: readonly PostEffect[]
}

export type RoutingDecision = DecisionBase & (
  | { kind: "run-agent";                            agent: AgentId; mode: AgentRunMode }
  | { kind: "run-escalation-confirmed";             originAgent: AgentId; targetAgent: AgentId }
  | { kind: "run-escalation-continuation";          targetAgent: AgentId }
  | { kind: "resume-after-escalation";              originAgent: AgentId }
  | { kind: "approve-spec";                         specType: SpecType }
  | { kind: "decline-approval-fall-through";        agent: AgentId }
  | { kind: "show-decision-review-prompt";          cursor: number }
  | { kind: "confirm-decision-review-item";         cursor: number }
  | { kind: "complete-decision-review" }
  | { kind: "reject-decision-review-fall-through" }
  | { kind: "show-hold-message";                    heldAgent: AgentId; reason: "escalation"; featureName: string; downstreamPhase: FeaturePhase; blockingQuestion: string }
  | { kind: "dismiss-escalation-fall-through";      originAgent: AgentId | null; reason: "user-dismissed" }
  | { kind: "show-orientation";                     agent: AgentId }
  | { kind: "show-routing-note";                    text: string }
  | { kind: "show-escalation-offer-prompt" }
  | { kind: "show-approval-prompt";                 specType: SpecType }
  | { kind: "show-reopen-confirmation-prompt";      agent: AgentId }
  | { kind: "in-flight-busy" }
  | { kind: "no-active-agent" }
  | { kind: "invalid-state";                        reason: string }
)

export type RoutingDecisionKind = RoutingDecision["kind"]
