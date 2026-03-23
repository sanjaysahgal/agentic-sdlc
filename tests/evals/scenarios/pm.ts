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

**Open questions I'll need answered:**
- Should the sample project be generic or industry-specific?
- Is there a specific metric that defines "onboarding success" for the team?

DRAFT_SPEC_START
# Onboarding — Product Spec

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
None.
DRAFT_SPEC_END`,
  },
]

export const pmScenarios: EvalScenario[] = [
  {
    name: "PM opens with a structural proposal on first message",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "We need to build an onboarding flow for new users.",
    criteria: [
      "The response leads with a concrete structural proposal or initial spec structure — not a list of clarifying questions",
      "The response does not end with 'Shall I?', 'Would you like me to?', or any permission-asking phrase",
      "The response mentions user stories, acceptance criteria, or a specific user goal",
    ],
  },
  {
    name: "PM detects approval intent and saves the spec",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "Looks good, approved.",
    history: approvedSpecHistory,
    criteria: [
      "The response does not ask 'Are you sure?' or request further confirmation before approving",
      "The response contains INTENT: CREATE_SPEC or references saving/approving the spec",
      "The response mentions what happens next — the design phase or UX designer",
    ],
  },
  {
    name: "PM answers product-level question from vision context",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "What roles does Acme support?",
    criteria: [
      "The response answers from the product vision — mentions Manager and Contributor roles",
      "The response does not ask the user what roles they want (it knows the answer from context)",
      "The response is concise — does not produce a full spec",
    ],
  },
  {
    name: "PM pushes back on a vague or overloaded brief",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "Let's add payments, AI task suggestions, a mobile app, and team analytics all in this sprint.",
    criteria: [
      "The response pushes back on the scope — does not accept all four items uncritically",
      "The response asks the user to prioritize or pick one item to start",
      "The response explains why scope needs to be narrowed (spec quality, delivery risk, or prior constraints)",
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
      "The response acknowledges the open question being resolved",
      "The response updates or references the spec rather than starting over",
      "The response does not ask what the user means by 'generic'",
    ],
  },
]
