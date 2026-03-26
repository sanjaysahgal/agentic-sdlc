import { loadAgentContext, loadDesignAgentContext, loadArchitectAgentContext } from "../../../runtime/context-loader"
import { runAgent, UserImage } from "../../../runtime/claude-client"
import { getHistory, appendMessage, getConfirmedAgent, setConfirmedAgent, getPendingEscalation, setPendingEscalation, clearPendingEscalation, getPendingApproval, setPendingApproval, clearPendingApproval } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, isCreateSpecIntent, extractSpecContent, hasDraftSpec, extractDraftSpec, hasPmPatch, extractPmPatch } from "../../../agents/pm"
import { buildDesignSystemPrompt, isCreateDesignSpecIntent, hasDraftDesignSpec, extractDraftDesignSpec, extractDesignSpecContent, hasEscalationOffer, extractEscalationQuestion, stripEscalationMarker, buildDesignStateResponse, hasProductSpecUpdate, extractProductSpecUpdate, hasDesignPatch, extractDesignPatch, hasPreviewOnly, extractPreviewOnly } from "../../../agents/design"
import { buildArchitectSystemPrompt, isCreateEngineeringSpecIntent, hasDraftEngineeringSpec, extractDraftEngineeringSpec, extractEngineeringSpecContent, hasArchitectPatch, extractArchitectPatch } from "../../../agents/architect"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, saveDraftDesignSpec, saveApprovedDesignSpec, saveDraftEngineeringSpec, saveApprovedEngineeringSpec, saveDraftHtmlPreview, getInProgressFeatures, readFile } from "../../../runtime/github-client"
import { classifyIntent, classifyMessageScope, detectPhase, isOffTopicForAgent, isSpecStateQuery, detectRenderIntent, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { auditSpecDraft, auditSpecDecisions, applyDecisionCorrections, extractLockedDecisions } from "../../../runtime/spec-auditor"
import { getPriorContext, buildEnrichedMessage, identifyUncommittedDecisions, generateSaveCheckpoint } from "../../../runtime/conversation-summarizer"
import { generateDesignPreview } from "../../../runtime/html-renderer"
import { extractBlockingQuestions } from "../../../runtime/spec-utils"
import { applySpecPatch } from "../../../runtime/spec-patcher"

const { paths: workspacePaths } = loadWorkspaceConfig()

// Formats a save checkpoint into the Slack footer shown after every DRAFT or PATCH save.
// Shows what key decisions were just committed and flags anything still only in the thread.
// Non-fatal: callers pass a null checkpoint and fall back to the simple CTA.
function buildCheckpointFooter(
  checkpoint: { committed: string; notCommitted: string } | null,
  specUrl: string,
): string {
  const specLink = `<${specUrl}|Spec>`
  if (!checkpoint || !checkpoint.committed) {
    return `\n\n✓ _Draft committed to GitHub  ·  ${specLink}_`
  }
  const committedSection = `*Key decisions in this commit:*\n${checkpoint.committed}`
  const notCommittedSection = checkpoint.notCommitted
    ? `\n\n⚠️ *Discussed in this thread but not yet committed:*\n${checkpoint.notCommitted}\n_Reply with the numbers you want to lock in and I'll update the spec._`
    : `\n\n_Discussed in this thread but not yet committed: nothing — everything is in the spec above._`
  return `\n\n✓ *Draft committed to GitHub*  ·  ${specLink}\n\n${committedSection}${notCommittedSection}`
}

function getFeatureName(channelName: string): string {
  return channelName.replace(/^feature-/, "")
}

// Detects a check-in message ("are you there", "ping", etc.) without a Haiku round-trip.
// These should always go to the spec state fast-path — never to the full agent.
// Deterministic keyword match so the check-in → state response path is 100% reliable.
const CHECK_IN_RE = /^(are you (still )?there|you (still )?there|still there|hello\.?|hi\.?|ping|hey\.?|you back)\.?[?!]?$/i

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
      const { roles } = loadWorkspaceConfig()
      const mention = roles.pmUser ? `<@${roles.pmUser}>` : `*Product Manager*`
      const escalationMsg =
        `${mention} — UX Designer has a blocking product question that needs a decision before the design spec can continue:\n\n` +
        `*"${pendingEscalation.question}"*\n\n` +
        `_Reply here to unblock design._`
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: escalationMsg })
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: `Escalated to PM: "${pendingEscalation.question}". Design is paused until they respond.` })
      return
    }
    // User declined escalation or sent a new message — clear pending and continue normally
    if (pendingEscalation) clearPendingEscalation(threadTs)

    // If the design spec is now approved, route to the architect.
    const currentPhaseForDesign = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhaseForDesign === "design-approved-awaiting-engineering" || currentPhaseForDesign === "engineering-in-progress") {
      setConfirmedAgent(threadTs, "architect")
      await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
        await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      }})
      return
    }

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
    currentPhase === "product-spec-approved-awaiting-design" || currentPhase === "design-in-progress" ? "UX Designer" :
    currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress" ? "Architect" :
    undefined
  await withThinking({ client, channelId, threadTs, agent: thinkingLabel, run: async (update) => {
    if (currentPhase === "product-spec-approved-awaiting-design" || currentPhase === "design-in-progress") {
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
  const historyPm = getHistory(threadTs)
  const PM_HISTORY_LIMIT = 40
  const [context, lockedDecisionsPm, priorContextPm] = await Promise.all([
    loadAgentContext(featureName),
    extractLockedDecisions(historyPm).catch(() => ""),
    getPriorContext(threadTs, historyPm, PM_HISTORY_LIMIT),
  ])
  const enrichedUserMessagePm = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsPm, priorContext: priorContextPm })

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

  await update("_Product Manager is thinking..._")
  let response = await runAgent({ systemPrompt, history: historyPm, userMessage: enrichedUserMessagePm, userImages })
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

  // Detect truncated DRAFT block for PM — auto-retry with forced PATCH if draft exists.
  if (response.includes("DRAFT_SPEC_START") && !response.includes("DRAFT_SPEC_END")) {
    const existingDraft = await readFile(filePath, `spec/${featureName}-product`)
    if (existingDraft) {
      await update("_Spec is large — switching to section-level update..._")
      const retryInstruction = `SYSTEM OVERRIDE: Your previous response used DRAFT_SPEC_START but was cut off because the spec is too long for a full rewrite. You MUST use PRODUCT_PATCH_START/END instead. Look at the conversation history to identify what changes were requested or agreed. Output a PATCH block covering the 2-3 most important changed sections only — do not try to patch all sections at once. Remaining sections can be patched in a follow-up response.`
      response = await runAgent({ systemPrompt, history: historyPm, userMessage: retryInstruction })
      if (!hasPmPatch(response)) {
        const warn = `Unable to apply the changes automatically. Please say which specific section you'd like to update and I'll patch it directly.`
        appendMessage(threadTs, { role: "assistant", content: warn })
        await update(`${prefix}${warn}`)
        return
      }
      // Fall through to hasPmPatch handler below.
    } else {
      const warn = `The spec was too long to save in one response — the draft was cut off. Try breaking it into two saves: first the Problem and Goals sections, then say *"continue saving the rest"*. (Nothing was saved this time.)`
      appendMessage(threadTs, { role: "assistant", content: warn })
      await update(`${prefix}${warn}`)
      return
    }
  }

  // Detect truncated patch block for PM.
  if (response.includes("PRODUCT_PATCH_START") && !response.includes("PRODUCT_PATCH_END")) {
    const warn = `The spec update was cut off before it could be saved. Please say *"apply the updates"* and I'll try again. (Nothing was changed this time.)`
    appendMessage(threadTs, { role: "assistant", content: warn })
    await update(`${prefix}${warn}`)
    return
  }

  if (hasPmPatch(response)) {
    const patchContent = extractPmPatch(response)
    const branchName = `spec/${featureName}-product`
    const existingDraft = await readFile(filePath, branchName)
    const mergedDraft = applySpecPatch(existingDraft ?? "", patchContent)

    await update("_Auditing patch against product vision and architecture..._")
    const audit = await auditSpecDraft({
      draft: mergedDraft,
      productVision: context.productVision,
      systemArchitecture: context.systemArchitecture,
      featureName,
    })

    if (audit.status === "conflict") {
      const cleanResponse = response.replace(/PRODUCT_PATCH_START[\s\S]*?PRODUCT_PATCH_END/g, "").trim()
      const conflictQuestion = `Resolve this before we continue. Do you want to adjust the spec, or update the product vision/architecture?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nConflict detected — patch not saved.\n\n${audit.message}\n\n${conflictQuestion}` })
      await update(`${prefix}${cleanResponse}\n\n:warning: *Conflict detected — patch not saved.*\n\n${audit.message}\n\n${conflictQuestion}`)
      return
    }

    if (audit.status === "gap") {
      const cleanResponse = response.replace(/PRODUCT_PATCH_START[\s\S]*?PRODUCT_PATCH_END/g, "").trim()
      const gapQuestion = `Do you want to update the product vision/architecture to cover this, or treat it as a deliberate extension?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nGap detected — patch saved, but a decision is needed.\n\n${audit.message}\n\n${gapQuestion}` })
      await update(`${prefix}${cleanResponse}\n\n:thinking_face: *Gap detected — patch saved, but a decision is needed.*\n\n${audit.message}\n\n${gapQuestion}`)
      await saveDraftSpec({ featureName, filePath, content: mergedDraft })
      return
    }

    await update("_Saving updated draft to GitHub..._")
    await saveDraftSpec({ featureName, filePath, content: mergedDraft })
    const cleanResponse = response.replace(/PRODUCT_PATCH_START[\s\S]*?PRODUCT_PATCH_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}\n\n_Draft updated and saved to \`${filePath}\`._`)
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

  // Platform enforcement flags — set inside the !readOnly block when render intent is detected.
  // Both inject a mandatory override after context loading. The agent is always in the loop.
  let forcePreviewOnly = false
  let forceApplyAndRender = false

  // Short-circuit status/general queries before loading expensive design context.
  // A "give me the latest spec" question in a design thread doesn't need the full
  // design agent — it needs the concierge. Check fast with Haiku before loading anything.
  if (!readOnly) {
    // Check-in messages ("are you there", "ping", etc.) always go straight to the spec state
    // fast-path — deterministic keyword match, no Haiku round-trip, no chance of hallucination.
    const isCheckIn = CHECK_IN_RE.test(userMessage.trim())

    const offTopic = isCheckIn ? false : await isOffTopicForAgent(userMessage, "design")
    if (offTopic) {
      const mainChannel = loadWorkspaceConfig().mainChannel
      const msg = `For status and progress updates, ask in *#${mainChannel}* — the concierge has the full picture across all features.\n\nI'm the UX Designer — I'm here when you're ready to work on screens, flows, or design decisions for this feature.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }

    // "Where are we" overview — fast path, no context load or Sonnet call needed.
    // Check-in messages skip Haiku and go directly here.
    const isStateQuery = isCheckIn || await isSpecStateQuery(userMessage)
    if (isStateQuery) {
      await update("_Reading current draft..._")
      const { paths, githubOwner, githubRepo } = loadWorkspaceConfig()
      const branchName = `spec/${featureName}-design`
      const designDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`

      const draftContent = await readFile(designDraftPath, branchName)
      const specUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/${branchName}/${designDraftPath}`

      // Re-upload the saved preview if it exists — non-fatal.
      // The preview is generated on every draft save; here we just re-serve it.
      let previewNote: string | null = null
      if (draftContent) {
        const htmlFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.preview.html`
        const previewContent = await readFile(htmlFilePath, branchName)
        if (previewContent) {
          try {
            await client.files.uploadV2({
              channel_id: channelId,
              thread_ts: threadTs,
              content: previewContent,
              filename: `${featureName}.preview.html`,
              title: `${featureName} — Design Preview`,
            })
            previewNote = `\n\n_HTML preview attached above — open it in any browser. Use device toolbar (Cmd+Shift+M in Chrome) to check mobile layout._`
          } catch (uploadErr: any) {
            console.error(`[preview] Slack upload failed (add files:write scope): ${uploadErr?.message}`)
          }
        }
      }
      const threadHistory = getHistory(threadTs)
      let uncommittedNote = ""
      if (threadHistory.length > 6) {
        await update("_Reviewing conversation for uncommitted decisions..._")
        const cacheKey = `${threadTs}:${threadHistory.length}`
        const uncommitted = await identifyUncommittedDecisions(threadHistory, draftContent ?? "", cacheKey).catch(() => "")
        const isAllCommitted = uncommitted.toLowerCase().includes("all discussed decisions appear to be in the committed spec")
        if (uncommitted && !isAllCommitted) {
          uncommittedNote = `*Decisions from our conversation not yet committed to GitHub — my recommendations:*\n${uncommitted}\n\n_Reply with the numbers you want to lock in (e.g. "1 and 3") and I'll update the spec._`
        }
      }
      const msg = uncommittedNote + (uncommittedNote ? "\n\n---\n\n" : "") + buildDesignStateResponse({ featureName, draftContent, specUrl, previewNote })
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }

    // PLATFORM ENFORCEMENT (Trust Step 0.5): detect render/preview intent before the agent runs.
    // The agent is ALWAYS in the loop — it has conversation context the platform does not.
    // The platform only enforces what block the agent must output; the agent decides the content.
    //
    // render intent → force PREVIEW_ONLY: agent outputs a preview block incorporating any
    //   uncommitted decisions from the conversation. Nothing saved until user approves.
    // apply-and-render → force PATCH: agent applies changes and saves. HTML renders on every save.
    const renderIntent = await detectRenderIntent(userMessage)

    if (renderIntent === "render-only") {
      forcePreviewOnly = true
    }

    if (renderIntent === "apply-and-render") {
      forceApplyAndRender = true
    }
  }

  await update("_UX Designer is reading the spec and design context..._")
  const historyDesign = getHistory(threadTs)
  const DESIGN_HISTORY_LIMIT = 20
  const [context, lockedDecisionsDesign, priorContextDesign] = await Promise.all([
    loadDesignAgentContext(featureName),
    extractLockedDecisions(historyDesign).catch(() => ""),
    getPriorContext(threadTs, historyDesign, DESIGN_HISTORY_LIMIT),
  ])
  const baseEnrichedMessage = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsDesign, priorContext: priorContextDesign })
  const previewOnlyOverride = `First, briefly list any specific design decisions from this conversation that have NOT yet been saved to GitHub — name them concisely (e.g. "Dark mode (#0A0A0F)", "Glow 10→15→10% at 2.5s"). If everything is already in the spec, say so in one line. Then output a PREVIEW_ONLY_START block containing the full current design spec with those uncommitted decisions incorporated and marked [pending approval] inline. Do not ask permission. Do not offer choices. Do not discuss the HTML renderer — the platform renders automatically.`
  const applyAndRenderOverride = `Apply all requested changes and output a DESIGN_PATCH_START block immediately. Do not ask permission. Do not offer options. Do not discuss the HTML renderer — the platform handles rendering automatically on every save. Your only job: output the PATCH block with all agreed changes now.`
  const enrichedUserMessageDesign = forcePreviewOnly
    ? baseEnrichedMessage + `\n\nPLATFORM OVERRIDE: ${previewOnlyOverride}`
    : forceApplyAndRender
      ? baseEnrichedMessage + `\n\nPLATFORM OVERRIDE: ${applyAndRenderOverride}`
      : baseEnrichedMessage
  const systemPromptOverride = forcePreviewOnly
    ? previewOnlyOverride
    : forceApplyAndRender
      ? applyAndRenderOverride
      : undefined
  const systemPrompt = buildDesignSystemPrompt(context, featureName, readOnly, systemPromptOverride)

  await update("_UX Designer is thinking..._")
  // Design agent has a much larger context (system prompt + product vision + full draft spec)
  // than the PM agent. Cap at 20 messages (10 exchanges) so the combined payload stays well
  // under the token limit. Prior conversation context beyond the limit is summarized and
  // injected into the user message — no work is lost on long threads.
  let response = await runAgent({ systemPrompt, history: historyDesign, userMessage: enrichedUserMessageDesign, userImages, historyLimit: DESIGN_HISTORY_LIMIT })
  appendMessage(threadTs, { role: "user", content: userMessage })

  const filePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""

  if (readOnly) {
    const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").replace(/INTENT: CREATE_DESIGN_SPEC/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}`)
    return
  }

  // PREVIEW_ONLY block — render HTML from proposed content without saving to GitHub.
  // Used when the user wants to see a proposal before agreeing to it.
  // Nothing is committed. If the user approves after seeing it, the next response saves a DRAFT.
  if (hasPreviewOnly(response)) {
    const previewContent = extractPreviewOnly(response)
    const cleanResponse = response.replace(/PREVIEW_ONLY_START[\s\S]*?PREVIEW_ONLY_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    if (previewContent) {
      try {
        await update("_Generating preview (not saved yet)..._")
        const htmlContent = await generateDesignPreview({ specContent: previewContent, featureName })
        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          content: htmlContent,
          filename: `${featureName}.preview.html`,
          title: `${featureName} — Design Preview (not saved)`,
        })
        const msg = `${cleanResponse}\n\n_Preview generated — this has NOT been saved to GitHub. Say *approved* or *looks good* to save and lock it in, or share what needs changing._`
        await update(`${prefix}${msg}`)
      } catch (err: any) {
        console.error(`[preview-only] HTML generation failed: ${err?.message}`)
        await update(`${prefix}${cleanResponse}\n\n_Preview couldn't be generated — ${err?.message ?? "unknown error"}. Say *approved* to save this to GitHub without a preview._`)
      }
    } else {
      await update(`${prefix}${cleanResponse}`)
    }
    return
  }

  // If the PM authorized a product direction change, commit the updated product spec
  // to GitHub BEFORE auditing the design draft — so the spec chain stays consistent.
  let updatedProductSpecContent: string | undefined
  if (hasProductSpecUpdate(response)) {
    updatedProductSpecContent = extractProductSpecUpdate(response)
    if (updatedProductSpecContent) {
      await update("_Applying PM-authorized product spec update..._")
      const productSpecPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
      await saveApprovedSpec({ featureName, filePath: productSpecPath, content: updatedProductSpecContent })
    }
  }

  // Extract the approved product spec from context for use in the audit.
  // The product spec is embedded in currentDraft as "## Approved Product Spec\n..."
  const productSpecMatch = context.currentDraft.match(/## Approved Product Spec\n([\s\S]*?)(?:\n\n## |$)/)
  const auditProductSpec = updatedProductSpecContent ?? (productSpecMatch ? productSpecMatch[1].trim() : "")

  // Detect truncated DRAFT block — response hit max_tokens mid-spec.
  // If a draft exists: auto-retry with a forced PATCH instruction — user never sees the error.
  // If no draft yet (first save): guide toward a split save.
  if (response.includes("DRAFT_DESIGN_SPEC_START") && !response.includes("DRAFT_DESIGN_SPEC_END")) {
    const existingDraft = await readFile(filePath, `spec/${featureName}-design`)
    if (existingDraft) {
      await update("_Spec is large — switching to section-level update..._")
      const retryInstruction = `SYSTEM OVERRIDE: Your previous response used DRAFT_DESIGN_SPEC_START but was cut off because the spec is too long for a full rewrite. You MUST use DESIGN_PATCH_START/END instead. Look at the conversation history to identify what changes were requested or agreed. Output a PATCH block covering the 2-3 most important changed sections only — do not try to patch all sections at once. Remaining sections can be patched in a follow-up response.`
      response = await runAgent({ systemPrompt, history: historyDesign, userMessage: retryInstruction, historyLimit: DESIGN_HISTORY_LIMIT })
      // If the retry didn't produce a PATCH block, fall through to the error below.
      if (!hasDesignPatch(response)) {
        const warn = `Unable to apply the changes automatically. Please say which specific section you'd like to update (e.g. "update just the Design Direction section") and I'll patch it directly.`
        appendMessage(threadTs, { role: "assistant", content: warn })
        await update(`${prefix}${warn}`)
        return
      }
      // Retry produced a PATCH — fall through to the hasDesignPatch handler below.
    } else {
      const warn = `The spec was too long to save in one response — the draft was cut off. Please try breaking it into two saves: first the Design Direction and Screens, then say *"continue saving the rest"*. (Nothing was saved this time.)`
      appendMessage(threadTs, { role: "assistant", content: warn })
      await update(`${prefix}${warn}`)
      return
    }
  }

  // Detect truncated patch block — same failure mode as above but for PATCH blocks.
  if (response.includes("DESIGN_PATCH_START") && !response.includes("DESIGN_PATCH_END")) {
    const warn = `The spec update was cut off before it could be saved. Please say *"apply the updates"* and I'll try again. (Nothing was changed this time.)`
    appendMessage(threadTs, { role: "assistant", content: warn })
    await update(`${prefix}${warn}`)
    return
  }

  if (hasDesignPatch(response)) {
    const patchContent = extractDesignPatch(response)
    // Read existing draft, apply patch, save merged result
    const { paths } = loadWorkspaceConfig()
    const branchName = `spec/${featureName}-design`
    const designDraftPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`
    const existingDraft = await readFile(designDraftPath, branchName)
    const mergedDraft = applySpecPatch(existingDraft ?? "", patchContent)

    await update("_Auditing patch against product vision and architecture..._")
    const audit = await auditSpecDraft({
      draft: mergedDraft,
      productVision: context.productVision,
      systemArchitecture: context.systemArchitecture,
      productSpec: auditProductSpec,
      featureName,
    })

    if (audit.status === "conflict") {
      const cleanResponse = response.replace(/DESIGN_PATCH_START[\s\S]*?DESIGN_PATCH_END/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()
      const conflictQuestion = `Resolve this before we continue. Do you want to adjust the design, or update the product vision/architecture?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\n${audit.message}\n\n${conflictQuestion}` })
      await update(`${prefix}${cleanResponse}\n\n:no_entry: *Conflict detected:*\n\n${audit.message}\n\n${conflictQuestion}`)
      return
    }

    if (audit.status === "gap") {
      const cleanResponse = response.replace(/DESIGN_PATCH_START[\s\S]*?DESIGN_PATCH_END/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()
      const gapQuestion = `Do you want to update the product vision/architecture to cover this, or treat it as a deliberate extension?`
      appendMessage(threadTs, { role: "assistant", content: `${cleanResponse}\n\nGap detected — patch saved, but a decision is needed.\n\n${audit.message}\n\n${gapQuestion}` })
      await update(`${prefix}${cleanResponse}\n\n:thinking_face: *Gap detected:*\n\n${audit.message}\n\n${gapQuestion}`)
      await saveDraftDesignSpec({ featureName, filePath: designDraftPath, content: mergedDraft })
      return
    }

    await update("_Saving updated draft to GitHub..._")
    await saveDraftDesignSpec({ featureName, filePath: designDraftPath, content: mergedDraft })

    const cleanResponse = response.replace(/DESIGN_PATCH_START[\s\S]*?DESIGN_PATCH_END/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()

    // Generate HTML preview and checkpoint in parallel — both non-fatal.
    const { paths: p, githubOwner: pOwner, githubRepo: pRepo } = loadWorkspaceConfig()
    const patchSpecUrl = `https://github.com/${pOwner}/${pRepo}/blob/spec/${featureName}-design/${p.featuresRoot}/${featureName}/${featureName}.design.md`
    let previewNote = ""
    let checkpoint: { committed: string; notCommitted: string } | null = null
    await update("_Generating HTML preview and save checkpoint..._")
    const [previewResult, checkpointResult] = await Promise.allSettled([
      generateDesignPreview({ specContent: mergedDraft, featureName }),
      generateSaveCheckpoint(mergedDraft, historyDesign),
    ])
    if (previewResult.status === "fulfilled") {
      const htmlContent = previewResult.value
      const htmlFilePath = `${p.featuresRoot}/${featureName}/${featureName}.preview.html`
      await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: htmlContent }).catch(() => {})
      try {
        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          content: htmlContent,
          filename: `${featureName}.preview.html`,
          title: `${featureName} — Design Preview`,
        })
        previewNote = `\n\n_HTML preview attached above — open it in any browser. Use device toolbar (Cmd+Shift+M in Chrome) to check mobile layout._`
      } catch (uploadErr: any) {
        console.error(`[preview] Slack upload failed: ${uploadErr?.message}`)
        previewNote = `\n\n_Preview saved to GitHub. To view it: open the spec branch, download \`${featureName}.preview.html\`, and open in any browser._`
      }
    } else {
      console.error(`[preview] HTML generation failed: ${previewResult.reason?.message}`)
      previewNote = `\n\n_HTML preview couldn't be generated. Say *"regenerate preview"* to try again._`
    }
    if (checkpointResult.status === "fulfilled") checkpoint = checkpointResult.value

    const checkpointFooter = buildCheckpointFooter(checkpoint, patchSpecUrl)
    const cta = `\n\nReview the preview above, then say *approved* to lock it in and move to engineering — or share feedback and we'll refine first.`
    const suffix = previewNote + checkpointFooter + cta
    const maxCleanLength = 9_000 - prefix.length
    const truncatedClean = cleanResponse.length > maxCleanLength
      ? cleanResponse.slice(0, cleanResponse.lastIndexOf("\n\n", maxCleanLength) || maxCleanLength) + "\n\n_[Full patch details saved to GitHub — spec is updated.]_"
      : cleanResponse
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${truncatedClean}${suffix}`)
    return
  }

  if (hasDraftDesignSpec(response)) {
    const draftContent = extractDraftDesignSpec(response)
    await update("_Auditing draft against product vision and architecture..._")
    const audit = await auditSpecDraft({
      draft: draftContent,
      productVision: context.productVision,
      systemArchitecture: context.systemArchitecture,
      productSpec: auditProductSpec,
      featureName,
    })

    if (audit.status === "conflict") {
      const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()
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
      const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()
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
    const cleanResponse = response.replace(/DRAFT_DESIGN_SPEC_START[\s\S]*?DRAFT_DESIGN_SPEC_END/g, "").replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()

    // Generate HTML preview and save checkpoint in parallel — both non-fatal.
    // The checkpoint shows what key decisions are now committed and flags
    // anything discussed in this thread that is not yet in the spec.
    const { paths, githubOwner, githubRepo } = loadWorkspaceConfig()
    const draftSpecUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/spec/${featureName}-design/${paths.featuresRoot}/${featureName}/${featureName}.design.md`
    let previewNote = ""
    let draftCheckpoint: { committed: string; notCommitted: string } | null = null
    await update("_Generating HTML preview and save checkpoint..._")
    const [draftPreviewResult, draftCheckpointResult] = await Promise.allSettled([
      generateDesignPreview({ specContent: draftContent, featureName }),
      generateSaveCheckpoint(draftContent, historyDesign),
    ])
    if (draftPreviewResult.status === "fulfilled") {
      const htmlContent = draftPreviewResult.value
      const htmlFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.preview.html`
      await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: htmlContent }).catch(() => {})
      try {
        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          content: htmlContent,
          filename: `${featureName}.preview.html`,
          title: `${featureName} — Design Preview`,
        })
        previewNote = `\n\n_HTML preview attached above — open it in any browser. Use device toolbar (Cmd+Shift+M in Chrome) to check mobile layout._`
      } catch (uploadErr: any) {
        console.error(`[preview] Slack upload failed (add files:write scope): ${uploadErr?.message}`)
        previewNote = `\n\n_Preview saved to GitHub. To view it: open the spec branch, download \`${featureName}.preview.html\`, and open in any browser._`
      }
    } else {
      console.error(`[preview] HTML generation failed: ${draftPreviewResult.reason?.message}`)
      previewNote = `\n\n_HTML preview couldn't be generated for this draft. Say *"regenerate preview"* to try again._`
    }
    if (draftCheckpointResult.status === "fulfilled") draftCheckpoint = draftCheckpointResult.value

    // Build a guaranteed suffix so truncation never swallows the checkpoint or CTA.
    // Only cleanResponse gets truncated — the suffix always appears.
    const checkpointFooter = buildCheckpointFooter(draftCheckpoint, draftSpecUrl)
    const cta = `\n\nReview the preview above, then say *approved* to lock it in and move to engineering — or share feedback and we'll refine first.`
    const suffix = previewNote + checkpointFooter + cta
    const maxCleanLength = 9_000 - prefix.length
    const truncatedClean = cleanResponse.length > maxCleanLength
      ? cleanResponse.slice(0, cleanResponse.lastIndexOf("\n\n", maxCleanLength) || maxCleanLength) + "\n\n_[Full spec details saved to GitHub — draft is complete.]_"
      : cleanResponse
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${truncatedClean}${suffix}`)
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

  const finalResponse = response.replace(/PRODUCT_SPEC_UPDATE_START[\s\S]*?PRODUCT_SPEC_UPDATE_END/g, "").trim()
  appendMessage(threadTs, { role: "assistant", content: finalResponse })
  await update(`${prefix}${finalResponse}`)
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
    const isCheckInArch = CHECK_IN_RE.test(userMessage.trim())

    const offTopic = isCheckInArch ? false : await isOffTopicForAgent(userMessage, "engineering")
    if (offTopic) {
      const mainChannel = loadWorkspaceConfig().mainChannel
      const msg = `For status and progress updates, ask in *#${mainChannel}* — the concierge has the full picture across all features.\n\nI'm the Architect — I'm here when you're ready to work on data models, APIs, or engineering decisions for this feature.`
      appendMessage(threadTs, { role: "user", content: userMessage })
      appendMessage(threadTs, { role: "assistant", content: msg })
      await update(msg)
      return
    }

    // "Where are we" overview — fast path, no context load or Sonnet call needed.
    const isStateQuery = isCheckInArch || await isSpecStateQuery(userMessage)
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
  const historyArch = getHistory(threadTs)
  const ARCH_HISTORY_LIMIT = 40
  const [context, lockedDecisionsArch, priorContextArch] = await Promise.all([
    loadArchitectAgentContext(featureName),
    extractLockedDecisions(historyArch).catch(() => ""),
    getPriorContext(threadTs, historyArch, ARCH_HISTORY_LIMIT),
  ])
  const enrichedUserMessageArch = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsArch, priorContext: priorContextArch })
  const systemPrompt = buildArchitectSystemPrompt(context, featureName, readOnly)

  await update("_Architect is thinking..._")
  let response = await runAgent({ systemPrompt, history: historyArch, userMessage: enrichedUserMessageArch, userImages, historyLimit: ARCH_HISTORY_LIMIT })
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

  // Detect truncated DRAFT block for architect — auto-retry with forced PATCH if draft exists.
  if (response.includes("DRAFT_ENGINEERING_SPEC_START") && !response.includes("DRAFT_ENGINEERING_SPEC_END")) {
    const existingDraft = await readFile(filePath, `spec/${featureName}-engineering`)
    if (existingDraft) {
      await update("_Spec is large — switching to section-level update..._")
      const retryInstruction = `SYSTEM OVERRIDE: Your previous response used DRAFT_ENGINEERING_SPEC_START but was cut off because the spec is too long for a full rewrite. You MUST use ENGINEERING_PATCH_START/END instead. Look at the conversation history to identify what changes were requested or agreed. Output a PATCH block covering the 2-3 most important changed sections only — do not try to patch all sections at once. Remaining sections can be patched in a follow-up response.`
      response = await runAgent({ systemPrompt, history: historyArch, userMessage: retryInstruction, historyLimit: ARCH_HISTORY_LIMIT })
      if (!hasArchitectPatch(response)) {
        const warn = `Unable to apply the changes automatically. Please say which specific section you'd like to update and I'll patch it directly.`
        appendMessage(threadTs, { role: "assistant", content: warn })
        await update(`${prefix}${warn}`)
        return
      }
      // Fall through to hasArchitectPatch handler below.
    } else {
      const warn = `The spec was too long to save in one response — the draft was cut off. Try breaking it into two saves: first the Data Model and API sections, then say *"continue saving the rest"*. (Nothing was saved this time.)`
      appendMessage(threadTs, { role: "assistant", content: warn })
      await update(`${prefix}${warn}`)
      return
    }
  }

  // Detect truncated patch block for architect.
  if (response.includes("ENGINEERING_PATCH_START") && !response.includes("ENGINEERING_PATCH_END")) {
    const warn = `The spec update was cut off before it could be saved. Please say *"apply the updates"* and I'll try again. (Nothing was changed this time.)`
    appendMessage(threadTs, { role: "assistant", content: warn })
    await update(`${prefix}${warn}`)
    return
  }

  if (hasArchitectPatch(response)) {
    const patchContent = extractArchitectPatch(response)
    const branchName = `spec/${featureName}-engineering`
    const existingDraft = await readFile(filePath, branchName)
    const mergedDraft = applySpecPatch(existingDraft ?? "", patchContent)

    await update("_Saving updated engineering spec to GitHub..._")
    await saveDraftEngineeringSpec({ featureName, filePath, content: mergedDraft })
    const cleanResponse = response.replace(/ENGINEERING_PATCH_START[\s\S]*?ENGINEERING_PATCH_END/g, "").trim()
    appendMessage(threadTs, { role: "assistant", content: cleanResponse })
    await update(`${prefix}${cleanResponse}\n\n_Engineering spec updated and saved to \`${filePath}\`._`)
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
