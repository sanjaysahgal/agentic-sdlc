import Anthropic from "@anthropic-ai/sdk"
import { Message } from "./conversation-store"

export type AgentType =
  | "pm"
  | "ux-design"
  | "architect"
  | "backend"
  | "frontend"
  | "qa"
  | "pgm"
  | "spec-validator"
  | "eng-mgr"
  | "infra"
  | "data"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const AGENT_DESCRIPTIONS: Record<AgentType, string> = {
  pm: "Product Manager — shapes feature briefs into product specs",
  "ux-design": "UX Design — shapes approved product specs into design specs: screens, flows, states, component decisions",
  architect: "Architect — designs engineering specs, data models, API contracts",
  backend: "Backend Engineer — tRPC procedures, Prisma, server logic",
  frontend: "Frontend Engineer — components, pages, UI logic",
  qa: "QA — test plans, edge cases, acceptance testing",
  pgm: "Program Manager — generates and tracks work items from approved specs",
  "spec-validator": "Spec Validator — checks specs for conflicts with architecture and product vision",
  "eng-mgr": "Engineering Manager — activates and assigns work items to domain agents",
  infra: "Infra Engineer — deployment pipeline, CI/CD, environment configuration",
  data: "Data Engineer — Prisma schema, migrations, data model decisions",
}

// Uses Claude to classify which agent should handle the message.
// Returns the agent type and its confidence reasoning.
export async function classifyIntent(params: {
  message: string
  history: Message[]
  phase: "briefing" | "engineering" | "implementation" | "qa"
}): Promise<AgentType> {
  const { message, history, phase } = params

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001", // Fast, cheap — classification only
    max_tokens: 50,
    system: `You classify which SDLC agent should handle a message. Current phase: ${phase}.
Agents: pm, architect, backend, frontend, qa, pgm, spec-validator, eng-mgr, infra, data.
Respond with exactly one agent name, nothing else.`,
    messages: [
      ...history.slice(-4).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: message },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "pm"
  const valid: AgentType[] = ["pm", "architect", "backend", "frontend", "qa", "pgm", "spec-validator", "eng-mgr", "infra", "data"]
  return valid.includes(text as AgentType) ? (text as AgentType) : "pm"
}

// Classifies whether a message is a product-level question (vision, architecture, principles)
// or a feature-specific question (spec shaping, open questions, user stories).
// Used in feature channels to decide whether to answer directly or route to context.
export async function classifyMessageScope(message: string): Promise<"product-context" | "feature-specific"> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 20,
    system: `Classify whether this message is asking about the product as a whole, or about a specific feature being built.
- product-context: questions about product vision, architecture principles, tech stack, roadmap, what the product is, why it exists, who it's for, non-negotiable constraints
- feature-specific: questions about a specific feature's spec, user stories, acceptance criteria, open questions, design, implementation
Respond with exactly one: product-context or feature-specific`,
    messages: [{ role: "user", content: message }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "feature-specific"
  return text === "product-context" ? "product-context" : "feature-specific"
}

// Classifies user intent when the product spec is already approved.
// Returns one of three intents:
//   "start-design" — user wants to begin the design phase
//   "spec-query"   — user is asking a question about the spec content
//   "status"       — user is asking about the current state of the feature
export async function classifyApprovedPhaseIntent(message: string): Promise<"start-design" | "spec-query" | "proposal" | "status"> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 20,
    system: `The product spec for this feature is approved. A user has sent a message.
Classify their intent as exactly one of: start-design, spec-query, proposal, status
- start-design: they want to begin or acknowledge the design phase (e.g. "let's go", "I'm the designer", "next phase", "ok let's start")
- spec-query: they are asking a read-only question about the spec content (e.g. "what are the open questions", "show me acceptance criteria", "what's in the spec")
- proposal: they are proposing a change, addition, or new idea that could affect the spec or product direction (e.g. "thinking of adding X", "what if we did Y", "can we include Z", "thoughts on adding")
- status: they are asking about the current state or what happens next (e.g. "what's the status", "where are we", "what's next")
Respond with exactly one word: start-design, spec-query, proposal, or status`,
    messages: [{ role: "user", content: message }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "status"
  const valid = ["start-design", "spec-query", "proposal", "status"] as const
  return valid.includes(text as (typeof valid)[number]) ? (text as (typeof valid)[number]) : "status"
}

// Detects whether a message is off-topic for a specialist agent (design or architect).
// "Off-topic" means: status queries, general progress questions, concierge-type requests —
// anything that does not require loading full spec context and running a large prompt.
// Used as a short-circuit gate before expensive context loading.
// Detects whether a message is off-topic for a specialist agent (design or architect).
// "Off-topic" means ONLY cross-feature or global status queries — not questions about
// this feature's spec. Asking "show me the current design spec" or "where are we in
// the design" is ON-TOPIC — the agent owns that content and can show it.
// Only redirect when the user is clearly asking about a different scope entirely.
export async function isOffTopicForAgent(message: string, agentDomain: "design" | "engineering"): Promise<boolean> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    system: `You are deciding whether to redirect a message away from a ${agentDomain === "design" ? "UX Design" : "Architect"} agent.
Only redirect (off-topic) if the message is asking about OTHER features, the overall platform status, or something completely outside this feature.
Do NOT redirect if the message is about this feature's ${agentDomain === "design" ? "design spec, screens, flows, decisions, or current design state" : "engineering spec, data model, APIs, or current engineering state"} — even if it's a read request like "show me the spec" or "what have we decided".
Off-topic (redirect): "what features are in progress", "give me all in-progress specs", "what's the overall status", "what's been approved across the platform"
On-topic (keep): "show me the design spec", "latest on the design", "where are we in the design", "what have we decided", "what's in the spec", "summarize the design so far", any design or engineering question
Respond with exactly one word: off-topic or on-topic`,
    messages: [{ role: "user", content: message }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim().toLowerCase() : "on-topic"
  return text === "off-topic"
}

export function detectPhase(params: {
  productSpecApproved: boolean
  engineeringSpecApproved: boolean
}): "briefing" | "engineering" | "implementation" | "qa" {
  if (!params.productSpecApproved) return "briefing"
  if (!params.engineeringSpecApproved) return "engineering"
  return "implementation"
}

export function getAgentDescriptions(): Record<AgentType, string> {
  return AGENT_DESCRIPTIONS
}
