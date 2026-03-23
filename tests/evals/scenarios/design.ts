import { EvalScenario } from "../runner"
import { setEvalEnv, stubContext, stubContextWithDraft, approvedProductSpec } from "../stub-context"
import { buildDesignSystemPrompt, buildDesignStateResponse } from "../../../agents/design"

setEvalEnv()

const FEATURE = "onboarding"

// Context for design phase: the currentDraft holds the approved product spec
// (this is what loadDesignAgentContext produces — approved product spec + any design draft)
const designContext = stubContextWithDraft(`## Approved Product Spec\n${approvedProductSpec}`)

const SPEC_URL = "https://github.com/acme-co/acme-app/blob/spec/onboarding-design/specs/features/onboarding/onboarding.design.md"

const midDraftHistory = [
  {
    role: "user" as const,
    content: "Let's start the design for onboarding.",
  },
  {
    role: "assistant" as const,
    content: `Here's my opening proposal for the onboarding design:

**Three screens:**
1. Landing / Sign-up — centered card, email + password, clean background
2. GitHub connect (optional) — full-screen OAuth, prominent Skip link
3. Confirmation / redirect — toast "Your sample project is ready", auto-redirect

**Key flows:**
- US-1: Landing → fill creds → GitHub step → task board
- US-2: Landing → fill creds → skip GitHub → task board

I'll draft the full design spec now.

DRAFT_DESIGN_SPEC_START
# Onboarding — Design Spec

### Screen 1: Landing / Sign-up
Centered card. Email + password fields. "Create account" CTA. No nav shell.

### Screen 2: GitHub Connect
Full-screen OAuth prompt. "Skip for now" link at bottom.

### Screen 3: Redirect
Toast: "Your sample project is ready." Auto-redirect to task board in 2s.

### Flow: US-1 — New user sign-up
Landing → fill email/password → submit → GitHub step → task board

### Flow: US-2 — Skip GitHub
Landing → submit → GitHub step → click Skip → task board

## Open Questions
- [type: design] [blocking: no] Confirm exact wordmark size in Figma before implementation.
DRAFT_DESIGN_SPEC_END`,
  },
]

export const designScenarios: EvalScenario[] = [
  {
    name: "Design agent opens with a concrete proposal on first message",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "I'm the designer — let's start the onboarding design.",
    criteria: [
      "The response leads with a concrete structural proposal — specific screens or flows, not just discovery questions",
      "The response does not end with 'Shall I?', 'Would you like me to?', or any permission-asking phrase",
      "The response references the approved product spec (user stories or acceptance criteria from it)",
    ],
  },
  {
    name: "Design agent gives a concrete answer to a specific design question",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "What should the sign-up screen look like?",
    history: midDraftHistory,
    criteria: [
      "The response gives a specific visual recommendation — layout, typography, component choices, or color",
      "The response does not just ask what the user wants — it makes a recommendation with reasoning",
      "The response is concise and actionable, not a wall of generic design principles",
    ],
  },
  {
    name: "buildDesignStateResponse includes Figma AI and Builder.io",
    agentLabel: "Design (state query)",
    // This scenario tests the fast-path function directly, not the full agent.
    // We still run it through the eval framework to catch regressions in the voice.
    systemPrompt: "N/A — this scenario calls buildDesignStateResponse directly",
    userMessage: "__SKIP_AGENT_CALL__",  // sentinel — handled by scenario setup
    criteria: [],  // not used — tested via unit tests; scenario exists as a reminder
  },
  {
    name: "Design agent detects approval and moves to engineering",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "Looks great, approved.",
    history: midDraftHistory,
    criteria: [
      "The response confirms the design spec is approved",
      "The response mentions the engineering phase or architect as the next step",
      "The response does not ask 'Are you sure?' or seek further confirmation",
    ],
  },
  {
    name: "Design agent does not ask permission-asking questions",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "Should we add a progress indicator to the onboarding flow?",
    criteria: [
      "The response gives a direct recommendation (yes or no with reasoning), not 'it depends'",
      "The response does not end with 'Want me to add it?' or 'Shall I update the spec?'",
      "The response references the product spec constraints or established design patterns",
    ],
  },
]
