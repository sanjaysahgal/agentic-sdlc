import { EvalScenario } from "../runner"
import { setEvalEnv, stubContext } from "../stub-context"
import { buildConciergeSystemPrompt } from "../../../agents/concierge"
import type { FeatureStatus } from "../../../runtime/github-client"

setEvalEnv()

const features: FeatureStatus[] = [
  { featureName: "onboarding", phase: "design-in-progress" },
  { featureName: "task-templates", phase: "product-spec-in-progress" },
]

const noFeatures: FeatureStatus[] = []

export const conciergeScenarios: EvalScenario[] = [
  {
    name: "Concierge describes in-progress features with phases and channels",
    agentLabel: "Concierge",
    systemPrompt: buildConciergeSystemPrompt(features, stubContext),
    userMessage: "What's currently in progress?",
    criteria: [
      "The response lists both features: onboarding and task-templates",
      "The response describes the phase for each feature (design in progress, product spec in progress)",
      "The response mentions the relevant feature channels (#feature-onboarding, #feature-task-templates)",
    ],
  },
  {
    name: "Concierge guides a designer to the right channel",
    agentLabel: "Concierge",
    systemPrompt: buildConciergeSystemPrompt(features, stubContext),
    userMessage: "Hey, I'm the UX designer for the onboarding feature.",
    criteria: [
      "The response directs the designer to #feature-onboarding",
      "The response explains that the design phase is active and the designer can start immediately",
      "The response does not send the designer somewhere irrelevant",
    ],
  },
  {
    name: "Concierge explains the system to a first-time visitor",
    agentLabel: "Concierge",
    systemPrompt: buildConciergeSystemPrompt(features, stubContext),
    userMessage: "What is this system and how does it work?",
    criteria: [
      "The response explains the spec chain — product spec to design to engineering",
      "The response explains that feature work happens in #feature-* channels",
      "The response is welcoming and does not require prior context to understand",
    ],
  },
  {
    name: "Concierge handles no features in progress gracefully",
    agentLabel: "Concierge",
    systemPrompt: buildConciergeSystemPrompt(noFeatures, stubContext),
    userMessage: "What's the status of the platform?",
    criteria: [
      "The response acknowledges there are no features currently in progress",
      "The response explains how to start a new feature (go to a feature channel or start a brief)",
      "The response does not fabricate features that don't exist",
    ],
  },
]
