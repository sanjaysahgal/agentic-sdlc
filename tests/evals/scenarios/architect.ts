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

## Data Model
No new tables. Add \`onboardingState Json?\` to User model in Prisma.

## tRPC Procedures
- \`onboarding.completeStep(step: string)\` — marks a step done
- \`onboarding.connectGitHub(code: string)\` — exchanges OAuth code, stores token

## Open Questions
- [type: engineering] [blocking: no] Should onboarding state reset if the user's workspace is deleted and recreated?`,
  },
]

export const architectScenarios: EvalScenario[] = [
  // ─── Opening / Orientation ──────────────────────────────────────────────────

  {
    name: "Architect opens with a concrete engineering proposal on first message",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "I'm the architect — let's start the engineering spec for onboarding.",
    criteria: [
      "The response leads with a concrete engineering proposal — data model, API design, technical constraints, or architecture decisions",
    ],
    deterministicCriteria: [
      {
        label: "No permission-asking phrases",
        mustNotContain: ["shall I", "would you like me to", "should I proceed", "what would you like to focus on"],
      },
      {
        label: "No hedge language",
        mustNotContain: ["it depends", "up to you", "your call", "what's your preference"],
      },
    ],
  },

  {
    name: "Architect orientation does NOT dump gaps — orients first",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Hi, I am new to the team and was directed to this channel to work on this feature.",
    criteria: [
      "The response orients the newcomer — explains what the feature is, what phase it's in, and the architect's role",
      "The response does NOT list specific spec gaps or blocking issues",
    ],
    deterministicCriteria: [
      {
        label: "Contains feature name",
        mustContain: ["onboarding"],
      },
      {
        label: "Contains phase information",
        mustContain: ["engineering"],
      },
      {
        label: "Does not dump numbered gap list",
        check: (response) => {
          // Should not have numbered findings like "1. Missing error path"
          const numberedFindings = response.match(/^\d+\.\s+(?:Missing|No |Spec |The )/gm)
          return !numberedFindings || numberedFindings.length === 0
        },
      },
      {
        label: "Does not end with a deferral question",
        check: (response) => {
          const lastLine = response.trim().split("\n").pop()?.trim() ?? ""
          const deferrals = ["what would you like", "which option", "how would you like", "what do you think"]
          return !deferrals.some(d => lastLine.toLowerCase().includes(d))
        },
      },
    ],
  },

  // ─── Technical Decisions ────────────────────────────────────────────────────

  {
    name: "Architect answers a specific technical question with a recommendation",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Should onboarding state be its own table or a JSON column on User?",
    history: midDraftHistory,
    criteria: [
      "The response gives a direct recommendation with reasoning — does not say 'it depends' without resolving the dependency",
    ],
    deterministicCriteria: [
      {
        label: "No 'it depends' without resolution",
        check: (response) => {
          if (!response.toLowerCase().includes("it depends")) return true
          // If it says "it depends" it must also resolve the dependency in the same response
          return response.toLowerCase().includes("recommend") || response.toLowerCase().includes("my recommendation")
        },
      },
    ],
  },

  {
    name: "Architect stays within architecture constraints — does not bypass without flagging",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Can we add a REST endpoint for the GitHub OAuth callback instead of going through tRPC?",
    criteria: [
      "The response addresses the constraint that all API access should go through tRPC",
      "The response offers a tRPC-compatible solution or explains why an exception is warranted",
    ],
    deterministicCriteria: [
      {
        label: "Does not silently agree to bypass",
        check: (response) => {
          const lower = response.toLowerCase()
          // Must not just say "sure, let's add a REST endpoint" without flagging the constraint
          if (lower.includes("sure") && lower.includes("rest endpoint") && !lower.includes("constraint")) return false
          return true
        },
      },
    ],
  },

  // ─── Approval / Finalization ────────────────────────────────────────────────

  {
    name: "Architect detects approval and wraps up — no re-confirmation",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "I've reviewed the engineering spec. All looks correct. Approved — let's hand it to the engineers.",
    history: [
      ...midDraftHistory,
      { role: "user" as const, content: "That all looks right to me, approved." },
      { role: "assistant" as const, content: "I ran the readiness audit and everything passes. The engineering spec is complete. Confirming approval now." },
    ],
    criteria: [
      "The response either confirms the spec is approved, references finalization, or mentions saving/locking the spec",
      "The response mentions what comes next — implementation, engineers, build phase, or finalization",
    ],
    deterministicCriteria: [
      {
        label: "No re-confirmation seeking",
        mustNotContain: ["are you sure", "do you want to confirm", "shall I finalize"],
      },
    ],
  },

  // ─── Domain Boundary ────────────────────────────────────────────────────────

  {
    name: "Architect does not make product decisions — escalates to PM",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Should we add SSO support to onboarding instead of email/password?",
    criteria: [
      "The response does NOT unilaterally decide to add SSO — it either declines, redirects, or flags this as outside its domain",
    ],
    deterministicCriteria: [
      {
        label: "Does not make the product decision",
        check: (response) => {
          const lower = response.toLowerCase()
          // Should not say "let's add SSO" or "I'll add SSO" without flagging it as PM-scope
          if ((lower.includes("let's add sso") || lower.includes("i'll add sso")) &&
              !lower.includes("pm") && !lower.includes("product")) return false
          return true
        },
      },
    ],
  },

  {
    name: "Architect does not make design decisions — escalates to designer",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "Should the sign-up form use a modal or a full-page layout?",
    criteria: [
      "The response does NOT unilaterally decide the layout — it either declines, redirects to a design channel, or mentions this is outside the architect's scope",
    ],
    deterministicCriteria: [
      {
        label: "Does not unilaterally decide layout",
        check: (response) => {
          const lower = response.toLowerCase()
          if ((lower.includes("should use a modal") || lower.includes("should use a full-page")) &&
              !lower.includes("design") && !lower.includes("designer")) return false
          return true
        },
      },
    ],
  },

  // ─── Response Quality ───────────────────────────────────────────────────────

  {
    name: "Architect response is concise — not a wall of text",
    agentLabel: "Architect",
    systemPrompt: buildArchitectSystemPrompt(architectContext, FEATURE),
    userMessage: "What's the migration strategy for the onboarding state column?",
    history: midDraftHistory,
    criteria: [
      "The response answers the migration question directly",
      "The response is under 500 words",
    ],
    deterministicCriteria: [
      {
        label: "Under 500 words",
        check: (response) => response.split(/\s+/).length < 500,
      },
      {
        label: "No platform language leaked",
        mustNotContain: ["the platform", "[PLATFORM", "[INTERNAL"],
      },
    ],
  },
]
