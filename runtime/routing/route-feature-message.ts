// Phase 2 — pure feature-channel router.
//
// Takes a FeatureRoutingInput (built by snapshot.ts) and returns exactly one
// RoutingDecision. No I/O. No side effects. Same input → same output, always.
//
// Behavior is byte-equivalent to today's code in interfaces/slack/handlers/message.ts
// for the cases that still ship to production. Phase 5 is fixing each spec FLAG as a
// deliberate spec edit + matrix row diff + new test:
//   - FLAG-A (slash-as-confirmation): fixed under I1 — a slash addressing the held
//     target resumes the escalation rather than showing the hold.
//   - FLAG-B (corrupt targetAgent): fixed under I2 — the runtime check below emits
//     `invalid-state` with cleanup; on-disk legacy values are scrubbed by
//     `scripts/migrate-routing-state-v2.ts` before cutover.
//   - FLAG-C (hold-message label hardcoded): fixed under I7-extended — the renderer
//     in `hold-message-renderer.ts` derives every label from the agent registry.
// Remaining FLAGs (D, E) are queued for Phase 5 / I8 + FLAG-5.
//
// Decision order (mirrors message.ts and §11 of the spec):
//   1. pendingDecisionReview  (I3 — multi-turn precedence)
//   2. pendingEscalation      (I9 — exclusive; I1 — slash addressing held target = confirmation)
//   3. escalationNotification (reply continuation OR resume-after-escalation)
//   4. pendingApproval        (only when affirmative or non-affirmative)
//   5. complete phase         (read-only or routing-note)
//   6. slash override         (E2/E3/E4/E5/E6/E7 → addressed agent)
//   7. canonical agent        (run-agent on the phase's owning agent)
//
// Every other branch is structurally unreachable and produces invalid-state.

import type {
  AgentId,
  FeatureEntry,
  FeaturePhase,
  FeatureRoutingInput,
  RoutingDecision,
  StateEffect,
  SpecType,
} from "./types"
import { lookupAgentForPhase, isAgentId } from "./agent-registry"

const STANDALONE_AFFIRMATIVE = new Set([
  "yes", "yep", "yeah", "approved", "confirmed", "ok", "okay", "sounds good", "lgtm", "looks good",
])
const NON_AFFIRMATIVE = new Set([
  "no", "nope", "decline", "reject", "stop", "cancel", "no thanks",
])

function isAffirmative(msg: string): boolean {
  const t = stripQualifier(msg).trim().toLowerCase()
  return STANDALONE_AFFIRMATIVE.has(t)
}

function isNonAffirmative(msg: string): boolean {
  const t = stripQualifier(msg).trim().toLowerCase().split(/[\s/]/)[0]
  return NON_AFFIRMATIVE.has(t)
}

function stripQualifier(msg: string): string {
  // Spec rows use forms like `"yes" (standalone)` and `"no" / non-affirmative`. The
  // user-facing text is the leading quoted token; trailing parenthetical or
  // slash-qualifier annotations are spec metadata, not what the user typed.
  return msg.replace(/\s*\([^)]+\)\s*$/, "").replace(/\s*\/\s*non-affirmative.*$/i, "")
}

// E2–E7 / E5–E7: a slash command or @prefix encodes an addressed agent. The router
// re-derives the addressed agent from the entry id alone (the message text is
// classification-redundant once entry is known). Phase 0 entries are listed in §2.1.
const ENTRY_TO_ADDRESSED: Partial<Record<FeatureEntry, AgentId>> = {
  E2: "pm",
  E3: "ux-design",
  E4: "architect",
  E5: "pm",
  E6: "ux-design",
  E7: "architect",
}

// PendingEscalation.targetAgent uses the legacy "design" alias (queued for I8 to
// close at the type level). The router canonicalizes to AgentId here so downstream
// effects (set-escalation-notification, hold-message labels) reference the
// registry-correct id. Anything that isn't an AgentId (and isn't the legacy alias)
// returns null — the caller emits `invalid-state` per I2. On-disk records carrying
// such corrupt values are scrubbed by `scripts/migrate-routing-state-v2.ts`.
function canonicalize(target: string): AgentId | null {
  if (target === "design") return "ux-design"
  return isAgentId(target) ? (target as AgentId) : null
}

// pendingApproval blocks dispatch only for the agent that owns the matching spec
// type (I10). PM owns product, ux-design owns design, architect owns engineering.
function specOwner(spec: SpecType): AgentId {
  switch (spec) {
    case "product":     return "pm"
    case "design":      return "ux-design"
    case "engineering": return "architect"
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export function routeFeatureMessage(input: FeatureRoutingInput): RoutingDecision {
  if (input.intent.kind === "post-agent") return routePostAgent(input)

  const userMsg  = input.intent.rawText
  const { entry, phase, state, key } = input
  const addressed = ENTRY_TO_ADDRESSED[entry]
  const empty: StateEffect[] = []

  // 1 — pendingDecisionReview takes precedence over everything else (I3).
  if (state.pendingDecisionReview) {
    if (isAffirmative(userMsg)) {
      return {
        kind: "confirm-decision-review-item",
        cursor: 0,
        preEffects: [{ kind: "advance-decision-review-cursor", key }],
        postEffects: [],
      }
    }
    if (isNonAffirmative(userMsg)) {
      return {
        kind: "reject-decision-review-fall-through",
        preEffects: [{ kind: "clear-pending-decision-review", key }],
        postEffects: [],
      }
    }
    return { kind: "show-decision-review-prompt", cursor: 0, preEffects: empty, postEffects: [] }
  }

  // 2 — pendingEscalation: exclusive (I9). I1 — a slash command (E2–E7) addressing
  // the held targetAgent counts as confirmation, equivalent to "yes". The slash
  // addressing IS the confirmation signal; the message body becomes input to the
  // resumed agent. Non-matching slashes still show the hold (I9 exclusivity).
  if (state.pendingEscalation) {
    const targetCanon = canonicalize(state.pendingEscalation.targetAgent)
    if (!targetCanon) {
      // I2 — corrupt targetAgent. Production handlers used to crash or silently
      // mis-route; the v2 router emits invalid-state and the dispatcher cleans
      // up the bad on-disk record. The migration script scrubs pre-existing
      // bad values at startup so this branch is a structural belt-and-suspenders
      // for state written after migration runs.
      return { kind: "invalid-state", reason: `corrupt-targetAgent:${state.pendingEscalation.targetAgent}`, preEffects: empty, postEffects: [] }
    }
    const slashConfirms = addressed !== undefined && addressed === targetCanon
    if (slashConfirms || isAffirmative(userMsg)) {
      // Origin agent today is the confirmedAgent — usually the agent that proposed the escalation.
      const origin = state.confirmedAgent ?? originFromPhase(phase) ?? "ux-design"
      return {
        kind: "run-escalation-confirmed",
        originAgent: origin,
        targetAgent: targetCanon,
        preEffects: [
          { kind: "clear-pending-escalation", key },
          { kind: "set-escalation-notification", key, value: {
            targetAgent: state.pendingEscalation.targetAgent,
            question:    state.pendingEscalation.question,
            originAgent: origin === "architect" ? "architect" : "design",
          } },
        ],
        postEffects: [],
      }
    }
    return {
      kind: "show-hold-message",
      heldAgent: targetCanon,
      reason: "escalation",
      featureName: key.feature as unknown as string,
      downstreamPhase: phase,
      blockingQuestion: state.pendingEscalation.question,
      preEffects: empty,
      postEffects: [],
    }
  }

  // 3 — escalationNotification: reply from the @mentioned agent. A standalone
  // confirmation resumes the origin agent (with writeback as a postEffect); any
  // other message routes back to the target agent for continued conversation.
  // I2 + I8 — both targetAgent and originAgent must canonicalize to a valid
  // AgentId; anything else is invalid-state with cleanup. The pre-Phase-5
  // fallbacks (`?? "pm"` for target, `=== "architect" ? "architect" : "ux-design"`
  // for origin) silently routed corrupt or missing values to a default agent —
  // FLAG-D in the spec. The disk-side counterpart is the migration script,
  // which scrubs entries with missing/corrupt origin or target.
  if (state.escalationNotification) {
    const targetCanon = canonicalize(state.escalationNotification.targetAgent)
    if (!targetCanon) {
      return {
        kind: "invalid-state",
        reason: `corrupt-targetAgent:${state.escalationNotification.targetAgent}`,
        preEffects: [{ kind: "clear-escalation-notification", key }],
        postEffects: [],
      }
    }
    const originRaw = state.escalationNotification.originAgent
    if (!originRaw) {
      return {
        kind: "invalid-state",
        reason: "missing-originAgent",
        preEffects: [{ kind: "clear-escalation-notification", key }],
        postEffects: [],
      }
    }
    const originCanon = canonicalize(originRaw)
    if (!originCanon) {
      return {
        kind: "invalid-state",
        reason: `corrupt-originAgent:${originRaw}`,
        preEffects: [{ kind: "clear-escalation-notification", key }],
        postEffects: [],
      }
    }
    if (isAffirmative(userMsg)) {
      return {
        kind: "resume-after-escalation",
        originAgent: originCanon,
        preEffects: [{ kind: "clear-escalation-notification", key }],
        postEffects: [
          { kind: "writeback-to-main", specType: originCanon === "architect" ? "engineering" : "design", content: "" },
        ],
      }
    }
    return { kind: "run-escalation-continuation", targetAgent: targetCanon, preEffects: empty, postEffects: [] }
  }

  // 4 — pendingApproval: only the spec-owning agent can approve. Other agents
  // fall through to normal routing (I10).
  if (state.pendingApproval && state.confirmedAgent === specOwner(state.pendingApproval.specType)) {
    if (isAffirmative(userMsg)) {
      return {
        kind: "approve-spec",
        specType: state.pendingApproval.specType,
        preEffects: [{ kind: "clear-pending-approval", key }],
        postEffects: [],
      }
    }
    if (isNonAffirmative(userMsg)) {
      return {
        kind: "decline-approval-fall-through",
        agent: state.confirmedAgent,
        preEffects: [{ kind: "clear-pending-approval", key }],
        postEffects: [],
      }
    }
  }

  const canonical = lookupAgentForPhase(phase)?.id

  // 5 — complete phase: read-only consultant for slash overrides; routing-note for direct.
  if (phase === "complete") {
    if (addressed) {
      return { kind: "run-agent", agent: addressed, mode: "read-only-consultant", preEffects: empty, postEffects: [] }
    }
    return { kind: "show-routing-note", text: "complete", preEffects: empty, postEffects: [] }
  }

  // 6 — slash override: addressed-agent-equals-canonical → primary; otherwise read-only.
  if (addressed) {
    if (canonical && addressed === canonical) {
      return { kind: "run-agent", agent: addressed, mode: "primary", preEffects: empty, postEffects: [] }
    }
    return { kind: "run-agent", agent: addressed, mode: "read-only-consultant", preEffects: empty, postEffects: [] }
  }

  // 7 — canonical agent. New thread (no confirmedAgent) classify-and-routes to canonical.
  // Orientation mode fires on transition-phase first messages from a not-yet-oriented user.
  if (!canonical) return { kind: "no-active-agent", preEffects: empty, postEffects: [] }

  if (!state.isUserOriented && isTransitionPhase(phase)) {
    return { kind: "run-agent", agent: canonical, mode: "orientation", preEffects: empty, postEffects: [] }
  }

  return { kind: "run-agent", agent: canonical, mode: "primary", preEffects: empty, postEffects: [] }
}

// ── Post-agent (depth = 1) ────────────────────────────────────────────────────
//
// Triggered when an agent's tool calls have mutated state. Bounded by I17 — the
// dispatcher refuses a second re-evaluate. The post-agent matrix in §10 is a
// closed set; everything not listed maps to a no-op (returned here as a benign
// run-agent on the canonical agent so the dispatcher still has a kind to switch on).

function routePostAgent(input: FeatureRoutingInput): RoutingDecision {
  const { state } = input
  const empty: StateEffect[] = []

  if (state.pendingEscalation) {
    return { kind: "show-escalation-offer-prompt", preEffects: empty, postEffects: [] }
  }
  if (state.pendingApproval) {
    return { kind: "show-approval-prompt", specType: state.pendingApproval.specType, preEffects: empty, postEffects: [] }
  }
  if (state.pendingDecisionReview) {
    return { kind: "show-decision-review-prompt", cursor: 0, preEffects: empty, postEffects: [] }
  }
  // No state change — the dispatcher should not have called us. Surface as invalid-state
  // so test failures point at the missing `re-evaluate` skip in the dispatcher.
  return { kind: "invalid-state", reason: "post-agent-no-trigger", preEffects: empty, postEffects: [] }
}

function isTransitionPhase(phase: FeaturePhase): boolean {
  return phase === "product-spec-approved-awaiting-design" ||
         phase === "design-approved-awaiting-engineering"
}

function originFromPhase(phase: FeaturePhase): AgentId | undefined {
  return lookupAgentForPhase(phase)?.id
}
