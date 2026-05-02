import { getInProgressFeatures, saveAgentFeedback } from "../../../runtime/github-client"
import { runAgent, UserImage } from "../../../runtime/claude-client"
import { getHistory, appendMessage } from "../../../runtime/conversation-store"
import { buildConciergeSystemPrompt } from "../../../agents/concierge"
import { loadAgentContextForQuery } from "../../../runtime/context-loader"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { withThinking } from "./thinking"
import { logShadowProposalForGeneral } from "../../../runtime/routing/shadow"

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

  // ROUTING V2 SHADOW (Phase 3 Stage 2) — fire-and-forget proposal log; never blocks.
  logShadowProposalForGeneral({ threadTs, rawText: userMessage, user: undefined })

  await withThinking({ client, channelId, threadTs, agent: "Concierge", run: async (update) => {
    const [features, context, history] = await Promise.all([
      getInProgressFeatures(),
      loadAgentContextForQuery(userMessage),
      Promise.resolve(getHistory(featureKey(threadTs))),
    ])

    const systemPrompt = buildConciergeSystemPrompt(features, context)
    // Append user message before the Claude call — if the call fails, the message
    // is still in history so the next attempt has full context.
    appendMessage(featureKey(threadTs), { role: "user", content: userMessage })
    const response = await runAgent({ systemPrompt, history, userMessage, userImages })
    appendMessage(featureKey(threadTs), { role: "assistant", content: response })

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

// Thread-to-agent mapping is persisted in conversation-store.ts (survives bot restarts).
// Import getThreadAgent/setThreadAgent from there — re-export for convenience.
import { getThreadAgent, setThreadAgent } from "../../../runtime/conversation-store"
import { featureKey, threadKey } from "../../../runtime/routing/types"
export { getThreadAgent }

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

// DESIGN-REVIEWED: "Substantive over terse" rule (added 2026-05-01) is a cross-cutting persona instruction. Scale (100 features / 10 agents): rule lives in this one function, applied uniformly to every product-level agent persona via the shared ## Rules section — no per-feature growth, no per-agent growth. Ownership: buildProductLevelPrompt already owns the per-agent persona rules in general channel; no other module competes for this concern. Cross-cutting: yes — all 3 product-level agents (PM, Designer, Architect) inherit the rule via the shared rules section, satisfying Principle 15 cross-agent parity in a single edit instead of 3 separate per-agent persona edits.
export function buildProductLevelPrompt(agent: string, productName: string, context: { productVision: string; systemArchitecture: string }, features?: Array<{ featureName: string; phase: string }>): string {
  const domainMap: Record<string, string> = {
    // DESIGN-REVIEWED: Domain boundaries are strict for decisions (PM decides strategy, architect decides tech). Pipeline status is a summary count — agents can share the count but redirect to the Concierge in the main channel for feature-level details.
    pm: `You are the Product Manager for ${productName}. You own the product vision, strategy, user stories, and acceptance criteria. The user is asking about the product as a whole — not a specific feature. Answer from the product vision and your expertise. If the question is about design (brand, UI, visual system) or architecture (tech stack, infrastructure), redirect them to the appropriate agent. If asked about pipeline status, share the summary count from your context and direct them to the Concierge in the main channel for feature-level details.`,
    // DESIGN-REVIEWED: Designer owns design system and UX patterns. Brand (identity, palette, typography) is the Brand Agent's domain (not yet built — backlog). Designer should not claim brand ownership.
    "ux-design": `You are the UX Designer for ${productName}. You own the design system, interaction patterns, layout principles, component standards, and UX philosophy. You do NOT own brand identity, color palette, or typography — that is the Brand Agent's domain. The user is asking about design at the product level — not a specific feature. Answer from your design expertise. If the question is about brand (colors, fonts, visual identity), tell them the Brand Agent is coming soon. If the question is about product strategy or architecture, redirect them to the appropriate agent. If asked about pipeline status, share the summary count from your context and direct them to the Concierge in the main channel for feature-level details.`,
    architect: `You are the Architect for ${productName}. You own the system architecture, tech stack decisions, data model, API design, infrastructure, and engineering principles. The user is asking about architecture at the product level — not a specific feature. Answer from the system architecture document and your expertise. If the question is about product strategy or design, redirect them to the appropriate agent. If asked about pipeline status, share the summary count from your context and direct them to the Concierge in the main channel for feature-level details.`,
  }

  const domain = domainMap[agent] ?? domainMap.pm

  return `${domain}

## Product Context

### Product Vision
${context.productVision || "(No product vision document found.)"}

### System Architecture
${context.systemArchitecture || "(No system architecture document found.)"}

### Current Pipeline Status
${// DESIGN-REVIEWED: Summary count only — individual feature details are the concierge's job. Scales to 100+ features without token growth.
features && features.length > 0
    ? `${features.length} feature${features.length === 1 ? "" : "s"} in progress. For details on specific features, the user can ask the Concierge in the main channel.`
    : "No features currently in progress."}

## Rules
- You are a senior expert. Give opinionated recommendations, not open-ended questions.
- This is a product-level conversation — no feature specs, no draft branches.
- If the user wants to work on a specific feature, direct them to the appropriate #feature-* channel.
- **Substantive over terse.** When the user asks an explanatory question (constraints, principles, architecture choices, "why" questions), give context with each item — explain the rationale, the tradeoff, or the reason it matters. A bare bullet list with one-line labels is not an answer; it is an outline. A senior expert teaches as they answer.
- Keep responses focused (no rambling) but never sacrifice substance for brevity.
- You can discuss, analyze, and recommend changes to any document in your domain (vision, architecture, brand). If the user asks you to make an edit, format your recommendation as ready-to-paste content and explain that direct document editing is coming soon. Never refuse product-level work as "outside your lane" — you own it.
- Never reference agents that don't exist. The available agents are: Product Manager (\`/pm\`), UX Designer (\`/design\`), and Architect (\`/architect\`). Do not invent others.`
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

  // ROUTING V2 SHADOW (Phase 3 Stage 2) — emit proposal log for the slash-spawned agent invocation.
  const entryHint = agent === "pm" ? "/pm" : agent === "ux-design" ? "/design" : agent === "architect" ? "/architect" : undefined
  logShadowProposalForGeneral({ threadTs, rawText: userMessage, user: undefined, entryHint })

  // Save agent for this thread — follow-up messages route here instead of concierge
  setThreadAgent(threadKey(threadTs), agent)

  console.log(`[ROUTER] product-level-agent: ${agent} (${displayName}) in general:${threadTs} msg="${userMessage.slice(0, 100)}"`)

  await withThinking({ client, channelId, threadTs, agent: displayName, run: async (update) => {
    const [context, features, history] = await Promise.all([
      loadAgentContextForQuery(userMessage),
      getInProgressFeatures(),
      Promise.resolve(getHistory(featureKey(`general:${threadTs}`))),
    ])

    const { productName } = loadWorkspaceConfig()
    const systemPrompt = buildProductLevelPrompt(agent, productName, context, features)

    appendMessage(featureKey(`general:${threadTs}`), { role: "user", content: userMessage })
    console.log(`[CONTEXT] product-level ${agent}: loaded vision=${context.productVision ? "yes" : "no"} arch=${context.systemArchitecture ? "yes" : "no"} history=${history.length} msgs`)
    const response = await runAgent({ systemPrompt, history, userMessage, userImages })
    appendMessage(featureKey(`general:${threadTs}`), { role: "assistant", content: response })

    await update(response)
  }})
}
