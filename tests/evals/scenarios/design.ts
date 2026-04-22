import { EvalScenario } from "../runner"
import { setEvalEnv, stubContext, stubContextWithDraft, approvedProductSpec } from "../stub-context"
import { buildDesignSystemPrompt } from "../../../agents/design"

setEvalEnv()

const FEATURE = "onboarding"

const designContext = stubContextWithDraft(`## Approved Product Spec\n${approvedProductSpec}`)

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

## Screens

### Screen 1: Landing / Sign-up
Centered card. Email + password fields. "Create account" CTA. No nav shell.

### Screen 2: GitHub Connect
Full-screen OAuth prompt. "Skip for now" link at bottom.

### Screen 3: Redirect
Toast: "Your sample project is ready." Auto-redirect to task board in 2s.

## User Flows

### Flow: US-1 — New user sign-up
Landing → fill email/password → submit → GitHub step → task board

### Flow: US-2 — Skip GitHub
Landing → submit → GitHub step → click Skip → task board

## Open Questions
- [type: design] [blocking: no] Confirm exact wordmark size in Figma before implementation.`,
  },
]

export const designScenarios: EvalScenario[] = [
  {
    name: "Design agent opens with a concrete proposal on first message",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "I'm the designer — let's start the onboarding design.",
    criteria: [
      "The response discusses specific screens, flows, or visual components for the onboarding feature",
      "The response references the product spec (user stories, acceptance criteria, or features from it)",
    ],
    deterministicCriteria: [
      {
        label: "No permission-asking phrases",
        mustNotContain: ["shall I", "would you like me to", "should I proceed"],
      },
      {
        label: "No hedge language",
        mustNotContain: ["what would you like to focus on", "which option do you prefer"],
      },
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
    ],
    deterministicCriteria: [
      {
        label: "Makes a recommendation, does not just ask",
        check: (response: string) => {
          const lower = response.toLowerCase()
          return !lower.includes("what would you like") && !lower.includes("what do you prefer")
        },
      },
    ],
  },

  {
    name: "Design agent addresses animation with specific timing",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "How should the sign-up form animate in?",
    history: midDraftHistory,
    criteria: [
      "The response specifies animation details — at minimum a direction (fade/slide) and duration",
    ],
    deterministicCriteria: [
      {
        label: "Contains numeric timing",
        check: (response: string) => /\d+\s*ms|\d+(\.\d+)?\s*s\b/.test(response),
      },
    ],
  },

  {
    name: "Design agent does not make product decisions",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "Should we allow social login instead of email/password?",
    criteria: [
      "The response does NOT unilaterally add social login — it either declines, redirects, or flags this as a product/PM decision",
    ],
    deterministicCriteria: [
      {
        label: "Does not unilaterally change product scope",
        check: (response: string) => {
          const lower = response.toLowerCase()
          return !(lower.includes("let's add social login") || lower.includes("i'll add social login"))
        },
      },
    ],
  },

  {
    name: "Design agent does not make architecture decisions",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "Should we store onboarding state in localStorage or the database?",
    criteria: [
      "The response does NOT make the storage decision — it either declines, redirects, or says this is a technical/architecture decision",
    ],
    deterministicCriteria: [
      {
        label: "No platform language leaked",
        mustNotContain: ["the platform", "[PLATFORM", "[INTERNAL"],
      },
    ],
  },

  {
    name: "Design agent detects approval and wraps up",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "I've reviewed the design spec. Everything is solid. Approved — let's move to engineering.",
    history: [
      ...midDraftHistory,
      { role: "user" as const, content: "This looks great, approved." },
      { role: "assistant" as const, content: "Readiness audit passed. The design spec is complete. Confirming approval now." },
    ],
    criteria: [
      "The response acknowledges the approval OR mentions engineering/architect/next phase OR references saving/finalizing the spec",
    ],
    deterministicCriteria: [
      {
        label: "No re-confirmation seeking",
        mustNotContain: ["are you sure", "do you want to confirm"],
      },
    ],
  },

  {
    name: "Design agent response is concise",
    agentLabel: "Design",
    systemPrompt: buildDesignSystemPrompt(designContext, FEATURE),
    userMessage: "What's the empty state for the task board?",
    criteria: [
      "The response describes a specific empty state design — what the user sees when there are no tasks",
    ],
    deterministicCriteria: [
      {
        label: "Under 500 words",
        check: (response: string) => response.split(/\s+/).length < 500,
      },
      {
        label: "No platform language leaked",
        mustNotContain: ["the platform", "[PLATFORM", "[INTERNAL"],
      },
    ],
  },
]
