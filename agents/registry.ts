// Single source of truth for which agents are active.
// The concierge prompt is built from this list — adding an agent here
// automatically surfaces it in the concierge's response.
// A test asserts that every entry in ACTIVE_AGENTS appears in the concierge prompt,
// so forgetting to register a new agent causes a test failure.

export type AgentEntry = {
  name: string         // Display name shown to humans in Slack
  description: string  // What it does — one sentence
  phase: string        // When it's active
}

export const ACTIVE_AGENTS: AgentEntry[] = [
  {
    name: "Product Manager (pm agent)",
    description: "Shapes feature ideas into solid, approved product specs through conversation.",
    phase: "Phase 1 — active in every #feature-* channel until the product spec is approved",
  },
  {
    name: "UX Design agent",
    description: "Shapes the approved product spec into a design spec: screens, flows, states, and component decisions.",
    phase: "Phase 2 — active in every #feature-* channel after the product spec is approved",
  },
  {
    name: "Concierge",
    description: "The front door for the whole system — orients anyone arriving, explains the system, and points them to the right next step.",
    phase: "Always available in the main workspace channel",
  },
]
