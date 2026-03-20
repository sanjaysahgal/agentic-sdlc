import Anthropic from "@anthropic-ai/sdk"
import { Message } from "./conversation-store"

export type AgentType =
  | "pm"
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
