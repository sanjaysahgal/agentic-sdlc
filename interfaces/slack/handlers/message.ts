import { loadAgentContext, loadDesignAgentContext, loadArchitectAgentContext } from "../../../runtime/context-loader"
import { runAgent, UserImage, ToolCallRecord } from "../../../runtime/claude-client"
import { getHistory, getLegacyMessages, appendMessage, getConfirmedAgent, setConfirmedAgent, getPendingEscalation, setPendingEscalation, clearPendingEscalation, getPendingApproval, setPendingApproval, clearPendingApproval, Message } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, PM_TOOLS } from "../../../agents/pm"
import { buildDesignSystemPrompt, buildDesignStateResponse, DESIGN_TOOLS } from "../../../agents/design"
import { buildArchitectSystemPrompt, ARCHITECT_TOOLS } from "../../../agents/architect"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, saveDraftDesignSpec, saveApprovedDesignSpec, saveDraftEngineeringSpec, saveApprovedEngineeringSpec, saveDraftHtmlPreview, getInProgressFeatures, readFile } from "../../../runtime/github-client"
import { classifyIntent, classifyMessageScope, detectPhase, isOffTopicForAgent, isSpecStateQuery, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { auditSpecDraft, auditSpecDecisions, applyDecisionCorrections, extractLockedDecisions, auditSpecRenderAmbiguity, filterDesignContent, auditRedundantBranding, auditCopyCompleteness } from "../../../runtime/spec-auditor"
import { auditPhaseCompletion, PM_RUBRIC, buildDesignRubric, ENGINEER_RUBRIC } from "../../../runtime/phase-completion-auditor"
import { auditBrandTokens, auditAnimationTokens, auditMissingBrandTokens } from "../../../runtime/brand-auditor"
import { getPriorContext, buildEnrichedMessage, identifyUncommittedDecisions, generateSaveCheckpoint } from "../../../runtime/conversation-summarizer"
import { generateDesignPreview } from "../../../runtime/html-renderer"
import { extractBlockingQuestions, extractSpecTextLiterals } from "../../../runtime/spec-utils"
import { applySpecPatch } from "../../../runtime/spec-patcher"

const { paths: workspacePaths, targetFormFactors } = loadWorkspaceConfig()

// Per-feature flag: tracks which features have already received the context-summarization notice.
// Prevents spamming the user on every message after the history limit is reached.
const summarizationWarnedFeatures = new Set<string>()

// Content-addressed cache for phase entry upstream spec audits.
// Key: `${agentType}:${featureName}:${specFingerprint}` — invalidates automatically when upstream spec content changes.
// Value: formatted PLATFORM NOTICE string (empty string = no issues found).
// In-memory only: intentionally lost on restart so first message after deployment always re-audits.
const phaseEntryAuditCache = new Map<string, string>()

// Lightweight content fingerprint — fast, no crypto dependency.
// Detects any edit to spec content including manual edits mid-phase.
function specFingerprint(content: string): string {
  return `${content.length}:${content.slice(0, 100)}:${content.slice(-50)}`
}

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
  const featureName = getFeatureName(channelName)

  const confirmedAgent = getConfirmedAgent(featureName)

  // Confirmed agent — check phase first, then run
  if (confirmedAgent === "ux-design") {
    // If the design agent offered a PM escalation last turn and the user is confirming it,
    // run the PM agent with the blocking question as its opening brief.
    const pendingEscalation = getPendingEscalation(featureName)
    if (pendingEscalation && isAffirmative(userMessage)) {
      clearPendingEscalation(featureName)
      const { roles } = loadWorkspaceConfig()
      const isArchitectEscalation = pendingEscalation.targetAgent === "architect"
      const mention = isArchitectEscalation
        ? (roles.architectUser ? `<@${roles.architectUser}>` : `*Architect*`)
        : (roles.pmUser ? `<@${roles.pmUser}>` : `*Product Manager*`)
      const questionType = isArchitectEscalation ? "blocking architecture question" : "blocking product question"
      const pausedRole = isArchitectEscalation ? "Architect" : "PM"
      const escalationMsg =
        `${mention} — UX Designer has a ${questionType} that needs a decision before the design spec can continue:\n\n` +
        `*"${pendingEscalation.question}"*\n\n` +
        `_Reply here to unblock design._`
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: escalationMsg })
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: `Escalated to ${pausedRole}: "${pendingEscalation.question}". Design is paused until they respond.` })
      return
    }
    // User declined escalation or sent a new message — clear pending and continue normally
    if (pendingEscalation) clearPendingEscalation(featureName)

    // If the design spec is now approved, route to the architect.
    const currentPhaseForDesign = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhaseForDesign === "design-approved-awaiting-engineering" || currentPhaseForDesign === "engineering-in-progress") {
      setConfirmedAgent(featureName, "architect")
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
      setConfirmedAgent(featureName, "ux-design")
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
      setConfirmedAgent(featureName, "ux-design")
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      return
    }

    if (currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress") {
      setConfirmedAgent(featureName, "architect")
      await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      return
    }

    const phase = detectPhase({
      productSpecApproved: channelState.productSpecApproved,
      engineeringSpecApproved: channelState.engineeringSpecApproved,
    })
    const history = getHistory(featureName)
    const suggestedAgent = await classifyIntent({ message: userMessage, history, phase })

    setConfirmedAgent(featureName, suggestedAgent)

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
  const pendingApproval = getPendingApproval(featureName)
  if (pendingApproval && pendingApproval.specType === "product") {
    if (isAffirmative(userMessage)) {
      clearPendingApproval(featureName)
      await update("_Saving the final product spec..._")
      await saveApprovedSpec({ featureName, filePath: pendingApproval.filePath, content: pendingApproval.specContent })
      const approvalMessage =
        `The *${featureName}* product spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `A UX designer produces the screens and user flows before any engineering begins. ` +
        `If you're wearing the designer hat on this one, just say so right here and the design phase will begin.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(featureName)
      // Not confirming — fall through to normal agent flow
    }
  }

  await update("_Product Manager is reading the spec..._")
  const historyPm = getHistory(featureName)
  const PM_HISTORY_LIMIT = 40
  const [context, lockedDecisionsPm, priorContextPm] = await Promise.all([
    loadAgentContext(featureName),
    extractLockedDecisions(historyPm).catch(() => ""),
    getPriorContext(featureName, historyPm, PM_HISTORY_LIMIT),
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

  const pmFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""
  const toolCallsOutPm: ToolCallRecord[] = []

  const response = await runAgent({
    systemPrompt,
    history: historyPm,
    userMessage: enrichedUserMessagePm,
    userImages,
    tools: readOnly ? undefined : PM_TOOLS,
    toolHandler: readOnly ? undefined : async (name, input) => {
      if (name === "save_product_spec_draft") {
        const content = input.content as string
        await update("_Auditing spec against product vision and architecture..._")
        const audit = await auditSpecDraft({
          draft: content,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          featureName,
        })
        if (audit.status === "conflict") {
          return { error: `Conflict detected — spec not saved: ${audit.message}` }
        }
        await update("_Saving draft to GitHub..._")
        await saveDraftSpec({ featureName, filePath: pmFilePath, content })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/spec/${featureName}-product/${pmFilePath}`
        const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
        return { result: { url, audit: auditOut } }
      }
      if (name === "apply_product_spec_patch") {
        const patch = input.patch as string
        const branchName = `spec/${featureName}-product`
        const existingDraft = await readFile(pmFilePath, branchName)
        const mergedDraft = applySpecPatch(existingDraft ?? "", patch)
        await update("_Auditing patch against product vision and architecture..._")
        const audit = await auditSpecDraft({
          draft: mergedDraft,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          featureName,
        })
        if (audit.status === "conflict") {
          return { error: `Conflict detected — patch not saved: ${audit.message}` }
        }
        await update("_Saving updated draft to GitHub..._")
        await saveDraftSpec({ featureName, filePath: pmFilePath, content: mergedDraft })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/spec/${featureName}-product/${pmFilePath}`
        const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
        return { result: { url, audit: auditOut } }
      }
      if (name === "run_phase_completion_audit") {
        await update("_Running phase completion audit..._")
        const draft = await readFile(pmFilePath, `spec/${featureName}-product`)
        if (!draft) {
          return { result: { ready: false, findings: [{ issue: "No spec draft found", recommendation: "Save a draft first using save_product_spec_draft before running the audit." }] } }
        }
        const result = await auditPhaseCompletion({
          specContent: draft,
          rubric: PM_RUBRIC,
          featureName,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
        })
        return { result }
      }
      if (name === "finalize_product_spec") {
        const existingDraft = await readFile(pmFilePath, `spec/${featureName}-product`)
        if (!existingDraft) {
          return { error: "No draft saved yet — save a draft first before finalizing." }
        }
        const blockingQuestions = extractBlockingQuestions(existingDraft)
        if (blockingQuestions.length > 0) {
          return { error: `Approval blocked — ${blockingQuestions.length} blocking question${blockingQuestions.length > 1 ? "s" : ""} must be resolved first:\n${blockingQuestions.map(q => `• ${q}`).join("\n")}` }
        }
        let finalContent = existingDraft
        const decisionAudit = await auditSpecDecisions({ specContent: existingDraft, history: getHistory(featureName) })
        if (decisionAudit.status === "corrections") {
          const { corrected } = applyDecisionCorrections(existingDraft, decisionAudit.corrections)
          finalContent = corrected
        }
        await update("_Saving final product spec..._")
        await saveApprovedSpec({ featureName, filePath: pmFilePath, content: finalContent })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${pmFilePath}`
        return { result: { url, nextPhase: "design" } }
      }
      return { error: `Unknown tool: ${name}` }
    },
    toolCallsOut: toolCallsOutPm,
  })

  appendMessage(featureName, { role: "user", content: userMessage })
  appendMessage(featureName, { role: "assistant", content: response })
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
  const pendingDesignApproval = getPendingApproval(featureName)
  if (pendingDesignApproval && pendingDesignApproval.specType === "design") {
    if (isAffirmative(userMessage)) {
      clearPendingApproval(featureName)
      await update("_Saving the final design spec..._")
      await saveApprovedDesignSpec({ featureName, filePath: pendingDesignApproval.filePath, content: pendingDesignApproval.specContent })
      const approvalMessage =
        `The *${featureName}* design spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `A software architect produces the engineering plan before any code is written. ` +
        `If you're wearing the architect hat on this one, just say so right here and the engineering phase will begin.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(featureName)
      // Not confirming — fall through to normal agent flow
    }
  }

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
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: msg })
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

      // Brand token and animation drift audits — pure string diffs, no API call.
      // Both run on every state query so the human always sees all drift without having to ask.
      const brandContent = paths.brand ? await readFile(paths.brand, "main").catch(() => null) : null
      const brandDrifts = brandContent && draftContent ? auditBrandTokens(draftContent, brandContent) : []
      const animationDrifts = brandContent && draftContent ? auditAnimationTokens(draftContent, brandContent) : []

      // Spec gap audit — same Haiku check that runs on draft/patch saves.
      // Runs here so gap detection is consistent: state query surfaces the same gaps as the save path,
      // using the same mechanism and same framing. Without this, gaps only appear after a save and
      // show up differently from the non-blocking questions parsed out of the spec text.
      let specGap: string | null = null
      if (draftContent) {
        const [pvContent, saContent] = await Promise.all([
          readFile(paths.productVision, "main").catch(() => ""),
          readFile(paths.systemArchitecture, "main").catch(() => ""),
        ])
        if (pvContent || saContent) {
          await update("_Auditing spec for gaps..._")
          const specAudit = await auditSpecDraft({ draft: draftContent, productVision: pvContent, systemArchitecture: saContent, featureName }).catch(() => ({ status: "ok" as const, message: "" }))
          specGap = specAudit.status === "gap" ? specAudit.message : null
        }
      }

      const threadHistory = getHistory(featureName)
      // Merge in pre-migration legacy messages so old conversations surface in PENDING check.
      const fullHistory = [...getLegacyMessages(), ...threadHistory]
      let uncommittedDecisions: string | undefined
      if (fullHistory.length > 2) {
        await update("_Reviewing conversation for uncommitted decisions..._")
        const cacheKey = `${featureName}:${fullHistory.length}`
        const uncommitted = await identifyUncommittedDecisions(fullHistory, draftContent ?? "", cacheKey).catch(() => "")
        const isAllCommitted = !uncommitted || uncommitted.trim().toLowerCase() === "none"
        if (uncommitted && !isAllCommitted) {
          uncommittedDecisions = uncommitted
        }
      }

      // Upload a preview — behavior depends on whether uncommitted decisions exist:
      // - Uncommitted decisions present: regenerate fresh from the committed spec so the
      //   preview is a reliable snapshot of what's saved, not a mid-conversation render.
      //   Title clearly states "(committed spec)" so a new user knows what they're looking at.
      // - Everything committed: serve the saved HTML from GitHub (already accurate, no Sonnet call needed).
      let previewNote: string | null = null
      if (draftContent) {
        if (uncommittedDecisions) {
          // Fresh render from committed spec — pending decisions are NOT included.
          await update("_Regenerating preview from committed spec..._")
          const freshPreview = await generateDesignPreview({ specContent: draftContent, featureName, brandContent: brandContent ?? undefined }).catch(() => null)
          if (freshPreview) {
            try {
              await update("_Uploading preview..._")
              await client.files.uploadV2({
                channel_id: channelId,
                thread_ts: threadTs,
                content: freshPreview.html,
                filename: `${featureName}.preview.html`,
                title: `${featureName} — Design Preview (committed spec)`,
              })
              previewNote = `\n\n_HTML preview attached above — reflects the *committed spec only*. Pending decisions listed above are not included. Say *save those* to commit them, then ask for current state again to see them in the preview._`
            } catch (uploadErr: any) {
              console.error(`[preview] Slack upload failed (add files:write scope): ${uploadErr?.message}`)
            }
          }
        } else {
          // No uncommitted decisions — serve the saved preview from GitHub (already in sync).
          const htmlFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.preview.html`
          const previewContent = await readFile(htmlFilePath, branchName)
          if (previewContent) {
            try {
              await update("_Uploading preview..._")
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
      }

      // Deterministic design quality checks — zero LLM cost, always run alongside drift audit.
      const stateQualityIssues = draftContent
        ? [...auditRedundantBranding(draftContent), ...auditCopyCompleteness(draftContent)]
        : []
      const msg = buildDesignStateResponse({ featureName, draftContent, specUrl, previewNote, brandDrifts, animationDrifts, specGap, uncommittedDecisions, qualityIssues: stateQualityIssues })
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: msg })
      await update(msg)
      return
    }

  }

  await update("_UX Designer is reading the spec and design context..._")
  const historyDesign = getHistory(featureName)
  const DESIGN_HISTORY_LIMIT = 20
  const [context, lockedDecisionsDesign, priorContextDesign] = await Promise.all([
    loadDesignAgentContext(featureName),
    extractLockedDecisions(historyDesign).catch(() => ""),
    getPriorContext(featureName, historyDesign, DESIGN_HISTORY_LIMIT),
  ])

  // Fix 6: When context summarization fires, post a one-time notice so the user knows.
  // priorContextDesign is non-empty only when history exceeded DESIGN_HISTORY_LIMIT and was summarized.
  if (priorContextDesign && !summarizationWarnedFeatures.has(featureName)) {
    summarizationWarnedFeatures.add(featureName)
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_Context from earlier in this thread has been summarized to stay within limits. The spec on GitHub is the full authoritative record._",
    }).catch(() => {})
  }

  // Brand token drift audit (color tokens) — pure string diff, always runs.
  const brandDriftsDesign = context.brand ? auditBrandTokens(context.currentDraft, context.brand) : []
  // Animation drift audit — runs alongside color audit on every response.
  const animDriftsDesign = context.brand ? auditAnimationTokens(context.currentDraft, context.brand) : []
  // Missing token audit — canonical BRAND.md tokens not present anywhere in the spec.
  const missingTokensDesign = context.brand ? auditMissingBrandTokens(context.currentDraft, context.brand) : []
  const totalDriftCount = brandDriftsDesign.length + animDriftsDesign.length
  const brandDriftNotice = (totalDriftCount > 0 || missingTokensDesign.length > 0)
    ? `\n\n[PLATFORM NOTICE — BRAND TOKEN DRIFT: ${[
        ...brandDriftsDesign.map(d => `${d.token} spec=${d.specValue} brand=${d.brandValue}`),
        ...animDriftsDesign.map(d => `${d.param} spec=${d.specValue} brand=${d.brandValue}`),
        ...missingTokensDesign.map(d => `${d.token} MISSING from spec (brand=${d.brandValue})`),
      ].join(", ")}. You MUST surface this in your response and offer to patch the spec to align with BRAND.md.]`
    : ""

  // Extract committed text literals from the spec and inject as PLATFORM SPEC FACTS.
  // The agent reads from this authoritative platform-extracted block rather than reconstructing
  // spec content from memory — preventing confabulation ("the spec doesn't define X" when it does).
  const specTextLiterals = extractSpecTextLiterals(context.currentDraft)
  const specTextNotice = specTextLiterals.length > 0
    ? `\n\n[PLATFORM SPEC FACTS — committed text literals in the current design spec (use these exactly, never substitute):\n${specTextLiterals.map(l => `${l.label}: "${l.value}"`).join("\n")}]`
    : ""

  // Phase entry upstream spec audit — PM spec health check on every design agent message.
  // Uses content-addressed cache: any edit to the approved PM spec (including manual edits mid-phase)
  // invalidates the cache automatically. Cache starts empty on restart so first message always audits.
  let upstreamNoticeDesign = ""
  const pmSpecPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
  const pmSpecContent = await readFile(pmSpecPath, "main").catch(() => null)
  if (pmSpecContent) {
    const fp = specFingerprint(pmSpecContent)
    const cacheKey = `design:${featureName}:${fp}`
    if (phaseEntryAuditCache.has(cacheKey)) {
      upstreamNoticeDesign = phaseEntryAuditCache.get(cacheKey)!
    } else {
      const pmAuditResult = await auditPhaseCompletion({
        specContent: pmSpecContent,
        rubric: PM_RUBRIC,
        featureName,
        productVision: context.productVision,
        systemArchitecture: context.systemArchitecture,
      }).catch(() => null)
      if (pmAuditResult && !pmAuditResult.ready) {
        const findingLines = pmAuditResult.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        upstreamNoticeDesign = `\n\n[PLATFORM UPSTREAM SPEC AUDIT — APPROVED PM SPEC HAS ${pmAuditResult.findings.length} GAP${pmAuditResult.findings.length === 1 ? "" : "S"} THAT MUST BE SURFACED TO THE USER BEFORE PROCEEDING:\n${findingLines}\nYou MUST surface these gaps prominently in your response and recommend returning to the PM agent to address them before the design phase continues.]`
      } else {
        upstreamNoticeDesign = ""
      }
      phaseEntryAuditCache.set(cacheKey, upstreamNoticeDesign)
    }
  }

  // Always-on design phase completion audit — runs on every design agent message.
  // Content-addressed cache on spec fingerprint: any edit to the draft invalidates automatically.
  // Principle 7: this check runs always, not when the user asks a readiness-adjacent phrase.
  let designReadinessNotice = ""
  const designSpecDraftPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designDraftContent = await readFile(designSpecDraftPath, `spec/${featureName}-design`).catch(() => null)

  // Deterministic design quality checks — zero LLM cost, run on every response when draft exists.
  // Uses designDraftContent (fetched above from the spec branch) — NOT context.currentDraft which
  // may be empty if the draft is only on a feature branch and not yet committed to main.
  const redundantBrandingIssues = designDraftContent ? auditRedundantBranding(designDraftContent) : []
  const copyCompletenessIssues = designDraftContent ? auditCopyCompleteness(designDraftContent) : []
  const qualityIssues = [...redundantBrandingIssues, ...copyCompletenessIssues]
  const qualityNotice = qualityIssues.length > 0
    ? `\n\n[PLATFORM NOTICE — DESIGN QUALITY: ${qualityIssues.length} issue${qualityIssues.length === 1 ? "" : "s"} must be fixed before approval:\n${qualityIssues.map((i, n) => `${n + 1}. ${i}`).join("\n")}\nYou MUST surface each issue with your concrete recommendation and offer to patch.]`
    : ""
  if (designDraftContent) {
    const dfp = specFingerprint(designDraftContent)
    const designCacheKey = `design-phase:${featureName}:${dfp}`
    if (phaseEntryAuditCache.has(designCacheKey)) {
      designReadinessNotice = phaseEntryAuditCache.get(designCacheKey)!
    } else {
      const designAuditResult = await auditPhaseCompletion({
        specContent: designDraftContent,
        rubric: buildDesignRubric(targetFormFactors),
        featureName,
      }).catch(() => null)
      if (designAuditResult && !designAuditResult.ready) {
        const findingLines = designAuditResult.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        designReadinessNotice = `\n\n[PLATFORM DESIGN READINESS — ${designAuditResult.findings.length} gap${designAuditResult.findings.length === 1 ? "" : "s"} blocking engineering handoff. You MUST surface each finding with your concrete recommendation. For design gaps you own, provide the recommendation directly. For product gaps, call offer_pm_escalation. For architecture gaps, call offer_architect_escalation.\n${findingLines}]`
      } else if (designAuditResult?.ready) {
        designReadinessNotice = `\n\n[PLATFORM DESIGN READINESS — Spec passed all design rubric criteria. You may confirm the spec is engineering-ready when asked.]`
      }
      phaseEntryAuditCache.set(designCacheKey, designReadinessNotice)
    }
  }

  const enrichedUserMessageDesign = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsDesign, priorContext: priorContextDesign }) + brandDriftNotice + qualityNotice + specTextNotice + upstreamNoticeDesign + designReadinessNotice
  const systemPrompt = buildDesignSystemPrompt(context, featureName, readOnly)

  await update("_UX Designer is thinking..._")

  const designFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designBranchName = `spec/${featureName}-design`
  const prefix = routingNote ? `${routingNote}\n\n` : ""
  const toolCallsOutDesign: ToolCallRecord[] = []

  // Extract the approved product spec from context for use in the audit.
  const productSpecMatch = context.currentDraft.match(/## Approved Product Spec\n([\s\S]*?)(?:\n\n## |$)/)
  const auditProductSpec = productSpecMatch ? productSpecMatch[1].trim() : ""

  // Shared save logic: audit + save + preview + checkpoint.
  // Used by both save_design_spec_draft and apply_design_spec_patch tools.
  const saveDesignDraft = async (content: string): Promise<{ result?: unknown; error?: string }> => {
    await update("_Auditing draft against product vision and architecture..._")
    const audit = await auditSpecDraft({
      draft: content,
      productVision: context.productVision,
      systemArchitecture: context.systemArchitecture,
      productSpec: auditProductSpec,
      featureName,
    })
    if (audit.status === "conflict") {
      return { error: `Conflict detected — draft not saved: ${audit.message}` }
    }
    await update("_Saving draft to GitHub..._")
    await saveDraftDesignSpec({ featureName, filePath: designFilePath, content })

    // Generate HTML preview — non-fatal. Always do a full regeneration from the complete merged spec.
    // updateDesignPreview (surgical patch-based update) was removed because it caused two failure modes:
    // 1. It failed to apply the patch text — Sonnet missed or paraphrased the changed content.
    // 2. It regressed elements outside the patch scope — elements not in the spec (like Auth Sheet
    //    animation direction) were modified when an unrelated patch was processed.
    // Full regeneration is deterministic and always produces correct content from the committed spec.
    await update("_Generating HTML preview..._")
    const { paths: dp, githubOwner: dOwner, githubRepo: dRepo } = loadWorkspaceConfig()
    const designSpecUrl = `https://github.com/${dOwner}/${dRepo}/blob/${designBranchName}/${designFilePath}`
    const htmlFilePath = `${dp.featuresRoot}/${featureName}/${featureName}.preview.html`
    let previewUrl = "none"
    let renderWarnings: string[] = []
    const previewResult = await generateDesignPreview({
      specContent: content,
      featureName,
      brandContent: context.brand,
    }).catch((e: Error) => e)
    if (!(previewResult instanceof Error)) {
      renderWarnings = previewResult.warnings
      await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: previewResult.html }).catch(() => {})
      try {
        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          content: previewResult.html,
          filename: `${featureName}.preview.html`,
          title: `${featureName} — Design Preview`,
        })
        previewUrl = "uploaded_to_slack"
      } catch (uploadErr: any) {
        console.error(`[preview] Slack upload failed: ${uploadErr?.message}`)
        previewUrl = "saved_to_github"
      }
    } else {
      console.error(`[preview] HTML generation failed: ${previewResult.message}`)
    }

    const brandDrifts = context.brand ? auditBrandTokens(content, context.brand) : []
    const specGap = audit.status === "gap" ? audit.message : null
    const renderAmbiguities = await auditSpecRenderAmbiguity(content, { formFactors: targetFormFactors }).catch(() => [])
    return { result: { specUrl: designSpecUrl, previewUrl, brandDrifts, specGap, renderWarnings: renderWarnings.length > 0 ? renderWarnings : undefined, renderAmbiguities: renderAmbiguities.length > 0 ? renderAmbiguities : undefined } }
  }

  // Design agent has a much larger context (system prompt + product vision + full draft spec)
  // than the PM agent. Cap at 20 messages (10 exchanges) so the combined payload stays well
  // under the token limit. Prior conversation context beyond the limit is summarized and
  // injected into the user message — no work is lost on long threads.
  // designSaveTools is declared here so both the runAgent try-catch and the post-response
  // audit below can reference the same constant without duplication.
  const designSaveTools = ["save_design_spec_draft", "apply_design_spec_patch", "finalize_design_spec"]

  let response: string
  try {
    response = await runAgent({
    systemPrompt,
    history: historyDesign,
    userMessage: enrichedUserMessageDesign,
    userImages,
    historyLimit: DESIGN_HISTORY_LIMIT,
    tools: readOnly ? undefined : DESIGN_TOOLS,
    toolHandler: readOnly ? undefined : async (name, input) => {
      if (name === "save_design_spec_draft") {
        return saveDesignDraft(input.content as string)
      }
      if (name === "apply_design_spec_patch") {
        const patch = input.patch as string
        const existingDraft = await readFile(designFilePath, designBranchName)
        const mergedDraft = applySpecPatch(existingDraft ?? "", patch)
        return saveDesignDraft(mergedDraft)
      }
      if (name === "generate_design_preview") {
        // Serve the HTML that was saved when the spec was last committed.
        // The renderer is non-deterministic — regenerating from the same spec produces
        // different HTML each time (different inspector states, animation values, headings).
        // Only fall through to generation if no saved HTML exists yet (first preview).
        const { paths: gp } = loadWorkspaceConfig()
        const htmlFilePath = `${gp.featuresRoot}/${featureName}/${featureName}.preview.html`
        try {
          await update("_Fetching preview..._")
          const cachedHtml = await readFile(htmlFilePath, designBranchName)
          if (cachedHtml) {
            await client.files.uploadV2({
              channel_id: channelId,
              thread_ts: threadTs,
              content: cachedHtml,
              filename: `${featureName}.preview.html`,
              title: `${featureName} — Design Preview`,
            })
            return { result: { previewUrl: "uploaded_to_slack" } }
          }
          // No cache exists — generate from committed spec and save for future requests.
          // Use context.currentDraft (loaded from GitHub at turn start) — authoritative even
          // after thread summarization clears the agent's in-memory spec content.
          await update("_Generating preview..._")
          const previewResult = await generateDesignPreview({ specContent: context.currentDraft ?? "", featureName, brandContent: context.brand })
          await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: previewResult.html }).catch(() => {})
          await client.files.uploadV2({
            channel_id: channelId,
            thread_ts: threadTs,
            content: previewResult.html,
            filename: `${featureName}.preview.html`,
            title: `${featureName} — Design Preview`,
          })
          return { result: { previewUrl: "uploaded_to_slack", renderWarnings: previewResult.warnings.length > 0 ? previewResult.warnings : undefined } }
        } catch (err: any) {
          return { error: `Preview failed: ${err?.message}` }
        }
      }
      if (name === "offer_pm_escalation") {
        setPendingEscalation(featureName, {
          targetAgent: "pm",
          question: input.question as string,
          designContext: context.currentDraft ?? "",
        })
        return {
          result: "Escalation offer stored. The user will be prompted to confirm. If they say yes, the PM will be notified with your question.",
        }
      }
      if (name === "offer_architect_escalation") {
        setPendingEscalation(featureName, {
          targetAgent: "architect",
          question: input.question as string,
          designContext: context.currentDraft ?? "",
        })
        return {
          result: "Escalation offer stored. The user will be prompted to confirm. If they say yes, the Architect will be notified with your question.",
        }
      }
      if (name === "fetch_url") {
        const url = input.url as string
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
          if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` }
          const text = await res.text()
          const content = await filterDesignContent(text)
          return { result: { content } }
        } catch (err: any) {
          return { error: `Fetch failed: ${err?.message}` }
        }
      }
      if (name === "run_phase_completion_audit") {
        await update("_Running phase completion audit..._")
        const draft = await readFile(designFilePath, designBranchName)
        if (!draft) {
          return { result: { ready: false, findings: [{ issue: "No design spec draft found", recommendation: "Save a draft first using save_design_spec_draft before running the audit." }] } }
        }
        const result = await auditPhaseCompletion({
          specContent: draft,
          rubric: buildDesignRubric(targetFormFactors),
          featureName,
        })
        return { result }
      }
      if (name === "finalize_design_spec") {
        const existingDraft = await readFile(designFilePath, designBranchName)
        if (!existingDraft) {
          return { error: "No draft saved yet — save a draft first before finalizing." }
        }
        const blockingQuestions = extractBlockingQuestions(existingDraft)
        if (blockingQuestions.length > 0) {
          return { error: `Approval blocked — ${blockingQuestions.length} blocking question${blockingQuestions.length > 1 ? "s" : ""} must be resolved first:\n${blockingQuestions.map(q => `• ${q}`).join("\n")}` }
        }
        let finalContent = existingDraft
        const decisionAudit = await auditSpecDecisions({ specContent: existingDraft, history: getHistory(featureName) })
        if (decisionAudit.status === "corrections") {
          const { corrected } = applyDecisionCorrections(existingDraft, decisionAudit.corrections)
          finalContent = corrected
        }
        // Brand token drift hard gate — spec cannot be approved with drift vs BRAND.md
        if (context.brand) {
          const finalBrandDrifts = auditBrandTokens(finalContent, context.brand)
          const finalAnimDrifts = auditAnimationTokens(finalContent, context.brand)
          const totalDrifts = finalBrandDrifts.length + finalAnimDrifts.length
          if (totalDrifts > 0) {
            const driftLines = [
              ...finalBrandDrifts.map(d => `• ${d.token}: spec has ${d.specValue} but BRAND.md requires ${d.brandValue}`),
              ...finalAnimDrifts.map(d => `• ${d.param}: spec has ${d.specValue} but BRAND.md requires ${d.brandValue}`),
            ].join("\n")
            return { error: `Finalization blocked — ${totalDrifts} brand token drift${totalDrifts === 1 ? "" : "s"} detected. Patch the spec to align with BRAND.md before finalizing:\n${driftLines}` }
          }
        }
        await update("_Saving final design spec..._")
        await saveApprovedDesignSpec({ featureName, filePath: designFilePath, content: finalContent })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${designFilePath}`
        return { result: { url, nextPhase: "engineering" } }
      }
      return { error: `Unknown tool: ${name}` }
    },
    toolCallsOut: toolCallsOutDesign,
  })
  } catch (err: unknown) {
    // If a save tool already ran successfully, the spec is on GitHub — the error happened
    // in the final end-turn Anthropic call (generating the summary text), not in the save.
    // Surface a clear success + partial-failure message so the user knows what was committed.
    // Re-throw for all other errors (pre-save failures) so withThinking handles them.
    const savedSuccessfully = toolCallsOutDesign.some(t => designSaveTools.includes(t.name))
    if (savedSuccessfully) {
      const savedTool = toolCallsOutDesign.find(t => designSaveTools.includes(t.name))!
      const action = savedTool.name === "finalize_design_spec" ? "approved and merged" : "saved to GitHub"
      const saveMsg = `✓ *Spec ${action}.* Your changes are committed.\n\nI hit an error generating the summary response — the spec itself is safe. Ask a follow-up question to continue.`
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: saveMsg })
      await update(saveMsg)
      return
    }
    throw err
  }

  appendMessage(featureName, { role: "user", content: userMessage })

  // Post-response tool-call audit: did this turn introduce decisions that weren't saved?
  // Always run — the history-length guard was needed when we passed full history to the
  // classifier, but now we only pass the 2-message current turn so it is always valid.
  // Removing the guard ensures the audit fires even on short-history threads (e.g. after
  // Slack thread summarization resets in-memory history), catching hallucinated saves.
  const didSave = toolCallsOutDesign.some(t => designSaveTools.includes(t.name))
  let uncommittedNote = ""
  // Skip the audit when the agent is still seeking confirmation — the user hasn't agreed yet,
  // so decisions are genuinely uncommitted by design. Firing the warning here is a false positive.
  const agentStillSeeking = /lock this in\?|confirm\?|shall i (save|apply|commit|update)\?|save this\?|ready to (commit|save|lock)\?/i.test(response)
  if (!didSave && !agentStillSeeking) {
    const currentTurn: Message[] = [
      { role: "user", content: userMessage },
      { role: "assistant", content: response },
    ]
    // No cacheKey — threadTs is shared across all replies in a Slack thread, so caching
    // per-thread returns the first turn's stale result for all subsequent turns.
    // Post-turn only evaluates 2 messages so the Haiku call is fast; no caching needed.
    const uncommitted = await identifyUncommittedDecisions(currentTurn, context.currentDraft ?? "").catch(() => "")
    const isAllCommitted = !uncommitted || uncommitted.trim().toLowerCase() === "none"
    if (uncommitted && !isAllCommitted) {
      uncommittedNote = `\n\n⚠️ *Heads up:* decisions were discussed this turn but not saved to the spec. Say *save those* to commit them.`
    }
  }

  appendMessage(featureName, { role: "assistant", content: response })
  await update(`${prefix}${response}${uncommittedNote}`)
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
  const pendingEngineeringApproval = getPendingApproval(featureName)
  if (pendingEngineeringApproval && pendingEngineeringApproval.specType === "engineering") {
    if (isAffirmative(userMessage)) {
      clearPendingApproval(featureName)
      await update("_Saving the final engineering spec..._")
      await saveApprovedEngineeringSpec({ featureName, filePath: pendingEngineeringApproval.filePath, content: pendingEngineeringApproval.specContent })
      const approvalMessage =
        `The *${featureName}* engineering spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `The engineer agents will use this spec to implement the feature — data model, APIs, and UI components.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(featureName)
      // Not confirming — fall through to normal agent flow
    }
  }

  if (!readOnly) {
    const isCheckInArch = CHECK_IN_RE.test(userMessage.trim())

    const offTopic = isCheckInArch ? false : await isOffTopicForAgent(userMessage, "engineering")
    if (offTopic) {
      const mainChannel = loadWorkspaceConfig().mainChannel
      const msg = `For status and progress updates, ask in *#${mainChannel}* — the concierge has the full picture across all features.\n\nI'm the Architect — I'm here when you're ready to work on data models, APIs, or engineering decisions for this feature.`
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: msg })
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
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: msg })
      await update(msg)
      return
    }
  }

  await update("_Architect is reading the spec chain..._")
  const historyArch = getHistory(featureName)
  const ARCH_HISTORY_LIMIT = 40
  const [context, lockedDecisionsArch, priorContextArch] = await Promise.all([
    loadArchitectAgentContext(featureName),
    extractLockedDecisions(historyArch).catch(() => ""),
    getPriorContext(featureName, historyArch, ARCH_HISTORY_LIMIT),
  ])
  // Phase entry upstream spec audit — PM + Design spec health check on every architect agent message.
  // Audits both upstream specs in parallel using content-addressed cache.
  // Cache invalidates automatically when either upstream spec is manually edited mid-phase.
  let upstreamNoticeArch = ""
  const pmSpecPathArch = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
  const designSpecPathArch = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const [pmSpecContentArch, designSpecContentArch] = await Promise.all([
    readFile(pmSpecPathArch, "main").catch(() => null),
    readFile(designSpecPathArch, "main").catch(() => null),
  ])
  const archCacheKey = `arch:${featureName}:${specFingerprint(pmSpecContentArch ?? "")}:${specFingerprint(designSpecContentArch ?? "")}`
  if (phaseEntryAuditCache.has(archCacheKey)) {
    upstreamNoticeArch = phaseEntryAuditCache.get(archCacheKey)!
  } else {
    const [pmAuditArch, designAuditArch] = await Promise.all([
      pmSpecContentArch
        ? auditPhaseCompletion({ specContent: pmSpecContentArch, rubric: PM_RUBRIC, featureName, productVision: context.productVision, systemArchitecture: context.systemArchitecture }).catch(() => null)
        : null,
      designSpecContentArch
        ? auditPhaseCompletion({ specContent: designSpecContentArch, rubric: buildDesignRubric(targetFormFactors), featureName }).catch(() => null)
        : null,
    ])
    const archFindings: string[] = []
    if (pmAuditArch && !pmAuditArch.ready) {
      const lines = pmAuditArch.findings.map((f, i) => `${i + 1}. [PM] ${f.issue} — ${f.recommendation}`).join("\n")
      archFindings.push(`APPROVED PM SPEC — ${pmAuditArch.findings.length} GAP${pmAuditArch.findings.length === 1 ? "" : "S"}:\n${lines}`)
    }
    if (designAuditArch && !designAuditArch.ready) {
      const lines = designAuditArch.findings.map((f, i) => `${i + 1}. [Design] ${f.issue} — ${f.recommendation}`).join("\n")
      archFindings.push(`APPROVED DESIGN SPEC — ${designAuditArch.findings.length} GAP${designAuditArch.findings.length === 1 ? "" : "S"}:\n${lines}`)
    }
    if (archFindings.length > 0) {
      upstreamNoticeArch = `\n\n[PLATFORM UPSTREAM SPEC AUDIT — UPSTREAM SPECS HAVE GAPS THAT MUST BE SURFACED TO THE USER BEFORE PROCEEDING:\n${archFindings.join("\n\n")}\nYou MUST surface these gaps prominently in your response and recommend returning to the relevant agent to address them before the engineering phase continues.]`
    } else {
      upstreamNoticeArch = ""
    }
    phaseEntryAuditCache.set(archCacheKey, upstreamNoticeArch)
  }

  // Always-on engineering spec completeness audit — runs on every architect agent message.
  // Content-addressed cache on spec fingerprint: any edit to the draft invalidates automatically.
  // Principle 7: this check runs always, not when the user asks a readiness-adjacent phrase.
  let archReadinessNotice = ""
  const engSpecDraftPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.engineering.md`
  const engDraftContent = await readFile(engSpecDraftPath, `spec/${featureName}-engineering`).catch(() => null)
  if (engDraftContent) {
    const efp = specFingerprint(engDraftContent)
    const archPhaseCacheKey = `arch-phase:${featureName}:${efp}`
    if (phaseEntryAuditCache.has(archPhaseCacheKey)) {
      archReadinessNotice = phaseEntryAuditCache.get(archPhaseCacheKey)!
    } else {
      const archAuditResult = await auditPhaseCompletion({
        specContent: engDraftContent,
        rubric: ENGINEER_RUBRIC,
        featureName,
      }).catch(() => null)
      if (archAuditResult && !archAuditResult.ready) {
        const findingLines = archAuditResult.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        archReadinessNotice = `\n\n[PLATFORM ENGINEERING READINESS — ${archAuditResult.findings.length} gap${archAuditResult.findings.length === 1 ? "" : "s"} blocking implementation handoff. You MUST surface each finding with your concrete recommendation before proceeding.\n${findingLines}]`
      } else if (archAuditResult?.ready) {
        archReadinessNotice = `\n\n[PLATFORM ENGINEERING READINESS — Spec passed all engineering rubric criteria. You may confirm the spec is implementation-ready when asked.]`
      }
      phaseEntryAuditCache.set(archPhaseCacheKey, archReadinessNotice)
    }
  }

  const enrichedUserMessageArch = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsArch, priorContext: priorContextArch }) + upstreamNoticeArch + archReadinessNotice
  const systemPrompt = buildArchitectSystemPrompt(context, featureName, readOnly)

  await update("_Architect is thinking..._")

  const archFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.engineering.md`
  const archBranchName = `spec/${featureName}-engineering`
  const prefix = routingNote ? `${routingNote}\n\n` : ""
  const toolCallsOutArch: ToolCallRecord[] = []

  const response = await runAgent({
    systemPrompt,
    history: historyArch,
    userMessage: enrichedUserMessageArch,
    userImages,
    historyLimit: ARCH_HISTORY_LIMIT,
    tools: readOnly ? undefined : ARCHITECT_TOOLS,
    toolHandler: readOnly ? undefined : async (name, input) => {
      if (name === "save_engineering_spec_draft") {
        const content = input.content as string
        await update("_Auditing spec against product vision and architecture..._")
        const audit = await auditSpecDraft({
          draft: content,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          featureName,
        })
        if (audit.status === "conflict") {
          return { error: `Conflict detected — spec not saved: ${audit.message}` }
        }
        await update("_Saving draft to GitHub..._")
        await saveDraftEngineeringSpec({ featureName, filePath: archFilePath, content })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${archBranchName}/${archFilePath}`
        const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
        return { result: { url, audit: auditOut } }
      }
      if (name === "apply_engineering_spec_patch") {
        const patch = input.patch as string
        const existingDraft = await readFile(archFilePath, archBranchName)
        const mergedDraft = applySpecPatch(existingDraft ?? "", patch)
        await update("_Auditing patch against product vision and architecture..._")
        const audit = await auditSpecDraft({
          draft: mergedDraft,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          featureName,
        })
        if (audit.status === "conflict") {
          return { error: `Conflict detected — patch not saved: ${audit.message}` }
        }
        await update("_Saving updated draft to GitHub..._")
        await saveDraftEngineeringSpec({ featureName, filePath: archFilePath, content: mergedDraft })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${archBranchName}/${archFilePath}`
        const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
        return { result: { url, audit: auditOut } }
      }
      if (name === "read_approved_specs") {
        const featureNames = input.featureNames as string[] | undefined
        if (!featureNames || featureNames.length === 0) {
          return { result: { specs: {}, note: "Approved specs are already loaded in your system prompt context." } }
        }
        const { paths } = loadWorkspaceConfig()
        const specs: Record<string, string> = {}
        await Promise.all(featureNames.map(async (fn) => {
          const path = `${paths.featuresRoot}/${fn}/${fn}.engineering.md`
          const content = await readFile(path, "main").catch(() => null)
          if (content) specs[fn] = content
        }))
        return { result: { specs } }
      }
      if (name === "finalize_engineering_spec") {
        const existingDraft = await readFile(archFilePath, archBranchName)
        if (!existingDraft) {
          return { error: "No draft saved yet — save a draft first before finalizing." }
        }
        const blockingQuestions = extractBlockingQuestions(existingDraft)
        if (blockingQuestions.length > 0) {
          return { error: `Approval blocked — ${blockingQuestions.length} blocking question${blockingQuestions.length > 1 ? "s" : ""} must be resolved first:\n${blockingQuestions.map(q => `• ${q}`).join("\n")}` }
        }
        let finalContent = existingDraft
        const decisionAudit = await auditSpecDecisions({ specContent: existingDraft, history: getHistory(featureName) })
        if (decisionAudit.status === "corrections") {
          const { corrected } = applyDecisionCorrections(existingDraft, decisionAudit.corrections)
          finalContent = corrected
        }
        await update("_Saving final engineering spec..._")
        await saveApprovedEngineeringSpec({ featureName, filePath: archFilePath, content: finalContent })
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${archFilePath}`
        return { result: { url, nextPhase: "build" } }
      }
      return { error: `Unknown tool: ${name}` }
    },
    toolCallsOut: toolCallsOutArch,
  })

  appendMessage(featureName, { role: "user", content: userMessage })
  appendMessage(featureName, { role: "assistant", content: response })
  await update(`${prefix}${response}`)
}
