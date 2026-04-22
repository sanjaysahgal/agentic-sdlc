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
  // ─── Opening / Proposal ─────────────────────────────────────────────────────

  {
    name: "PM opens with a structural proposal on first message",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "We need to build an onboarding flow for new users.",
    criteria: [
      "The response leads with a concrete structural proposal or initial spec structure — not a list of clarifying questions",
      "The response mentions user stories, acceptance criteria, or a specific user goal",
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

  // ─── Approval ───────────────────────────────────────────────────────────────

  {
    name: "PM detects approval intent — no re-confirmation",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "Looks good, approved.",
    history: approvedSpecHistory,
    criteria: [
      "The response mentions what happens next — the design phase or UX designer",
    ],
    deterministicCriteria: [
      {
        label: "No re-confirmation seeking",
        mustNotContain: ["are you sure", "do you want to confirm", "shall I finalize"],
      },
    ],
  },

  // ─── Context Retrieval ──────────────────────────────────────────────────────

  {
    name: "PM answers product-level question from vision context",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "What roles does Acme support?",
    criteria: [
      "The response answers from the product vision — mentions Manager and Contributor roles",
      "The response is concise — does not produce a full spec",
    ],
    deterministicCriteria: [
      {
        label: "Does not ask user what roles they want",
        mustNotContain: ["what roles would you like", "what roles do you want", "what roles should"],
      },
    ],
  },

  // ─── Scope Control ──────────────────────────────────────────────────────────

  {
    name: "PM pushes back on overloaded scope",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "Let's add payments, AI task suggestions, a mobile app, and team analytics all in this sprint.",
    criteria: [
      "The response pushes back on the scope — does not accept all four items uncritically",
      "The response asks the user to prioritize or pick one item to start",
      "The response explains why scope needs to be narrowed",
    ],
    deterministicCriteria: [
      {
        label: "Does not say 'sure, let's do all four'",
        check: (response) => {
          const lower = response.toLowerCase()
          return !(lower.includes("sure") && lower.includes("all four"))
        },
      },
    ],
  },

  // ─── Draft Continuation ─────────────────────────────────────────────────────

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
    ],
    deterministicCriteria: [
      {
        label: "Does not ask what generic means",
        mustNotContain: ["what do you mean by generic", "can you clarify what generic means"],
      },
    ],
  },

  // ─── Escalation Response (PM answering design team's question) ──────────────

  {
    name: "PM gives concrete recommendations when answering escalation brief",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "DESIGN TEAM ESCALATION — PM RECOMMENDATIONS NEEDED TO UNBLOCK DESIGN.\n\n1. The spec says 'handle gracefully' for sign-up errors — what specific error UX should the user see?\n2. Should the GitHub step timeout after a specific duration?\n\nFor each numbered item, respond with the same number and your recommendation.",
    criteria: [
      "The response provides a concrete recommendation for item 1 (specific error UX)",
      "The response provides a concrete recommendation for item 2 (timeout duration or explicit 'no timeout')",
    ],
    deterministicCriteria: [
      {
        label: "Contains 'My recommendation:' for each item",
        check: (response) => {
          const count = (response.match(/my recommendation:/gi) ?? []).length
          return count >= 2
        },
      },
      {
        label: "No deferral language",
        mustNotContain: [
          "I cannot responsibly", "need to loop in", "without talking to",
          "I'd need more context", "it's hard to say",
        ],
      },
    ],
  },

  // ─── Domain Boundary ────────────────────────────────────────────────────────

  {
    name: "PM does not make design decisions",
    agentLabel: "PM",
    systemPrompt: buildPmSystemPrompt(stubContext, FEATURE),
    userMessage: "What color should the sign-up button be?",
    criteria: [
      "The response recognizes this is a design decision — not a product decision",
      "The response defers to the designer or notes this is outside the PM's domain",
    ],
    deterministicCriteria: [
      {
        label: "No platform language leaked",
        mustNotContain: ["the platform", "[PLATFORM", "[INTERNAL"],
      },
    ],
  },
]
