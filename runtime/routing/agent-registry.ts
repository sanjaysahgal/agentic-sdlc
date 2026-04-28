// Phase 1 — single source of truth for agents.
//
// This registry is the union of two prior responsibilities:
//   1. agents/registry.ts (concierge-facing display metadata: name, description, phase copy).
//   2. The implicit phase→agent map currently encoded in interfaces/slack/handlers/message.ts
//      (resolveAgent + PHASE_TO_AGENT). Phase 2 will route through this registry instead.
//
// Adding a new agent (Coder, Reviewer, …) is one entry here. Phase 2's pure
// router and Phase 5's invariant checks both read from this list.

import type { AgentId, FeaturePhase, SpecType } from "./types"

export type AgentEntry = {
  // Canonical id used in routing decisions, persisted state, and tool calls.
  readonly id: AgentId

  // Human-readable display name shown in Slack messages and the concierge prompt.
  readonly displayName: string

  // Compact role label used inline in platform-rendered Slack messages
  // (e.g. hold-message template: "Reply yes to have the <shortName> draft
  // tightenings"). Distinct from displayName, which is the formal agent name.
  // Phase 5 / I7-extended: registry-derived label replaces hardcoded "PM" /
  // "Designer" / "Architect" strings scattered through production handlers.
  readonly shortName: string

  // The spec type this agent owns end-to-end. Used by the I7 hold-message
  // renderer to name the upstream spec the held escalation is blocked on,
  // and by the I10 spec-owner gate. Concierge has no owned spec.
  readonly ownsSpec: SpecType | null

  // One-sentence description shown in the concierge prompt.
  readonly description: string

  // Concierge-prompt phase copy — the phrase used to describe when this agent
  // is active. Kept verbatim from the original agents/registry.ts so the
  // concierge prompt is byte-equivalent across this refactor.
  readonly phaseCopy: string

  // The set of GitHub-derived phases this agent owns. The pure router (Phase 2)
  // looks up the active agent for a feature by matching the resolved phase
  // against this list. Concierge has no phase ownership — it lives in the
  // general channel and is not bound to a feature lifecycle.
  readonly phases: readonly FeaturePhase[]
}

export const AGENT_REGISTRY: readonly AgentEntry[] = [
  {
    id: "pm",
    displayName: "Product Manager (pm agent)",
    shortName: "PM",
    ownsSpec: "product",
    description: "Shapes feature ideas into solid, approved product specs through conversation.",
    phaseCopy: "Phase 1 — active in every #feature-* channel until the product spec is approved",
    phases: ["product-spec-in-progress"],
  },
  {
    id: "ux-design",
    displayName: "UX Design agent",
    shortName: "Designer",
    ownsSpec: "design",
    description: "Shapes the approved product spec into a design spec: screens, flows, states, and component decisions.",
    phaseCopy: "Phase 2 — active in every #feature-* channel after the product spec is approved",
    phases: ["product-spec-approved-awaiting-design", "design-in-progress"],
  },
  {
    id: "architect",
    displayName: "Architect",
    shortName: "Architect",
    ownsSpec: "engineering",
    description: "Translates the approved design spec into a precise engineering plan: data model, API contracts, component breakdown, non-functional requirements.",
    phaseCopy: "Phase 3 — active in every #feature-* channel after the design spec is approved",
    phases: ["design-approved-awaiting-engineering", "engineering-in-progress"],
  },
  {
    id: "concierge",
    displayName: "Concierge",
    shortName: "Concierge",
    ownsSpec: null,
    description: "The front door for the whole system — orients anyone arriving, explains the system, and points them to the right next step.",
    phaseCopy: "Always available in the main workspace channel",
    phases: [],
  },
]

// Compile-time invariant I11: phase ownership is single-valued. If two agents
// claim the same phase, the union of types below collapses and TypeScript
// surfaces it via the `cannot-have-overlapping-phases` brand. This is verified
// at module load by a runtime assertion as a belt-and-suspenders check.
function assertPhasesAreSingleValued(): void {
  const seen = new Map<FeaturePhase, AgentId>()
  for (const entry of AGENT_REGISTRY) {
    for (const phase of entry.phases) {
      const prior = seen.get(phase)
      if (prior && prior !== entry.id) {
        throw new Error(
          `[agent-registry] invariant I11 violated: phase "${phase}" is claimed by both "${prior}" and "${entry.id}"`,
        )
      }
      seen.set(phase, entry.id)
    }
  }
}
assertPhasesAreSingleValued()

const REGISTRY_BY_ID = new Map<AgentId, AgentEntry>(AGENT_REGISTRY.map((e) => [e.id, e]))
const REGISTRY_BY_PHASE = new Map<FeaturePhase, AgentEntry>()
for (const entry of AGENT_REGISTRY) {
  for (const phase of entry.phases) REGISTRY_BY_PHASE.set(phase, entry)
}

// Constant-time lookup by id. Returns undefined for unknown ids — the caller
// is responsible for raising the I2 invalid-state decision.
export function lookupAgent(id: AgentId): AgentEntry | undefined {
  return REGISTRY_BY_ID.get(id)
}

// Constant-time lookup of the canonical agent for a phase. Returns undefined
// only for phases with no agent (e.g. `complete`).
export function lookupAgentForPhase(phase: FeaturePhase): AgentEntry | undefined {
  return REGISTRY_BY_PHASE.get(phase)
}

// True if the given string is a known agent id. Used by Phase 5's I2 check
// (closed `targetAgent` validation) and by current code paths that need to
// reject corrupt persisted state.
export function isAgentId(s: string): s is AgentId {
  return REGISTRY_BY_ID.has(s as AgentId)
}
