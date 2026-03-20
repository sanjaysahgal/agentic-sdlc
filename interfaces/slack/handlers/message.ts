import { loadAgentContext } from "../../../runtime/context-loader"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec } from "../../../agents/pm"
import { createSpecPR, saveDraftSpec, getInProgressFeatures } from "../../../runtime/github-client"
import { classifyIntent, detectPhase, AgentType } from "../../../runtime/agent-router"
import { runAgent as callClaude } from "../../../runtime/claude-client"

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

// Builds a plain-English routing explanation based on feature phase.
// Tells the human which agent is handling the message and why,
// and what the next phase after this one will be.
async function buildRoutingExplanation(featureName: string, agent: AgentType): Promise<string> {
  const features = await getInProgressFeatures()
  const feature = features.find((f) => f.featureName === featureName)
  const phase = feature?.phase ?? "product-spec-in-progress"

  const phaseDescriptions: Record<string, { current: string; next: string }> = {
    "product-spec-in-progress": {
      current: "the product spec for this feature is being shaped — what the feature does, who it's for, and what success looks like",
      next: "once the product spec is approved, a UX designer will produce the screens and user flows before any engineering begins",
    },
    "product-spec-approved-awaiting-design": {
      current: "the product spec is approved and design is the next step",
      next: "once the design spec is approved, an architect will produce the engineering plan",
    },
    "design-in-progress": {
      current: "the design spec is being shaped — screens, user flows, and component decisions",
      next: "once the design spec is approved, an architect will produce the engineering plan",
    },
    "design-approved-awaiting-engineering": {
      current: "both product and design specs are approved — engineering planning is the next step",
      next: "once the engineering plan is approved, engineers will begin building",
    },
  }

  const desc = phaseDescriptions[phase] ?? phaseDescriptions["product-spec-in-progress"]

  const agentNames: Record<string, string> = {
    pm: "product specialist",
    architect: "software architect",
    design: "UX design specialist",
    backend: "backend engineer",
    frontend: "frontend engineer",
    qa: "QA specialist",
  }

  const agentName = agentNames[agent] ?? agent

  return `_Routing to the **${agentName}** — ${desc.current}. ${desc.next}._\n\n_If you'd like a different specialist on this, just say so and explain why — I'll either agree or explain why this is the right choice right now._\n\n---`
}

// Detects whether a message is requesting a different agent than the one confirmed.
async function detectOverrideRequest(userMessage: string, currentAgent: AgentType): Promise<{ isOverride: boolean; requestedAgent: string }> {
  const response = await callClaude({
    systemPrompt: `You detect whether a user is requesting to switch to a different AI specialist.
Current specialist: ${currentAgent}.
Reply with JSON only: { "isOverride": true/false, "requestedAgent": "name or empty string" }
An override is when the user explicitly asks to use a different agent, role, or specialist.
Normal questions, corrections, and feedback are NOT overrides.`,
    history: [],
    userMessage,
  })
  try {
    const parsed = JSON.parse(response.replace(/```json|```/g, "").trim())
    return { isOverride: parsed.isOverride ?? false, requestedAgent: parsed.requestedAgent ?? "" }
  } catch {
    return { isOverride: false, requestedAgent: "" }
  }
}

// Evaluates whether a requested override makes sense given current feature phase.
// Either agrees and switches, or pushes back with explanation.
async function handleOverride(params: {
  channelName: string
  channelId: string
  threadTs: string
  userMessage: string
  requestedAgent: string
  currentAgent: AgentType
  client: any
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, requestedAgent, currentAgent, client } = params
  const featureName = getFeatureName(channelName)
  const features = await getInProgressFeatures()
  const feature = features.find((f) => f.featureName === featureName)
  const phase = feature?.phase ?? "product-spec-in-progress"

  const evaluation = await callClaude({
    systemPrompt: `You are the routing intelligence for an AI-powered SDLC system. A human is requesting to switch from the current specialist to a different one.

The workflow sequence is strictly:
1. Product spec (product specialist / pm agent) — what the feature does, for whom, why
2. Design spec (UX design specialist) — screens, user flows, component decisions
3. Engineering spec (software architect) — how to build it technically
4. Build (engineers)
5. QA (QA specialist)

Current feature phase: ${phase}
Current specialist: ${currentAgent}
Requested specialist: ${requestedAgent}
Human's message: "${userMessage}"

Evaluate whether the switch makes sense:
- If the requested specialist belongs to a phase that hasn't been reached yet (e.g. designer when product spec isn't approved), push back clearly but respectfully. Explain what needs to happen first and why the sequence matters.
- If the requested specialist makes sense (e.g. the human has a legitimate reason, or the phase supports it), agree and explain.
- If the requested specialist is the same as current but phrased differently, clarify.

Respond in plain English, conversational, no jargon. Be direct. One short paragraph.`,
    history: [],
    userMessage,
  })

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: evaluation,
  })
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
  const featureName = getFeatureName(channelName)

  const confirmedAgent = getConfirmedAgent(threadTs)

  // Confirmed agent for this thread — check for override request first
  if (confirmedAgent) {
    const { isOverride, requestedAgent } = await detectOverrideRequest(userMessage, confirmedAgent as AgentType)
    if (isOverride) {
      await handleOverride({ channelName, channelId, threadTs, userMessage, requestedAgent, currentAgent: confirmedAgent as AgentType, client })
      return
    }

    if (confirmedAgent === "pm") {
      await runPmAgent({ channelName, channelId, threadTs, userMessage, client })
      return
    }

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `The *${confirmedAgent} agent* is coming soon. The product specialist is active right now — ask me anything about the product spec.`,
    })
    return
  }

  // New thread — classify intent, explain routing, then run the agent
  const phase = detectPhase({
    productSpecApproved: channelState.productSpecApproved,
    engineeringSpecApproved: channelState.engineeringSpecApproved,
  })
  const history = getHistory(threadTs)
  const suggestedAgent = await classifyIntent({ message: userMessage, history, phase })

  // Store confirmed agent immediately — override requests handled conversationally
  setConfirmedAgent(threadTs, suggestedAgent)

  // Build and post routing explanation, then run agent — both appear in the thread
  const routingNote = await buildRoutingExplanation(featureName, suggestedAgent)

  if (suggestedAgent === "pm") {
    const context = await loadAgentContext(featureName)
    const systemPrompt = buildPmSystemPrompt(context, featureName)
    const response = await runAgent({ systemPrompt, history, userMessage })
    appendMessage(threadTs, { role: "user", content: userMessage })
    appendMessage(threadTs, { role: "assistant", content: response })
    await postPmResponse({ channelId, threadTs, featureName, response, routingNote, client })
    return
  }

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `${routingNote}\n\nThe *${suggestedAgent} agent* is coming soon. The product specialist is active right now.`,
  })
}

// Runs the pm agent for confirmed threads (no routing note needed)
async function runPmAgent(params: {
  channelName: string
  channelId: string
  threadTs: string
  userMessage: string
  client: any
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, client } = params
  const featureName = getFeatureName(channelName)
  const context = await loadAgentContext(featureName)
  const systemPrompt = buildPmSystemPrompt(context, featureName)
  const history = getHistory(threadTs)

  const response = await runAgent({ systemPrompt, history, userMessage })
  appendMessage(threadTs, { role: "user", content: userMessage })
  appendMessage(threadTs, { role: "assistant", content: response })

  await postPmResponse({ channelId, threadTs, featureName, response, routingNote: null, client })
}

// Posts the pm agent response, handling draft auto-save and PR creation
async function postPmResponse(params: {
  channelId: string
  threadTs: string
  featureName: string
  response: string
  routingNote: string | null
  client: any
}): Promise<void> {
  const { channelId, threadTs, featureName, response, routingNote, client } = params
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
      text: `The spec is saved and ready for review: ${prUrl}\n\nOnce it's approved there, the design phase begins — a UX designer will produce the screens and flows before any engineering starts.`,
    })
    return
  }

  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `${prefix}${response}` })
}
