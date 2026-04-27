// Concierge-facing view of the canonical agent registry.
//
// The single source of truth is runtime/routing/agent-registry.ts. This file
// projects that registry into the legacy `ACTIVE_AGENTS` shape that the
// concierge prompt (agents/concierge.ts) and the `lists every agent` test
// (tests/unit/concierge.test.ts) consume. Adding a new agent is one entry in
// the canonical registry — this view auto-updates.

import { AGENT_REGISTRY } from "../runtime/routing/agent-registry"

export type AgentEntry = {
  name: string         // Display name shown to humans in Slack
  description: string  // What it does — one sentence
  phase: string        // When it's active
}

export const ACTIVE_AGENTS: AgentEntry[] = AGENT_REGISTRY.map((e) => ({
  name: e.displayName,
  description: e.description,
  phase: e.phaseCopy,
}))
