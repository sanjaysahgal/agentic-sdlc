import { loadAgentContext, loadDesignAgentContext } from "../../../runtime/context-loader"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec } from "../../../agents/pm"
import { buildDesignSystemPrompt, isCreateDesignSpecIntent, hasDraftDesignSpec, extractDraftDesignSpec, extractDesignSpecContent } from "../../../agents/design"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, saveDraftDesignSpec, saveApprovedDesignSpec, getInProgressFeatures } from "../../../runtime/github-client"
import { classifyIntent, classifyMessageScope, detectPhase, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { auditSpecDraft } from "../../../runtime/spec-auditor"
import { extractBlockingQuestions } from "../../../runtime/spec-utils"

const { paths: workspacePaths } = loadWorkspaceConfig()

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

// Handles messages in the design phase — routes to the UX Design agent.
async function handleDesignPhase(params: {
  channelId: string
  threadTs: string
  channelName: string
  featureName: string
  userMessage: string
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
}): Promise<void> {
  const { channelName, channelId, threadTs, featureName, userMessage, client, update, routingNote } = params
  await runDesignAgent({ channelName, channelId, threadTs, featureName, userMessage, client, update, routingNote })
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

  const agentLabel = agent === "pm" ? "Product Manager" : agent

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
  if (confirmedAgent === "ux-design") {
    await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, client, update })
    }})
    return
  }

  if (confirmedAgent === "pm") {
    // If the product spec is already approved, route to the design phase.
    const currentPhase = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhase === "product-spec-approved-awaiting-design") {
      setConfirmedAgent(threadTs, "ux-design")
      await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
        await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, client, update })
      }})
      return
    }
    await withThinking({ client, channelId, threadTs, agent: "Product Manager", run: async (update) => {
      await runPmAgent({ channelName, channelId, threadTs, userMessage, client, update })
    }})
    return
  }

  if (confirmedAgent) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `The *${confirmedAgent} agent* is coming soon. The Product Manager is active right now — ask anything about the product spec.`,
    })
    return
  }

  // New thread — check phase first, then classify and run
  const currentPhase = await getFeaturePhase(getFeatureName(channelName))
  const thinkingLabel = currentPhase === "product-spec-approved-awaiting-design" ? "UX Designer" : undefined
  await withThinking({ client, channelId, threadTs, agent: thinkingLabel, run: async (update) => {
    if (currentPhase === "product-spec-approved-awaiting-design") {
      setConfirmedAgent(threadTs, "ux-design")
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, client, update })
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

    await update(`${routingNote}\n\nThe *${suggestedAgent} agent* is coming soon. The Product Manager is active right now.`)
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
  readOnly?: boolean
  approvedSpecContext?: boolean
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, client, update, routingNote, readOnly, approvedSpecContext } = params
  const featureName = getFeatureName(channelName)

  await update("_Product Manager is reading the spec..._")
  const context = await loadAgentContext(featureName)


  // If the message is asking about the product as a whole (vision, architecture, principles),
  // answer from context directly — the pm agent is not the right framing for product-level questions.
  if (!readOnly) {
    const scope = await classifyMessageScope(userMessage)
    if (scope === "product-context") {
      const prefix = routingNote ? `${routingNote}\n\n` : ""
      await update("_Product Manager is thinking..._")
      await update(
        `${prefix}_Answering from the ${loadWorkspaceConfig().productName} product context:_\n\n` +
        await runAgent({
          systemPrompt: `You are a knowledgeable assistant for ${loadWorkspaceConfig().productName}. ` +
            `Answer the user's question directly using the product vision and architecture below. Be concise.\n\n` +
            `## Product Vision\n${context.productVision}\n\n## System Architecture\n${context.systemArchitecture}`,
          history: [],
          userMessage,
        })
      )
      return
    }
  }

  const systemPrompt = buildPmSystemPrompt(context, featureName, readOnly, approvedSpecContext)
  const history = getHistory(threadTs)

  await update("_Product Manager is thinking..._")
  const response = await runAgent({ systemPrompt, history, userMessage })
  appendMessage(threadTs, { role: "user", content: userMessage })

  const filePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""

  // In read-only mode (approved spec), skip all writes — just answer the question
  if (readOnly) {
    const cleanResponse = response.replace(/DRAFT_SPEC_START[\s\S]*?DRAFT_SPEC_END/g, "").replace(/INTENT: CREATE_SPEC/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}`)
    return
  }

  if (hasDraftSpec(response)) {
    const draftContent = extractDraftSpec(response)
    await update("_Auditing draft against product vision and architecture..._")
    const audit = await auditSpecDraft({
      draft: draftContent,
      productVision: context.productVision,
      systemArchitecture: context.systemArchitecture,
      featureName,
    })

    if (audit.status === "conflict") {
      const cleanResponse = response.replace(/DRAFT_SPEC_START[\s\S]*?DRAFT_SPEC_END/g, "").trim()
      const conflictQuestion = `Resolve this before we continue. Do you want to adjust the spec, or update the product vision/architecture?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nConflict detected — draft not saved.\n\n${audit.message}\n\n${conflictQuestion}` })
      await update(
        `${prefix}${cleanResponse}\n\n` +
        `:warning: *Conflict detected — draft not saved.*\n\n${audit.message}\n\n` +
        conflictQuestion
      )
      return
    }

    if (audit.status === "gap") {
      const cleanResponse = response.replace(/DRAFT_SPEC_START[\s\S]*?DRAFT_SPEC_END/g, "").trim()
      const gapQuestion = `Do you want to update the product vision/architecture to cover this, or treat it as a deliberate extension (note it in the spec and move on)?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nGap detected — draft saved, but a decision is needed.\n\n${audit.message}\n\n${gapQuestion}` })
      await update(
        `${prefix}${cleanResponse}\n\n` +
        `:thinking_face: *Gap detected — draft saved, but a decision is needed.*\n\n${audit.message}\n\n` +
        gapQuestion
      )
      await saveDraftSpec({ featureName, filePath, content: draftContent })
      return
    }

    await update("_Saving draft to GitHub..._")
    await saveDraftSpec({ featureName, filePath, content: draftContent })
    const cleanResponse = response.replace(/DRAFT_SPEC_START[\s\S]*?DRAFT_SPEC_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}\n\n_Draft saved to \`${filePath}\`._`)
    return
  }

  if (isCreateSpecIntent(response)) {
    const specContent = extractSpecContent(response)
    const blockingQuestions = extractBlockingQuestions(specContent)
    if (blockingQuestions.length > 0) {
      appendMessage(threadTs, { role: "assistant", content: `Approval blocked — the following questions must be resolved first:\n${blockingQuestions.map(q => `• ${q}`).join("\n")}` })
      await update(`${prefix}:no_entry: *Approval blocked — ${blockingQuestions.length} blocking question${blockingQuestions.length > 1 ? "s" : ""} must be resolved first:*\n${blockingQuestions.map(q => `• ${q}`).join("\n")}`)
      return
    }
    await update(`${prefix}Saving the final spec...`)
    await saveApprovedSpec({ featureName, filePath, content: specContent })
    const approvalMessage =
      `The *${featureName}* product spec is saved and approved. :white_check_mark:\n\n` +
      `*What happens next:*\n` +
      `A UX designer produces the screens and user flows before any engineering begins. ` +
      `If you're wearing the designer hat on this one, just say so right here in this channel and the design phase will begin.\n\n` +
      `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask — the system will give you a live status update.\n\n` +
      `The Product Manager's job on this feature is done. The spec is the source of truth from here.`
    appendMessage(threadTs, { role: "assistant", content: approvalMessage })
    await update(`${prefix}${approvalMessage}`)
    return
  }

  appendMessage(threadTs, { role: "assistant", content: response })
  await update(`${prefix}${response}`)
}

async function runDesignAgent(params: {
  channelName: string
  channelId: string
  threadTs: string
  featureName: string
  userMessage: string
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
  readOnly?: boolean
}): Promise<void> {
  const { channelName, channelId, threadTs, featureName, userMessage, client, update, routingNote, readOnly } = params

  await update("_UX Designer is reading the spec and design context..._")
  const context = await loadDesignAgentContext(featureName)
  const systemPrompt = buildDesignSystemPrompt(context, featureName, readOnly)
  const history = getHistory(threadTs)

  await update("_UX Designer is thinking..._")
  const response = await runAgent({ systemPrompt, history, userMessage })
  appendMessage(threadTs, { role: "user", content: userMessage })

  const filePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""

  if (readOnly) {
    const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").replace(/INTENT: CREATE_DESIGN_SPEC/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}`)
    return
  }

  if (hasDraftDesignSpec(response)) {
    const draftContent = extractDraftDesignSpec(response)
    await update("_Auditing draft against product vision and architecture..._")
    const audit = await auditSpecDraft({
      draft: draftContent,
      productVision: context.productVision,
      systemArchitecture: context.systemArchitecture,
      featureName,
    })

    if (audit.status === "conflict") {
      const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").trim()
      const conflictQuestion = `Resolve this before we continue. Do you want to adjust the design, or update the product vision/architecture?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nConflict detected — draft not saved.\n\n${audit.message}\n\n${conflictQuestion}` })
      await update(
        `${prefix}${cleanResponse}\n\n` +
        `:warning: *Conflict detected — draft not saved.*\n\n${audit.message}\n\n` +
        conflictQuestion
      )
      return
    }

    if (audit.status === "gap") {
      const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").trim()
      const gapQuestion = `Do you want to update the product vision/architecture to cover this, or treat it as a deliberate extension (note it in the spec and move on)?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nGap detected — draft saved, but a decision is needed.\n\n${audit.message}\n\n${gapQuestion}` })
      await update(
        `${prefix}${cleanResponse}\n\n` +
        `:thinking_face: *Gap detected — draft saved, but a decision is needed.*\n\n${audit.message}\n\n` +
        gapQuestion
      )
      await saveDraftDesignSpec({ featureName, filePath, content: draftContent })
      return
    }

    await update("_Saving draft to GitHub..._")
    await saveDraftDesignSpec({ featureName, filePath, content: draftContent })
    const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}\n\n_Draft saved to \`${filePath}\`._`)
    return
  }

  if (isCreateDesignSpecIntent(response)) {
    const specContent = extractDesignSpecContent(response)
    const blockingQuestions = extractBlockingQuestions(specContent)
    if (blockingQuestions.length > 0) {
      appendMessage(threadTs, { role: "assistant", content: `Approval blocked — the following questions must be resolved first:\n${blockingQuestions.map(q => `• ${q}`).join("\n")}` })
      await update(`${prefix}:no_entry: *Approval blocked — ${blockingQuestions.length} blocking question${blockingQuestions.length > 1 ? "s" : ""} must be resolved first:*\n${blockingQuestions.map(q => `• ${q}`).join("\n")}`)
      return
    }
await update(`${prefix}Saving the final design spec...`)
    await saveApprovedDesignSpec({ featureName, filePath, content: specContent })
    const approvalMessage =
      `The *${featureName}* design spec is saved and approved. :white_check_mark:\n\n` +
      `*What happens next:*\n` +
      `A software architect produces the engineering plan before any code is written. ` +
      `If you're wearing the architect hat on this one, just say so right here and the engineering phase will begin.\n\n` +
      `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
    appendMessage(threadTs, { role: "assistant", content: approvalMessage })
    await update(`${prefix}${approvalMessage}`)
    return
  }

  appendMessage(threadTs, { role: "assistant", content: response })
  await update(`${prefix}${response}`)
}
