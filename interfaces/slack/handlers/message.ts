import { loadAgentContext } from "../../../runtime/context-loader"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec } from "../../../agents/pm"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, getInProgressFeatures } from "../../../runtime/github-client"
import { classifyIntent, detectPhase, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"

function getFeatureName(channelName: string): string {
  return channelName.replace(/^feature-/, "")
}

// Returns the current phase of a feature by reading GitHub state.
// Falls back to "product-spec-in-progress" if GitHub is unavailable.
async function getFeaturePhase(featureName: string): Promise<string> {
  try {
    const features = await getInProgressFeatures()
    return features.find((f) => f.featureName === featureName)?.phase ?? "product-spec-in-progress"
  } catch {
    return "product-spec-in-progress"
  }
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

  // Confirmed agent — check phase first, then run
  if (confirmedAgent === "pm") {
    // If the product spec is already approved, the pm agent's job is done.
    // Redirect to the current phase rather than re-opening spec shaping.
    const currentPhase = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhase === "product-spec-approved-awaiting-design") {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `The product spec for *${getFeatureName(channelName)}* is already approved. :white_check_mark:\n\nThe next step is UX design — a designer needs to produce the screens and user flows before any engineering begins. If you're wearing the designer hat, just say so here and the design phase will begin.`,
      })
      return
    }
    await withThinking({ client, channelId, threadTs, run: async (update) => {
      await runPmAgent({ channelName, channelId, threadTs, userMessage, client, update })
    }})
    return
  }

  if (confirmedAgent) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `The *${confirmedAgent} agent* is coming soon. The product specialist is active right now — ask anything about the product spec.`,
    })
    return
  }

  // New thread — check phase first, then classify and run
  await withThinking({ client, channelId, threadTs, run: async (update) => {
    const currentPhase = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhase === "product-spec-approved-awaiting-design") {
      setConfirmedAgent(threadTs, "pm") // store so follow-ups hit the same check
      await update(
        `The product spec for *${getFeatureName(channelName)}* is already approved. :white_check_mark:\n\n` +
        `The next step is UX design — a designer needs to produce the screens and user flows before any engineering begins. ` +
        `If you're wearing the designer hat, just say so here and the design phase will begin.`
      )
      return
    }

    const phase = detectPhase({
      productSpecApproved: channelState.productSpecApproved,
      engineeringSpecApproved: channelState.engineeringSpecApproved,
    })
    const history = getHistory(threadTs)
    const suggestedAgent = await classifyIntent({ message: userMessage, history, phase })

    setConfirmedAgent(threadTs, suggestedAgent)

    const routingNote = await buildRoutingNote(getFeatureName(channelName), suggestedAgent)

    if (suggestedAgent === "pm") {
      await runPmAgent({ channelName, channelId, threadTs, userMessage, client, update, routingNote })
      return
    }

    await update(`${routingNote}\n\nThe *${suggestedAgent} agent* is coming soon. The product specialist is active right now.`)
  }})
}

async function runPmAgent(params: {
  channelName: string
  channelId: string
  threadTs: string
  userMessage: string
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, client, update, routingNote } = params
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
    await update(`${prefix}${cleanResponse}\n\n_Draft saved to \`${filePath}\`._`)
    return
  }

  if (isCreateSpecIntent(response)) {
    const specContent = extractSpecContent(response)
    await update(`${prefix}Saving the final spec...`)
    await saveApprovedSpec({ featureName, filePath, content: specContent })
    await update(
      `${prefix}The *${featureName}* product spec is saved and approved. :white_check_mark:\n\n` +
      `*What happens next:*\n` +
      `A UX designer produces the screens and user flows before any engineering begins. ` +
      `If you're wearing the designer hat on this one, just say so right here in this channel and the design phase will begin.\n\n` +
      `To confirm the approved state or check where any feature stands, go to *#all-health360* and ask — the system will give you a live status update.\n\n` +
      `The product specialist's job on this feature is done. The spec is the source of truth from here.`
    )
    return
  }

  await update(`${prefix}${response}`)
}
