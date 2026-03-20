import { loadAgentContext } from "../../../runtime/context-loader"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec } from "../../../agents/pm"
import { createSpecPR, saveDraftSpec, getInProgressFeatures } from "../../../runtime/github-client"
import { classifyIntent, detectPhase, AgentType } from "../../../runtime/agent-router"

function getFeatureName(channelName: string): string {
  return channelName.replace(/^feature-/, "")
}

export type ChannelState = {
  productSpecApproved: boolean
  engineeringSpecApproved: boolean
  pendingAgent: AgentType | null
  pendingMessage: string | null
  pendingThreadTs: string | null
}

export const channelStateStore = new Map<string, ChannelState>()

export function getChannelState(channelName: string): ChannelState {
  return channelStateStore.get(channelName) ?? {
    productSpecApproved: false,
    engineeringSpecApproved: false,
    pendingAgent: null,
    pendingMessage: null,
    pendingThreadTs: null,
  }
}

export function setChannelState(channelName: string, state: ChannelState): void {
  channelStateStore.set(channelName, state)
}

// Builds a plain-English routing note explaining which agent is handling this and why.
// Falls back gracefully if GitHub is unavailable.
async function buildRoutingNote(featureName: string, agent: AgentType): Promise<string> {
  let phaseDescription = "the product spec is being shaped"
  let nextStep = "once approved, a UX designer will produce the screens and flows before any engineering begins"

  try {
    const features = await getInProgressFeatures()
    const feature = features.find((f) => f.featureName === featureName)
    if (feature?.phase === "product-spec-approved-awaiting-design") {
      phaseDescription = "the product spec is approved and design is the next step"
      nextStep = "once the design spec is approved, an architect will produce the engineering plan"
    }
  } catch {
    // GitHub unavailable — use defaults
  }

  const agentLabel = agent === "pm" ? "product specialist" : agent

  return `_Routing to the **${agentLabel}** — ${phaseDescription}. ${nextStep}._\n_If you'd like a different specialist, just say so — I'll explain or accommodate._\n\n---`
}

export async function handleFeatureChannelMessage(params: {
  channelName: string
  threadTs: string
  userMessage: string
  channelId: string
  client: any
  channelState: ChannelState
}): Promise<void> {
  const { channelName, threadTs, userMessage, channelId, client, channelState } = params

  const confirmedAgent = getConfirmedAgent(threadTs)

  // Confirmed agent — run directly, no overhead
  if (confirmedAgent === "pm") {
    await runPmAgent({ channelName, channelId, threadTs, userMessage, client })
    return
  }

  if (confirmedAgent) {
    // Agent confirmed but not yet implemented
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `The *${confirmedAgent} agent* is coming soon. The product specialist is active right now — ask anything about the product spec.`,
    })
    return
  }

  // New thread — classify, explain routing, run agent
  const phase = detectPhase({
    productSpecApproved: channelState.productSpecApproved,
    engineeringSpecApproved: channelState.engineeringSpecApproved,
  })
  const history = getHistory(threadTs)
  const suggestedAgent = await classifyIntent({ message: userMessage, history, phase })

  setConfirmedAgent(threadTs, suggestedAgent)

  const routingNote = await buildRoutingNote(getFeatureName(channelName), suggestedAgent)

  if (suggestedAgent === "pm") {
    await runPmAgent({ channelName, channelId, threadTs, userMessage, client, routingNote })
    return
  }

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `${routingNote}\n\nThe *${suggestedAgent} agent* is coming soon. The product specialist is active right now.`,
  })
}

async function runPmAgent(params: {
  channelName: string
  channelId: string
  threadTs: string
  userMessage: string
  client: any
  routingNote?: string
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, client, routingNote } = params
  const featureName = getFeatureName(channelName)
  const context = await loadAgentContext(featureName)
  const systemPrompt = buildPmSystemPrompt(context, featureName)
  const history = getHistory(threadTs)

  const response = await runAgent({ systemPrompt, history, userMessage })
  appendMessage(threadTs, { role: "user", content: userMessage })
  appendMessage(threadTs, { role: "assistant", content: response })

  const filePath = `specs/features/${featureName}/${featureName}.product.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""

  if (hasDraftSpec(response)) {
    const draftContent = extractDraftSpec(response)
    await saveDraftSpec({ featureName, filePath, content: draftContent })
    const cleanResponse = response.replace(/DRAFT_SPEC_START[\s\S]*?DRAFT_SPEC_END/g, "").trim()
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `${prefix}${cleanResponse}\n\n_Draft saved to \`${filePath}\`._`,
    })
    return
  }

  if (isCreateSpecIntent(response)) {
    const specContent = extractSpecContent(response)
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `${prefix}Saving the final spec and sending it for review...` })
    const prUrl = await createSpecPR({
      featureName,
      filePath,
      content: specContent,
      prTitle: `[SPEC] ${featureName} · product.md`,
      prBody: `Product spec for **${featureName}**.\n\nShaped in #feature-${featureName}.\n\n**Checklist:**\n- [ ] Aligns with product vision\n- [ ] Personas correctly identified\n- [ ] Acceptance criteria are testable\n- [ ] Non-goals are explicit`,
    })
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `The spec is saved and ready for review: ${prUrl}\n\nOnce approved, the design phase begins — a UX designer will produce the screens and flows before any engineering starts.`,
    })
    return
  }

  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `${prefix}${response}` })
}
