// Phase 2 — pure general-channel router.
//
// The general/concierge channel has no GitHub-derived phase. Routing is
// concierge-driven; slash commands set a `threadAgent` so subsequent messages in
// the thread stay with the addressed agent (G5). Different agents invoked by
// later slash commands override the prior thread agent.
//
// Behavior is byte-equivalent to today's interfaces/slack/handlers/general.ts —
// product-level mode (no spec-writing tools) is encoded via mode="primary-product-level".

import type {
  AgentId,
  GeneralEntry,
  GeneralRoutingInput,
  RoutingDecision,
  StateEffect,
} from "./types"

const ENTRY_TO_ADDRESSED: Partial<Record<GeneralEntry, AgentId>> = {
  G2: "pm",
  G3: "ux-design",
  G4: "architect",
}

export function routeGeneralMessage(input: GeneralRoutingInput): RoutingDecision {
  const { entry, state, threadKey } = input
  const addressed = ENTRY_TO_ADDRESSED[entry]
  const empty: StateEffect[] = []

  // G2 / G3 / G4 — slash command sets thread agent (overriding any prior choice)
  // and runs the addressed agent in product-level primary mode.
  if (addressed) {
    return {
      kind: "run-agent",
      agent: addressed,
      mode: "primary-product-level",
      preEffects: [{ kind: "set-thread-agent", key: threadKey, agent: addressed }],
      postEffects: [],
    }
  }

  // G5 — follow-up in a slash-spawned thread; thread agent already set, no-prefix
  // message stays with that agent.
  if (state.threadAgent) {
    return {
      kind: "run-agent",
      agent: state.threadAgent,
      mode: "primary-product-level",
      preEffects: empty,
      postEffects: [],
    }
  }

  // G1 — direct concierge message.
  return {
    kind: "run-agent",
    agent: "concierge",
    mode: "primary",
    preEffects: empty,
    postEffects: [],
  }
}
