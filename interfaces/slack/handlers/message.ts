import { loadAgentContext, loadDesignAgentContext, loadArchitectAgentContext } from "../../../runtime/context-loader"
import { runAgent, UserImage } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent, getPendingEscalation, setPendingEscalation, clearPendingEscalation, getPendingApproval, setPendingApproval, clearPendingApproval } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec } from "../../../agents/pm"
import { buildDesignSystemPrompt, isCreateDesignSpecIntent, hasDraftDesignSpec, extractDraftDesignSpec, extractDesignSpecContent, hasEscalationOffer, extractEscalationQuestion, stripEscalationMarker, buildDesignStateResponse } from "../../../agents/design"
import { buildArchitectSystemPrompt, isCreateEngineeringSpecIntent, hasDraftEngineeringSpec, extractDraftEngineeringSpec, extractEngineeringSpecContent } from "../../../agents/architect"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, saveDraftDesignSpec, saveApprovedDesignSpec, saveDraftEngineeringSpec, saveApprovedEngineeringSpec, saveDraftHtmlPreview, buildPreviewUrl, getInProgressFeatures, readFile } from "../../../runtime/github-client"
import { classifyIntent, classifyMessageScope, detectPhase, isOffTopicForAgent, isSpecStateQuery, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { auditSpecDraft, auditSpecDecisions, applyDecisionCorrections } from "../../../runtime/spec-auditor"
import { generateDesignPreview } from "../../../runtime/html-renderer"
import { extractBlockingQuestions } from "../../../runtime/spec-utils"

const { paths: workspacePaths } = loadWorkspaceConfig()

function getFeatureName(channelName: string): string {
  return channelName.replace(/^feature-/, "")
}

// Detects a simple affirmative confirmation — used for escalation offers and spec approval.
function isAffirmative(message: string): boolean {
  const lower = message.toLowerCase().trim()
  return /^(yes|yeah|yep|sure|go ahead|pull them in|pull (the )?pm in|do it|ok|okay|please|yes please|bring them in|bring (the )?pm in|confirmed|confirm|approved|approve|lock it in|let's go|lets go)/.test(lower)
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
  userImages?: UserImage[]
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
}): Promise<void> {
  const { channelName, channelId, threadTs, featureName, userMessage, userImages, client, update, routingNote } = params
  await runDesignAgent({ channelName, channelId, threadTs, featureName, userMessage, userImages, client, update, routingNote })
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
    } else if (feature?.phase === "design-approved-awaiting-engineering" || feature?.phase === "engineering-in-progress") {
      phaseDescription = "the design spec is approved and engineering planning is the next step"
      nextStep = "once the engineering spec is approved, the engineer agents will implement the feature"
    }
  } catch {
    // GitHub unavailable — use defaults
  }

  const agentLabel = agent === "pm" ? "Product Manager" : agent === "ux-design" ? "UX Designer" : agent === "architect" ? "Architect" : agent

  return `_Routing to the **${agentLabel}** — ${phaseDescription}. ${nextStep}._\n_If you'd like a different specialist, just say so — I'll explain or accommodate._\n\n---`
}

export async function handleFeatureChannelMessage(params: {
  channelName: string
  threadTs: string
  userMessage: string
  userImages?: UserImage[]
  channelId: string
  client: any
  channelState: ChannelState
}): Promise<void> {
  const { channelName, threadTs, userMessage, userImages, channelId, client, channelState } = params

  const confirmedAgent = getConfirmedAgent(threadTs)

  // Confirmed agent — check phase first, then run
  if (confirmedAgent === "ux-design") {
    // If the design agent offered a PM escalation last turn and the user is confirming it,
    // run the PM agent with the blocking question as its opening brief.
    const pendingEscalation = getPendingEscalation(threadTs)
    if (pendingEscalation && isAffirmative(userMessage)) {
      clearPendingEscalation(threadTs)
      const escalationBrief =
        `The UX Designer is blocked on a product decision and needs your input:\n\n` +
        `"${pendingEscalation.question}"\n\n` +
        `Current design context:\n${pendingEscalation.designContext}\n\n` +
        `Give a concrete answer or recommendation — this is blocking the design spec.`
      await withThinking({ client, channelId, threadTs, agent: "Product Manager", run: async (update) => {
        await runPmAgent({ channelName, channelId, threadTs, userMessage: escalationBrief, client, update })
      }})
      return
    }
    // User declined escalation or sent a new message — clear pending and continue normally
    if (pendingEscalation) clearPendingEscalation(threadTs)

    await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
    }})
    return
  }

  if (confirmedAgent === "architect") {
    await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
      await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
    }})
    return
  }

  if (confirmedAgent === "pm") {
    // If the product spec is already approved, route to the design phase.
    const currentPhase = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhase === "product-spec-approved-awaiting-design") {
      setConfirmedAgent(threadTs, "ux-design")
      await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
        await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      }})
      return
    }
    await withThinking({ client, channelId, threadTs, agent: "Product Manager", run: async (update) => {
      await runPmAgent({ channelName, channelId, threadTs, userMessage, userImages, client, update })
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
  const thinkingLabel =
    currentPhase === "product-spec-approved-awaiting-design" ? "UX Designer" :
    currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress" ? "Architect" :
    undefined
  await withThinking({ client, channelId, threadTs, agent: thinkingLabel, run: async (update) => {
    if (currentPhase === "product-spec-approved-awaiting-design") {
      setConfirmedAgent(threadTs, "ux-design")
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      return
    }

    if (currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress") {
      setConfirmedAgent(threadTs, "architect")
      await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
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
      await runPmAgent({ channelName, channelId, threadTs, userMessage, userImages, client, update, routingNote })
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
  userImages?: UserImage[]
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
  readOnly?: boolean
  approvedSpecContext?: boolean
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, userImages, client, update, routingNote, readOnly, approvedSpecContext } = params
  const featureName = getFeatureName(channelName)

  // Pending spec approval — check before anything else
  const pendingApproval = getPendingApproval(threadTs)
  if (pendingApproval && pendingApproval.specType === "product") {
    if (isAffirmative(userMessage)) {
      clearPendingApproval(threadTs)
      await update("_Saving the final product spec..._")
      await saveApprovedSpec({ featureName, filePath: pendingApproval.filePath, content: pendingApproval.specContent })
      const approvalMessage =
        `The *${featureName}* product spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `A UX designer produces the screens and user flows before any engineering begins. ` +
        `If you're wearing the designer hat on this one, just say so right here and the design phase will begin.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(threadTs)
      // Not confirming — fall through to normal agent flow
    }
  }

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
  const response = await runAgent({ systemPrompt, history, userMessage, userImages })
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
    // Audit spec against locked conversation decisions before caching for approval
    await update("_Checking spec against locked decisions..._")
    let finalSpecContent = specContent
    let correctionNote = ""
    const decisionAudit = await auditSpecDecisions({ specContent, history: getHistory(threadTs) })
    if (decisionAudit.status === "corrections") {
      const { corrected, applied } = applyDecisionCorrections(specContent, decisionAudit.corrections)
      if (applied.length > 0) {
        finalSpecContent = corrected
        correctionNote = `\n\n_Found ${applied.length} value${applied.length > 1 ? "s" : ""} in the spec that differed from what we locked in conversation — corrected before saving:_\n${applied.map(c => `• *${c.description}:* ${c.found} → ${c.correct}`).join("\n")}`
      }
    }
    // Cache spec, ask for confirmation — don't save until user explicitly confirms
    setPendingApproval(threadTs, { specType: "product", specContent: finalSpecContent, filePath, featureName })
    const confirmMsg = `Looks like you're approving the product spec. Just to be certain before I save it — reply *confirmed* to lock it in and move to design, or let me know if there's anything left to review.${correctionNote}`
    appendMessage(threadTs, { role: "assistant", content: confirmMsg })
    await update(`${prefix}${confirmMsg}`)
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
  userImages?: UserImage[]
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
  readOnly?: boolean
}): Promise<void> {
  const { channelName, channelId, threadTs, featureName, userMessage, userImages, client, update, routingNote, readOnly } = params

  // Pending spec approval — check before fast paths
  const pendingDesignApproval = getPendingApproval(threadTs)
  if (pendingDesignApproval && pendingDesignApproval.specType === "design") {
    if (isAffirmative(userMessage)) {
      clearPendingApproval(threadTs)
      await update("_Saving the final design spec..._")
      await saveApprovedDesignSpec({ featureName, filePath: pendingDesignApproval.filePath, content: pendingDesignApproval.specContent })
      const approvalMessage =
        `The *${featureName}* design spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `A software architect produces the engineering plan before any code is written. ` +
        `If you're wearing the architect hat on this one, just say so right here and the engineering phase will begin.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(threadTs)
      // Not confirming — fall through to normal agent flow
    }
  }

  // Short-circuit status/general queries before loading expensive design context.
  // A "give me the latest spec" question in a design thread doesn't need the full
  // design agent — it needs the concierge. Check fast with Haiku before loading anything.
  if (!readOnly) {
    const offTopic = await isOffTopicForAgent(userMessage, "design")
    if (offTopic) {
      const mainChannel = loadWorkspaceConfig().mainChannel
      const msg = `For status and progress updates, ask in *#${mainChannel}* — the concierge has the full picture across all features.\n\nI'm the UX Designer — I'm here when you're ready to work on screens, flows, or design decisions for this feature.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }

    // "Where are we" overview — fast path, no context load or Sonnet call needed.
    const isStateQuery = await isSpecStateQuery(userMessage)
    if (isStateQuery) {
      const { paths, githubOwner, githubRepo } = loadWorkspaceConfig()
      const branchName = `spec/${featureName}-design`
      const designDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
      const draftContent = await readFile(designDraftPath, branchName)
      const specUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/${branchName}/${designDraftPath}`

      // Generate (or regenerate) the HTML preview if a draft exists — non-fatal
      let previewUrl: string | null = null
      if (draftContent) {
        try {
          await update("_Generating HTML preview..._")
          const htmlContent = await generateDesignPreview({ specContent: draftContent, featureName })
          const htmlFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.preview.html`
          await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: htmlContent })
          previewUrl = buildPreviewUrl({ githubOwner, githubRepo, featureName, featuresRoot: paths.featuresRoot })
        } catch {
          // Non-fatal
        }
      }

      const msg = buildDesignStateResponse({ featureName, draftContent, specUrl, previewUrl })
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }
  }

  await update("_UX Designer is reading the spec and design context..._")
  const context = await loadDesignAgentContext(featureName)
  const systemPrompt = buildDesignSystemPrompt(context, featureName, readOnly)
  const history = getHistory(threadTs)

  await update("_UX Designer is thinking..._")
  const response = await runAgent({ systemPrompt, history, userMessage, userImages })
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

    // Generate HTML preview alongside every draft save — non-fatal
    let previewNote = ""
    try {
      await update("_Generating HTML preview..._")
      const { githubOwner, githubRepo, paths } = loadWorkspaceConfig()
      const htmlContent = await generateDesignPreview({ specContent: draftContent, featureName })
      const htmlFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.preview.html`
      await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: htmlContent })
      const previewUrl = buildPreviewUrl({ githubOwner, githubRepo, featureName, featuresRoot: paths.featuresRoot })
      previewNote = `\n\n_Preview:_ ${previewUrl}\n_Open on desktop or mobile — use your browser's device toolbar to switch between layouts._`
    } catch {
      // Non-fatal — draft is saved, preview is a nice-to-have
    }

    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}${previewNote}`)
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
    // Audit spec against locked conversation decisions before caching for approval
    await update("_Checking spec against locked decisions..._")
    let finalSpecContent = specContent
    let correctionNote = ""
    const decisionAudit = await auditSpecDecisions({ specContent, history: getHistory(threadTs) })
    if (decisionAudit.status === "corrections") {
      const { corrected, applied } = applyDecisionCorrections(specContent, decisionAudit.corrections)
      if (applied.length > 0) {
        finalSpecContent = corrected
        correctionNote = `\n\n_Found ${applied.length} value${applied.length > 1 ? "s" : ""} in the spec that differed from what we locked in conversation — corrected before saving:_\n${applied.map(c => `• *${c.description}:* ${c.found} → ${c.correct}`).join("\n")}`
      }
    }
    // Cache spec, ask for confirmation — don't save until user explicitly confirms
    setPendingApproval(threadTs, { specType: "design", specContent: finalSpecContent, filePath, featureName })
    const confirmMsg = `Looks like you're approving the design spec. Just to be certain before I save it — reply *confirmed* to lock it in and hand off to engineering, or let me know if there's anything left to review.${correctionNote}`
    appendMessage(threadTs, { role: "assistant", content: confirmMsg })
    await update(`${prefix}${confirmMsg}`)
    return
  }

  // Check for PM escalation offer — strip marker, store pending state, display clean response
  if (hasEscalationOffer(response)) {
    const question = extractEscalationQuestion(response)
    setPendingEscalation(threadTs, { targetAgent: "pm", question, designContext: context.currentDraft ?? "" })
    const cleanResponse = stripEscalationMarker(response)
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}`)
    return
  }

  appendMessage(threadTs, { role: "assistant", content: response })
  await update(`${prefix}${response}`)
}

async function runArchitectAgent(params: {
  channelName: string
  channelId: string
  threadTs: string
  featureName: string
  userMessage: string
  userImages?: UserImage[]
  client: any
  update: (text: string) => Promise<void>
  routingNote?: string
  readOnly?: boolean
}): Promise<void> {
  const { channelId, threadTs, featureName, userMessage, userImages, update, routingNote, readOnly } = params

  // Pending spec approval — check before fast paths
  const pendingEngineeringApproval = getPendingApproval(threadTs)
  if (pendingEngineeringApproval && pendingEngineeringApproval.specType === "engineering") {
    if (isAffirmative(userMessage)) {
      clearPendingApproval(threadTs)
      await update("_Saving the final engineering spec..._")
      await saveApprovedEngineeringSpec({ featureName, filePath: pendingEngineeringApproval.filePath, content: pendingEngineeringApproval.specContent })
      const approvalMessage =
        `The *${featureName}* engineering spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `The engineer agents will use this spec to implement the feature — data model, APIs, and UI components.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(threadTs)
      // Not confirming — fall through to normal agent flow
    }
  }

  if (!readOnly) {
    const offTopic = await isOffTopicForAgent(userMessage, "engineering")
    if (offTopic) {
      const mainChannel = loadWorkspaceConfig().mainChannel
      const msg = `For status and progress updates, ask in *#${mainChannel}* — the concierge has the full picture across all features.\n\nI'm the Architect — I'm here when you're ready to work on data models, APIs, or engineering decisions for this feature.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }

    // "Where are we" overview — fast path, no context load or Sonnet call needed.
    const isStateQuery = await isSpecStateQuery(userMessage)
    if (isStateQuery) {
      const { paths, githubOwner, githubRepo } = loadWorkspaceConfig()
      const branchName = `spec/${featureName}-engineering`
      const engineeringDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.engineering.md`
      const engineeringDraft = await readFile(engineeringDraftPath, branchName)

      const extractSection = (content: string, heading: string): string => {
        const re = new RegExp(`##+ ${heading}[\\s\\S]*?(?=\\n##+ |$)`, "i")
        const match = content.match(re)
        return match ? match[0].replace(/^##+ [^\n]+\n/, "").trim() : ""
      }
      const cleanQuestion = (line: string) =>
        line.replace(/\[type:[^\]]+\]\s*/g, "").replace(/\[blocking:[^\]]+\]\s*/g, "").trim()

      const lines: string[] = []
      if (engineeringDraft) {
        const specUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/${branchName}/${engineeringDraftPath}`
        const openQuestionsSection = extractSection(engineeringDraft, "Open Questions")
        const allQuestions = openQuestionsSection.split("\n").filter(l => /^\s*-/.test(l))
        const blocking = allQuestions.filter(l => l.includes("[blocking: yes]")).map(cleanQuestion)
        const nonBlocking = allQuestions.filter(l => l.includes("[blocking: no]")).map(cleanQuestion)

        lines.push(`*${featureName} engineering spec* — in progress`)
        lines.push(`Spec: ${specUrl}`)
        lines.push("")

        if (blocking.length > 0) {
          lines.push(`:warning: *Blocking — must resolve before approval:*`)
          blocking.forEach(q => lines.push(q))
          lines.push("")
        } else {
          lines.push(`:white_check_mark: Nothing blocking — you can review and approve when ready.`)
          lines.push("")
        }

        if (nonBlocking.length > 0) {
          lines.push(`*Non-blocking questions* (can resolve after approval):`)
          nonBlocking.forEach(q => lines.push(q))
          lines.push("")
        }

        lines.push(`Reply *approved* when you're done and I'll hand off to the engineering agents.`)
      } else {
        lines.push(`No engineering draft yet for *${featureName}*. What would you like to spec out first?`)
      }
      const msg = lines.join("\n")
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }
  }

  await update("_Architect is reading the spec chain..._")
  const context = await loadArchitectAgentContext(featureName)
  const systemPrompt = buildArchitectSystemPrompt(context, featureName, readOnly)
  const history = getHistory(threadTs)

  await update("_Architect is thinking..._")
  const response = await runAgent({ systemPrompt, history, userMessage, userImages })
  appendMessage(threadTs, { role: "user", content: userMessage })

  const filePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.engineering.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""

  if (readOnly) {
    const cleanResponse = response
      .replace(/DRAFT_ENGINEERING_SPEC_START[\s\S]*?DRAFT_ENGINEERING_SPEC_END/g, "")
      .replace(/INTENT: CREATE_ENGINEERING_SPEC/g, "")
      .trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}`)
    return
  }

  if (hasDraftEngineeringSpec(response)) {
    const draftContent = extractDraftEngineeringSpec(response)
    await update("_Saving draft engineering spec to GitHub..._")
    await saveDraftEngineeringSpec({ featureName, filePath, content: draftContent })
    const cleanResponse = response.replace(/DRAFT_ENGINEERING_SPEC_START[\s\S]*?DRAFT_ENGINEERING_SPEC_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}\n\n_Draft saved to \`${filePath}\`._`)
    return
  }

  if (isCreateEngineeringSpecIntent(response)) {
    const specContent = extractEngineeringSpecContent(response)
    const blockingQuestions = extractBlockingQuestions(specContent)
    if (blockingQuestions.length > 0) {
      appendMessage(threadTs, { role: "assistant", content: `Approval blocked — the following questions must be resolved first:\n${blockingQuestions.map(q => `• ${q}`).join("\n")}` })
      await update(`${prefix}:no_entry: *Approval blocked — ${blockingQuestions.length} blocking question${blockingQuestions.length > 1 ? "s" : ""} must be resolved first:*\n${blockingQuestions.map(q => `• ${q}`).join("\n")}`)
      return
    }
    // Audit spec against locked conversation decisions before caching for approval
    await update("_Checking spec against locked decisions..._")
    let finalSpecContent = specContent
    let correctionNote = ""
    const decisionAudit = await auditSpecDecisions({ specContent, history: getHistory(threadTs) })
    if (decisionAudit.status === "corrections") {
      const { corrected, applied } = applyDecisionCorrections(specContent, decisionAudit.corrections)
      if (applied.length > 0) {
        finalSpecContent = corrected
        correctionNote = `\n\n_Found ${applied.length} value${applied.length > 1 ? "s" : ""} in the spec that differed from what we locked in conversation — corrected before saving:_\n${applied.map(c => `• *${c.description}:* ${c.found} → ${c.correct}`).join("\n")}`
      }
    }
    // Cache spec, ask for confirmation — don't save until user explicitly confirms
    setPendingApproval(threadTs, { specType: "engineering", specContent: finalSpecContent, filePath, featureName })
    const confirmMsg = `Looks like you're approving the engineering spec. Just to be certain before I save it — reply *confirmed* to lock it in and hand off to the engineering agents, or let me know if there's anything left to review.${correctionNote}`
    appendMessage(threadTs, { role: "assistant", content: confirmMsg })
    await update(`${prefix}${confirmMsg}`)
    return
  }

  appendMessage(threadTs, { role: "assistant", content: response })
  await update(`${prefix}${response}`)
}
