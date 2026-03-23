import { EvalScenario } from "../runner"
import { setEvalEnv, stubContext, stubContextWithDraft, approvedProductSpec, approvedDesignSpec } from "../stub-context"
import { buildArchitectSystemPrompt } from "../../../agents/architect"

setEvalEnv()

const FEATURE = "onboarding"

// Context for architect phase: approved product spec + approved design spec
const architectContext = stubContextWithDraft(
  `## Approved Product Spec\n${approvedProductSpec}\n\n## Approved Design Spec\n${approvedDesignSpec}`
)

const midDraftHistory = [
  {
    role: "user" as const,
    content: "Let's start the engineering spec for onboarding.",
  },
  {
    role: "assistant" as const,
    content: `Here's my opening proposal for the onboarding engineering spec:

**Data model additions:**
- No new models — auth handled by Clerk
- \`SampleProject\` seeding: a migration that creates 5 default tasks on user creation (Prisma seed pattern)

**tRPC procedures:**
- \`onboarding.completeStep\` — marks onboarding steps done, stored in \`user.onboardingState JSON\`
- \`onboarding.connectGitHub\` — stores OAuth token, marks GitHub step complete

**Key decision:** Onboarding state lives on the \`User\` model as a JSON column rather than a separate table. Simpler, fast reads, sufficient for v1.

DRAFT_ENGINEERING_SPEC_START
# Onboarding — Engineering Spec

## Data Model
No new tables. Add \`onboardingState Json?\` to User model in Prisma.

## tRPC Procedures
- \`onboarding.completeStep(step: string)\` — marks a step done
- \`onboarding.connectGitHub(code: string)\` — exchanges OAuth code, stores token

## Open Questions
- [type: engineering] [blocking: no] Should onboarding state reset if the user's workspace is deleted and recreated?
DRAFT_ENGINEERING_SPEC_END`,
  },
]

export const architectScenarios: EvalScenario[] = [
  {
    name: "Architect opens with a concrete engineering proposal on first message",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "I'm the architect — let's start the engineering spec for onboarding.",
    criteria: [
      "The response leads with a concrete engineering proposal — data model decisions, API design, or key technical constraints",
      "The response does not end with 'Shall I?', 'Would you like me to?', or any permission-asking phrase",
      "The response references the approved design spec (screens or flows from it)",
    ],
  },
  {
    name: "Architect answers a specific technical question",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Should onboarding state be its own table or a JSON column on User?",
    history: midDraftHistory,
    criteria: [
      "The response gives a direct recommendation with a clear reason",
      "The response references the system architecture constraints (Prisma, tRPC, v1 scope)",
      "The response does not say 'it depends' without immediately resolving the dependency",
    ],
  },
  {
    name: "Architect detects approval and wraps up",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "That all looks right to me, approved.",
    history: midDraftHistory,
    criteria: [
      "The response confirms the engineering spec is approved",
      "The response mentions the next step — implementation, engineer agents, or build phase",
      "The response does not ask 'Are you sure?' or seek further confirmation",
    ],
  },
  {
    name: "Architect stays within architecture constraints",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Can we add a REST endpoint for the GitHub OAuth callback instead of going through tRPC?",
    criteria: [
      "The response addresses the constraint that all API access should go through tRPC",
      "The response does not just agree to bypass the constraint without flagging it",
      "The response offers a tRPC-compatible solution or explains why an exception is warranted",
    ],
  },
]
