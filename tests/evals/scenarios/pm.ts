import { EvalScenario } from "../runner"
import { setEvalEnv, stubContext, stubContextWithDraft } from "../stub-context"
import { buildPmSystemPrompt } from "../../../agents/pm"

setEvalEnv()

const FEATURE = "onboarding"

const approvedSpecHistory = [
  {
    role: "user" as const,
    content: "We need an onboarding flow for new users.",
  },
  {
    role: "assistant" as const,
    content: `Here's my opening proposal for the onboarding spec:

**Goal:** Get new users to their first meaningful action in under 2 minutes.

**Proposed structure:**
- Sign-up: email + password only (no SSO in v1)
- Sample project auto-loaded on first login
- Optional GitHub connect step (skippable)

## Problem
New users arrive with no context. First-session drop-off is 60%.

## Target Users
Engineering managers evaluating Acme for the first time.

## User Stories
- US-1: As a new user, I can complete sign-up in under 2 minutes
- US-2: As a new user, I see a sample project pre-loaded
- US-3: As a new user, I can connect GitHub during onboarding

## Acceptance Criteria
- Email + password sign-up only
- Sample project auto-created on first login
- GitHub step is optional and skippable

## Non-Goals
- Team invites during onboarding

## Open Questions
None.`,
  },
]

export const pmScenarios: EvalScenario[] = [
  {
    name: "PM opens with a structural proposal on first message",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "We need to build an onboarding flow for new users.",
    criteria: [
      "The response is substantive — it discusses the onboarding feature specifically, not just meta-commentary about process",
      "The response references the product vision or existing platform context (roles, existing features, constraints)",
    ],
    deterministicCriteria: [
      {
        label: "No permission-asking phrases",
        mustNotContain: ["shall I", "would you like me to", "should I proceed"],
      },
      {
        label: "No hedge language",
        mustNotContain: ["what would you like to focus on", "which option do you prefer", "up to you"],
      },
    ],
  },

  {
    name: "PM detects approval intent — no re-confirmation",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "I've reviewed the spec and it's complete. Approved — let's move to design.",
    history: [
      ...approvedSpecHistory,
      { role: "user" as const, content: "Looks good, approved." },
      { role: "assistant" as const, content: "I ran the phase completion audit and everything checks out. The spec is ready for design handoff. Confirming approval now." },
    ],
    criteria: [
      "The response acknowledges the approval OR mentions design/designer/next phase OR references saving/finalizing the spec",
    ],
    deterministicCriteria: [
      {
        label: "No re-confirmation seeking",
        mustNotContain: ["are you sure", "do you want to confirm", "shall I finalize"],
      },
    ],
  },

  {
    name: "PM answers product-level question from vision context",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "What roles does Acme support?",
    criteria: [
      "The response provides specific role information (Manager and/or Contributor) OR redirects to the concierge as an off-topic question",
    ],
    deterministicCriteria: [
      {
        label: "Does not ask user what roles they want",
        mustNotContain: ["what roles would you like", "what roles do you want"],
      },
    ],
  },

  {
    name: "PM pushes back on overloaded scope",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "Let's add payments, AI task suggestions, a mobile app, and team analytics all in this sprint.",
    criteria: [
      "The response pushes back on the scope — does not accept all four items uncritically",
      "The response explains why scope needs to be narrowed OR flags a constraint conflict",
    ],
    deterministicCriteria: [
      {
        label: "Does not say 'sure, let's do all four'",
        check: (response: string) => {
          const lower = response.toLowerCase()
          return !(lower.includes("sure") && lower.includes("all four"))
        },
      },
    ],
  },

  {
    name: "PM reads existing draft and continues from it",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(
      stubContextWithDraft("# Onboarding — Product Spec\n\n## Open Questions\n- [ ] Should the sample project be generic or industry-specific?"),
      FEATURE
    ),
    userMessage: "Make it generic — no industry-specific content in v1.",
    criteria: [
      "The response acknowledges the decision (generic) and does not start the spec over from scratch",
    ],
    deterministicCriteria: [
      {
        label: "Does not ask what generic means",
        mustNotContain: ["what do you mean by generic", "can you clarify what generic means"],
      },
    ],
  },

  {
    name: "PM gives concrete recommendations when answering escalation brief",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "DESIGN TEAM ESCALATION — PM RECOMMENDATIONS NEEDED TO UNBLOCK DESIGN.\n\n1. The spec says 'handle gracefully' for sign-up errors — what specific error UX should the user see?\n2. Should the GitHub step timeout after a specific duration?\n\nFor each numbered item, respond with the same number and your recommendation.",
    criteria: [
      "The response addresses item 1 with a specific recommendation about error UX",
      "The response addresses item 2 with a specific recommendation about timeout",
    ],
    deterministicCriteria: [
      {
        label: "No deferral language",
        mustNotContain: [
          "I cannot responsibly", "need to loop in", "without talking to",
          "it's hard to say without more context",
        ],
      },
    ],
  },

  {
    name: "PM does not make design decisions",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "What color should the sign-up button be?",
    criteria: [
      "The response does NOT specify a color — it either declines, redirects, or says this is a design decision",
    ],
    deterministicCriteria: [
      {
        label: "No platform language leaked",
        mustNotContain: ["the platform", "[PLATFORM", "[INTERNAL"],
      },
    ],
  },
]
