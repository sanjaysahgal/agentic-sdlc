import { loadAgentContext } from "../../../runtime/context-loader"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec } from "../../../agents/pm"
import { createSpecPR, saveDraftSpec } from "../../../runtime/github-client"
import { classifyIntent, detectPhase, getAgentDescriptions, AgentType } from "../../../runtime/agent-router"

function getFeatureName(channelName: string): string {
  return channelName.replace(/^feature-/, "")
}

export type ChannelState = {
  productSpecApproved: boolean
  engineeringSpecApproved: boolean
  pendingAgent: AgentType | null      // agent awaiting user confirmation
  pendingMessage: string | null       // message awaiting agent confirmation
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

// Builds Slack button blocks for agent confirmation.
// Split into two rows of 5 — Slack collapses rows with more than 5 buttons.
function buildAgentConfirmationBlocks(suggestedAgent: AgentType, featureName: string) {
  const descriptions = getAgentDescriptions()
  const row1: AgentType[] = ["pm", "architect", "backend", "frontend", "qa"]
  const row2: AgentType[] = ["pgm", "spec-validator", "eng-mgr", "infra", "data"]

  const makeButton = (agent: AgentType) => ({
    type: "button",
    text: { type: "plain_text", text: agent === suggestedAgent ? `✓ ${agent}` : agent },
    style: agent === suggestedAgent ? "primary" : undefined,
    action_id: `confirm_agent_${agent}`,
    value: agent,
  })

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `I'll respond as the *${suggestedAgent} agent* — ${descriptions[suggestedAgent]}.\n\nConfirm or choose a different agent:`,
      },
    },
    { type: "actions", elements: row1.map(makeButton) },
    {
      type: "actions",
      elements: [
        ...row2.map(makeButton),
        {
          type: "button",
          text: { type: "plain_text", text: "other..." },
          action_id: "confirm_agent_other",
          value: "other",
        },
      ],
    },
  ]
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

  const phase = detectPhase({
    productSpecApproved: channelState.productSpecApproved,
    engineeringSpecApproved: channelState.engineeringSpecApproved,
  })

  const history = getHistory(threadTs)

  // If the user has already confirmed an agent for this thread, skip confirmation
  // and route directly to that agent for all follow-up messages
  const confirmedAgent = getConfirmedAgent(threadTs)
  if (confirmedAgent === "pm") {
    await runPmAgent({ channelName, channelId, threadTs, userMessage, client })
    return
  }

  // First message in thread — classify and ask for confirmation
  const suggestedAgent = await classifyIntent({ message: userMessage, history, phase })

  // Store pending state — wait for user confirmation via button click
  setChannelState(channelName, {
    ...channelState,
    pendingAgent: suggestedAgent,
    pendingMessage: userMessage,
    pendingThreadTs: threadTs,
  })

  // Post confirmation buttons
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: buildAgentConfirmationBlocks(suggestedAgent, channelName.replace(/^feature-/, "")),
    text: `About to respond as ${suggestedAgent} agent — confirm or choose another.`,
  })
}

// Runs the pm agent and posts the response — used for both confirmed and first-time flows
async function runPmAgent(params: {
  channelName: string
  channelId: string
  threadTs: string
  userMessage: string
  client: any
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, client } = params
  const featureName = channelName.replace(/^feature-/, "")
  const context = await loadAgentContext(featureName)
  const systemPrompt = buildPmSystemPrompt(context, featureName)
  const history = getHistory(threadTs)

  const response = await runAgent({ systemPrompt, history, userMessage })
  appendMessage(threadTs, { role: "user", content: userMessage })
  appendMessage(threadTs, { role: "assistant", content: response })

  const filePath = `specs/features/${featureName}/${featureName}.product.md`

  // Auto-save draft if the agent included a DRAFT block — no PR, just commit the file
  if (hasDraftSpec(response)) {
    const draftContent = extractDraftSpec(response)
    await saveDraftSpec({ featureName, filePath, content: draftContent })
    // Strip DRAFT block before posting to Slack — user sees clean response
    const cleanResponse = response
      .replace(/DRAFT_SPEC_START[\s\S]*?DRAFT_SPEC_END/g, "")
      .trim()
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `${cleanResponse}\n\n_Draft saved to \`${filePath}\` on branch \`spec/${featureName}-product\`._`,
    })
    return
  }

  // Explicit PR approval
  if (isCreateSpecIntent(response)) {
    const specContent = extractSpecContent(response)
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Opening PR for \`${filePath}\`...` })
    const prUrl = await createSpecPR({
      featureName,
      filePath,
      content: specContent,
      prTitle: `[SPEC] ${featureName} · product.md`,
      prBody: `Product spec for **${featureName}**.\n\nShaped in #feature-${featureName}.\n\n**Checklist:**\n- [ ] Aligns with product vision\n- [ ] Personas correctly identified\n- [ ] Acceptance criteria are testable\n- [ ] Non-goals are explicit`,
    })
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Spec ready for review: ${prUrl}\n\nApprove the PR in GitHub when happy.` })
    return
  }

  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: response })
}

// Called when user clicks a confirmation button
export async function handleAgentConfirmation(params: {
  channelName: string
  channelId: string
  selectedAgent: AgentType | "other"
  client: any
  channelState: ChannelState
}): Promise<void> {
  const { channelName, channelId, selectedAgent, client, channelState } = params

  const { pendingMessage, pendingThreadTs } = channelState
  if (!pendingMessage || !pendingThreadTs) return

  // Handle "other" — post a new message in thread, leave original untouched
  if (selectedAgent === "other") {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: pendingThreadTs,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Which agent do you need? Describe it in this thread and I'll log it as a gap in \`agentic-sdlc\`.\n\nOr pick from the existing agents:`,
          },
        },
        {
          type: "actions",
          elements: (["pm", "architect", "backend", "frontend", "qa", "pgm", "spec-validator", "eng-mgr", "infra", "data"] as AgentType[]).map((agent) => ({
            type: "button",
            text: { type: "plain_text", text: agent },
            action_id: `confirm_agent_${agent}`,
            value: agent,
          })),
        },
      ],
      text: "Which agent do you need?",
    })
    return
  }

  // Clear pending state
  setChannelState(channelName, {
    ...channelState,
    pendingAgent: null,
    pendingMessage: null,
    pendingThreadTs: null,
  })

  // Only pm agent is fully implemented — others coming in future moments
  if (selectedAgent !== "pm") {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: pendingThreadTs,
      text: `The *${selectedAgent} agent* is coming soon. Only the pm agent is active right now.`,
    })
    return
  }

  // Store confirmed agent — follow-up messages skip confirmation
  setConfirmedAgent(pendingThreadTs, selectedAgent)

  // Run the pm agent — spec creation and response handled inside runPmAgent
  await runPmAgent({ channelName, channelId, threadTs: pendingThreadTs, userMessage: pendingMessage, client })
}
