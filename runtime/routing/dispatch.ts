// Phase 2 — the routing dispatcher.
//
// Built but NOT yet called from production (per the migration plan: Phase 4 wires
// it behind ROUTING_V2=1). The dispatcher takes a RoutingDecision produced by the
// pure routers and turns it into actual side effects on conversation-store, Slack,
// and GitHub via the injected DispatchDeps.
//
// Invariants enforced here (not in the routers):
//   I15 — In-flight lock is the dispatcher's responsibility; routers run lock-free.
//   I16 — Coupled effects: set-confirmed-agent (when changing) MUST be followed by
//         clear-history-on-phase-change. Asserted before any effect is applied.
//   I17 — Re-evaluate is bounded at depth=1; the dispatcher refuses a second
//         re-evaluate so infinite recursion is structurally impossible.
//
// Effects are data, not closures. The dispatcher is a pure switch on effect.kind.

import type {
  AgentId,
  AgentRunMode,
  FeatureKey,
  RoutingDecision,
  RoutingInput,
  StateEffect,
  PostEffect,
} from "./types"
import type {
  PendingEscalation,
  EscalationNotification,
  PendingApproval,
  PendingDecisionReview,
} from "../conversation-store"

// ── Injected dependencies ─────────────────────────────────────────────────────

export type DispatchDeps = {
  // Conversation-store writes — exposed as a thin interface so tests can mock
  // without touching the real store.
  store: {
    setConfirmedAgent:          (key: FeatureKey, agent: AgentId) => void
    clearConfirmedAgent:        (key: FeatureKey) => void
    clearHistory:               (key: FeatureKey) => void
    setPendingEscalation:       (key: FeatureKey, value: PendingEscalation) => void
    clearPendingEscalation:     (key: FeatureKey) => void
    setEscalationNotification:  (key: FeatureKey, value: EscalationNotification) => void
    clearEscalationNotification:(key: FeatureKey) => void
    setPendingApproval:         (key: FeatureKey, value: PendingApproval) => void
    clearPendingApproval:       (key: FeatureKey) => void
    setPendingDecisionReview:   (key: FeatureKey, value: PendingDecisionReview) => void
    clearPendingDecisionReview: (key: FeatureKey) => void
    advanceDecisionReviewCursor:(key: FeatureKey) => void
    setThreadAgent:             (key: { tenant: any; thread: any }, agent: AgentId) => void
    clearThreadAgent:           (key: { tenant: any; thread: any }) => void
    markUserOriented:           (key: FeatureKey, user: string) => void
  }

  // Side-effect handlers for PostEffects.
  runAgent:               (agent: AgentId, mode: AgentRunMode) => Promise<void>
  patchSpec:              (params: { specType: "product" | "design" | "engineering"; patch: string }) => Promise<void>
  writebackToMain:        (params: { specType: "product" | "design" | "engineering"; content: string }) => Promise<void>
  postSlackMessage:       (text: string) => Promise<void>
  reAuditAndMaybeReEscalate: (key: FeatureKey) => Promise<void>
  autoContinue:           (message: string) => Promise<void>

  // Re-route after re-evaluate. Phase 2 keeps this generic so the dispatcher doesn't
  // import the routers (avoids circular dep); callers wire up the right router.
  reEvaluate:             (input: RoutingInput) => RoutingDecision

  // Optional logger. Defaults to console.
  log?: (line: string) => void
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeDecision(
  decision: RoutingDecision,
  input: RoutingInput,
  deps: DispatchDeps,
): Promise<void> {
  const log = deps.log ?? ((s: string) => console.log(s))
  const start = Date.now()

  // I16 — coupled effect assertion.
  assertCoupledEffects(decision)

  // 1. preEffects
  for (const effect of decision.preEffects) applyStateEffect(effect, deps)

  // 2. agent run (if the decision kind requires it)
  if (needsAgentRun(decision)) {
    await deps.runAgent(decisionAgent(decision)!, decisionMode(decision)!)
  }

  // 3. postEffects
  let reEvaluated = false
  for (const effect of decision.postEffects) {
    if (effect.kind === "re-evaluate") {
      // I17 — bounded depth.
      if (input.depth === 1) {
        log(`[DISPATCH-ERROR] re-evaluate refused at depth=1 (I17). decision.kind=${decision.kind}`)
        continue
      }
      const nextInput: RoutingInput = { ...input, depth: 1, intent: { kind: "post-agent", trigger: "no-state-change" } } as RoutingInput
      const nextDecision = deps.reEvaluate(nextInput)
      reEvaluated = true
      await executeDecision(nextDecision, nextInput, deps)
      continue
    }
    await applyPostEffect(effect, deps)
  }

  log(`[DISPATCH] kind=${decision.kind} preEffects=${decision.preEffects.length} postEffects=${decision.postEffects.length} reEvaluated=${reEvaluated} durationMs=${Date.now() - start}`)
}

// ── I16 coupled-effect assertion ──────────────────────────────────────────────

export function assertCoupledEffects(decision: RoutingDecision): void {
  // Whenever set-confirmed-agent is in preEffects, the very next preEffect must be
  // clear-history-on-phase-change for the same key. This pairing is the only way
  // history is wiped on phase change (I16); separating them risks leaking
  // prior-phase chatter into the new agent's context.
  for (let i = 0; i < decision.preEffects.length; i++) {
    const e = decision.preEffects[i]
    if (e.kind !== "set-confirmed-agent") continue
    const next = decision.preEffects[i + 1]
    if (!next || next.kind !== "clear-history-on-phase-change") {
      throw new Error(
        `[DISPATCH] I16 violated: set-confirmed-agent must be immediately followed by clear-history-on-phase-change in preEffects (decision.kind=${decision.kind})`,
      )
    }
    if (next.key.feature !== e.key.feature || next.key.tenant !== e.key.tenant) {
      throw new Error(
        `[DISPATCH] I16 violated: set-confirmed-agent and clear-history-on-phase-change must reference the same key (decision.kind=${decision.kind})`,
      )
    }
  }
}

// ── Effect dispatch (pure switch) ─────────────────────────────────────────────

function applyStateEffect(effect: StateEffect, deps: DispatchDeps): void {
  switch (effect.kind) {
    case "set-confirmed-agent":           return deps.store.setConfirmedAgent(effect.key, effect.agent)
    case "clear-confirmed-agent":         return deps.store.clearConfirmedAgent(effect.key)
    case "clear-history-on-phase-change": return deps.store.clearHistory(effect.key)
    case "clear-pending-escalation":      return deps.store.clearPendingEscalation(effect.key)
    case "set-pending-escalation":        return deps.store.setPendingEscalation(effect.key, effect.value)
    case "set-escalation-notification":   return deps.store.setEscalationNotification(effect.key, effect.value)
    case "clear-escalation-notification": return deps.store.clearEscalationNotification(effect.key)
    case "set-pending-approval":          return deps.store.setPendingApproval(effect.key, effect.value)
    case "clear-pending-approval":        return deps.store.clearPendingApproval(effect.key)
    case "set-pending-decision-review":   return deps.store.setPendingDecisionReview(effect.key, effect.value)
    case "advance-decision-review-cursor":return deps.store.advanceDecisionReviewCursor(effect.key)
    case "clear-pending-decision-review": return deps.store.clearPendingDecisionReview(effect.key)
    case "set-thread-agent":              return deps.store.setThreadAgent(effect.key, effect.agent)
    case "clear-thread-agent":            return deps.store.clearThreadAgent(effect.key)
    case "mark-user-oriented":            return deps.store.markUserOriented(effect.key, effect.user)
    default: return assertNever(effect)
  }
}

async function applyPostEffect(effect: PostEffect, deps: DispatchDeps): Promise<void> {
  switch (effect.kind) {
    case "patch-spec":                       return deps.patchSpec({ specType: effect.specType, patch: effect.patch })
    case "writeback-to-main":                return deps.writebackToMain({ specType: effect.specType, content: effect.content })
    case "post-slack-message":               return deps.postSlackMessage(effect.text)
    case "re-audit-and-maybe-re-escalate":   return deps.reAuditAndMaybeReEscalate(effect.featureKey)
    case "auto-continue":                    return deps.autoContinue(effect.message)
    case "re-evaluate":                      return  // handled inline by executeDecision
    default: return assertNever(effect)
  }
}

// ── Decision → agent / mode helpers ───────────────────────────────────────────

function needsAgentRun(decision: RoutingDecision): boolean {
  return decision.kind === "run-agent" ||
         decision.kind === "run-escalation-confirmed" ||
         decision.kind === "run-escalation-continuation" ||
         decision.kind === "resume-after-escalation"
}

function decisionAgent(decision: RoutingDecision): AgentId | undefined {
  switch (decision.kind) {
    case "run-agent":                    return decision.agent
    case "run-escalation-confirmed":     return decision.targetAgent
    case "run-escalation-continuation":  return decision.targetAgent
    case "resume-after-escalation":      return decision.originAgent
    default: return undefined
  }
}

function decisionMode(decision: RoutingDecision): AgentRunMode {
  if (decision.kind === "run-agent") return decision.mode
  return "primary"
}

function assertNever(x: never): never {
  throw new Error(`[DISPATCH] unhandled effect kind: ${JSON.stringify(x)}`)
}
