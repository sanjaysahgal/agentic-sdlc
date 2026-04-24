import { getInProgressFeatures, saveAgentFeedback } from "../../../runtime/github-client"
import { runAgent, UserImage } from "../../../runtime/claude-client"
import { getHistory, appendMessage } from "../../../runtime/conversation-store"
import { buildConciergeSystemPrompt } from "../../../agents/concierge"
import { loadAgentContextForQuery } from "../../../runtime/context-loader"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { withThinking } from "./thinking"

// Handles messages in non-feature channels (e.g. #all-health360).
// Acts as the front door — explains the system, identifies the person's role,
// and tells them exactly what they can act on right now.

export async function handleGeneralChannelMessage(params: {
  channelId: string
  threadTs: string
  userMessage: string
  userImages?: UserImage[]
  client: any
}): Promise<void> {
  const { channelId, threadTs, userMessage, userImages, client } = params

  await withThinking({ client, channelId, threadTs, agent: "Concierge", run: async (update) => {
    const [features, context, history] = await Promise.all([
      getInProgressFeatures(),
      loadAgentContextForQuery(userMessage),
      Promise.resolve(getHistory(threadTs)),
    ])

    const systemPrompt = buildConciergeSystemPrompt(features, context)
    // Append user message before the Claude call — if the call fails, the message
    // is still in history so the next attempt has full context.
    appendMessage(threadTs, { role: "user", content: userMessage })
    const response = await runAgent({ systemPrompt, history, userMessage, userImages })
    appendMessage(threadTs, { role: "assistant", content: response })

    // Extract and log any agent feedback the concierge detected
    const feedbackMatch = response.match(/\nAGENT_FEEDBACK: (.+)$/s)
    if (feedbackMatch) {
      const feedbackText = feedbackMatch[1].trim()
      await saveAgentFeedback({ feedback: feedbackText })
    }
    const cleanResponse = response.replace(/\nAGENT_FEEDBACK: .+$/s, "").trim()

    await update(cleanResponse)
  }})
}

// ────────────────────────────────────────────────────────────────────────────────
// Thread-to-agent mapping — tracks which agent owns a general channel thread.
// When a slash command starts a thread, the agent is saved here. Follow-up
// messages in that thread route to the same agent instead of the concierge.
// ────────────────────────────────────────────────────────────────────────────────

const threadAgentMap = new Map<string, "pm" | "ux-design" | "architect">()

/** Get the agent that owns a general channel thread (if any). */
export function getThreadAgent(threadTs: string): "pm" | "ux-design" | "architect" | null {
  return threadAgentMap.get(threadTs) ?? null
}

/** Set the agent that owns a general channel thread. */
export function setThreadAgent(threadTs: string, agent: "pm" | "ux-design" | "architect"): void {
  threadAgentMap.set(threadTs, agent)
  console.log(`[ROUTER] thread-agent: set ${agent} for general:${threadTs}`)
}

// ────────────────────────────────────────────────────────────────────────────────
// Product-level agent conversations — invoked via slash commands in the general channel.
// Each agent stays in its domain: PM → vision/product strategy, Design → brand/design system,
// Architect → system architecture/tech decisions.
// ────────────────────────────────────────────────────────────────────────────────

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  pm: "Product Manager",
  "ux-design": "UX Designer",
  architect: "Architect",
}

export function buildProductLevelPrompt(agent: string, productName: string, context: { productVision: string; systemArchitecture: string }): string {
  const domainMap: Record<string, string> = {
    pm: `You are the Product Manager for ${productName}. You own the product vision, strategy, user stories, and acceptance criteria. The user is asking about the product as a whole — not a specific feature. Answer from the product vision and your expertise. If the question is about design (brand, UI, visual system) or architecture (tech stack, infrastructure), redirect them to the appropriate agent.`,
    "ux-design": `You are the UX Designer for ${productName}. You own the brand identity, design system, visual language, typography, color palette, and interaction patterns. The user is asking about design at the product level — not a specific feature. Answer from the brand guidelines and your expertise. If the question is about product strategy or architecture, redirect them to the appropriate agent.`,
    architect: `You are the Architect for ${productName}. You own the system architecture, tech stack decisions, data model, API design, infrastructure, and engineering principles. The user is asking about architecture at the product level — not a specific feature. Answer from the system architecture document and your expertise. If the question is about product strategy or design, redirect them to the appropriate agent.`,
  }

  const domain = domainMap[agent] ?? domainMap.pm

  return `${domain}

## Product Context

### Product Vision
${context.productVision || "(No product vision document found.)"}

### System Architecture
${context.systemArchitecture || "(No system architecture document found.)"}

## Rules
- You are a senior expert. Give opinionated recommendations, not open-ended questions.
- This is a product-level conversation — no feature specs, no draft branches.
- If the user wants to work on a specific feature, direct them to the appropriate #feature-* channel.
- Keep responses concise and actionable.`
}

export async function handleGeneralChannelAgentMessage(params: {
  channelId: string
  threadTs: string
  userMessage: string
  userImages?: UserImage[]
  client: any
  agent: "pm" | "ux-design" | "architect"
}): Promise<void> {
  const { channelId, threadTs, userMessage, userImages, client, agent } = params
  const displayName = AGENT_DISPLAY_NAMES[agent] ?? "Agent"

  // Save agent for this thread — follow-up messages route here instead of concierge
  setThreadAgent(threadTs, agent)

  console.log(`[ROUTER] product-level-agent: ${agent} (${displayName}) in general:${threadTs} msg="${userMessage.slice(0, 100)}"`)

  await withThinking({ client, channelId, threadTs, agent: displayName, run: async (update) => {
    const [context, history] = await Promise.all([
      loadAgentContextForQuery(userMessage),
      Promise.resolve(getHistory(`general:${threadTs}`)),
    ])

    const { productName } = loadWorkspaceConfig()
    const systemPrompt = buildProductLevelPrompt(agent, productName, context)

    appendMessage(`general:${threadTs}`, { role: "user", content: userMessage })
    console.log(`[CONTEXT] product-level ${agent}: loaded vision=${context.productVision ? "yes" : "no"} arch=${context.systemArchitecture ? "yes" : "no"} history=${history.length} msgs`)
    const response = await runAgent({ systemPrompt, history, userMessage, userImages })
    appendMessage(`general:${threadTs}`, { role: "assistant", content: response })

    await update(response)
  }})
}
