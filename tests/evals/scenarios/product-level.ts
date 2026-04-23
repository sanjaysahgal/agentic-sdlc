import { EvalScenario } from "../runner"
import { setEvalEnv, stubContext } from "../stub-context"
import { buildProductLevelPrompt } from "../../../interfaces/slack/handlers/general"

setEvalEnv()

const PRODUCT_NAME = "Acme"

export const productLevelScenarios: EvalScenario[] = [
  {
    name: "PM agent answers product vision question from general channel",
    agentLabel: "PM (product-level)",
    systemPrompt: buildProductLevelPrompt("pm", PRODUCT_NAME, stubContext),
    userMessage: "What are the non-negotiable constraints for Acme?",
    criteria: [
      "The response references specific constraints from the product vision (mobile-first, no AI suggestions in v1, GitHub/Slack integration, single-tenant)",
      "The response does not reference any specific feature spec or draft branch",
      "The response gives an opinionated recommendation or context — not just a list",
    ],
    deterministicCriteria: [
      {
        label: "Does not claim to be a designer or architect",
        mustNotContain: ["I'm the designer", "I'm the architect", "as your architect"],
      },
    ],
  },
  {
    name: "Design agent answers brand/design system question from general channel",
    agentLabel: "Design (product-level)",
    systemPrompt: buildProductLevelPrompt("ux-design", PRODUCT_NAME, stubContext),
    userMessage: "What should our design system principles be for Acme?",
    criteria: [
      "The response discusses design system concepts (typography, spacing, components, visual language, or brand)",
      "The response does not make product strategy decisions (pricing, target users, go-to-market)",
      "The response gives concrete, opinionated design recommendations",
    ],
    deterministicCriteria: [
      {
        label: "Does not claim to be a PM or architect",
        mustNotContain: ["I'm the product manager", "I'm the architect", "as your PM"],
      },
    ],
  },
  {
    name: "Architect agent answers architecture question from general channel",
    agentLabel: "Architect (product-level)",
    systemPrompt: buildProductLevelPrompt("architect", PRODUCT_NAME, stubContext),
    userMessage: "Should we add a caching layer for Acme?",
    criteria: [
      "The response discusses caching in the context of the existing architecture (Next.js, tRPC, Supabase)",
      "The response does not make product decisions (what features to build, user stories)",
      "The response gives a specific recommendation with justification — not 'it depends'",
    ],
    deterministicCriteria: [
      {
        label: "Does not claim to be a PM or designer",
        mustNotContain: ["I'm the product manager", "I'm the designer", "as your PM"],
      },
    ],
  },
]
