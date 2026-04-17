import { loadAgentContext, loadDesignAgentContext, loadArchitectAgentContext } from "../../../runtime/context-loader"
import { runAgent, UserImage, ToolCallRecord } from "../../../runtime/claude-client"
import { getHistory, getLegacyMessages, appendMessage, getConfirmedAgent, setConfirmedAgent, getPendingEscalation, setPendingEscalation, clearPendingEscalation, getPendingApproval, setPendingApproval, clearPendingApproval, getEscalationNotification, setEscalationNotification, clearEscalationNotification, Message } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, buildPmSystemBlocks, PM_TOOLS } from "../../../agents/pm"
import { buildDesignSystemPrompt, buildDesignSystemBlocks, buildDesignStateResponse, DESIGN_TOOLS } from "../../../agents/design"
import { buildArchitectSystemPrompt, buildArchitectSystemBlocks, ARCHITECT_TOOLS } from "../../../agents/architect"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, saveDraftDesignSpec, saveApprovedDesignSpec, saveDraftEngineeringSpec, saveApprovedEngineeringSpec, saveDraftHtmlPreview, saveDraftAuditCache, readDraftAuditCache, getInProgressFeatures, readFile, preseedEngineeringSpec, seedHandoffSection, clearHandoffSection } from "../../../runtime/github-client"
import { classifyIntent, classifyMessageScope, detectPhase, isOffTopicForAgent, isSpecStateQuery, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { auditSpecDraft, auditSpecDecisions, applyDecisionCorrections, extractLockedDecisions, auditSpecRenderAmbiguity, filterDesignContent, auditRedundantBranding, auditCopyCompleteness } from "../../../runtime/spec-auditor"
import { auditPhaseCompletion, auditDownstreamReadiness, PM_RUBRIC, PM_DESIGN_READINESS_RUBRIC, buildDesignRubric, ENGINEER_RUBRIC } from "../../../runtime/phase-completion-auditor"
import { auditBrandTokens, auditAnimationTokens, auditMissingBrandTokens } from "../../../runtime/brand-auditor"
import { getPriorContext, buildEnrichedMessage, identifyUncommittedDecisions, generateSaveCheckpoint } from "../../../runtime/conversation-summarizer"
import { generateDesignPreview } from "../../../runtime/html-renderer"
import { extractBlockingQuestions, extractAllOpenQuestions, extractDesignAssumptions, extractHandoffSection, extractSpecTextLiterals } from "../../../runtime/spec-utils"
import { applySpecPatch } from "../../../runtime/spec-patcher"
import { classifyForPmGaps } from "../../../runtime/pm-gap-classifier"
import { classifyForArchGap } from "../../../runtime/arch-gap-classifier"
import { classifyFixIntent } from "../../../runtime/fix-intent-classifier"
import { patchProductSpecWithRecommendations } from "../../../runtime/pm-escalation-spec-writer"
import { patchEngineeringSpecWithDecision } from "../../../runtime/engineering-spec-decision-writer"
import { sanitizePmSpecDraft } from "../../../runtime/pm-spec-sanitizer"

const { paths: workspacePaths, targetFormFactors } = loadWorkspaceConfig()

// Per-feature flag: tracks which features have already received the context-summarization notice.
// Prevents spamming the user on every message after the history limit is reached.
const summarizationWarnedFeatures = new Set<string>()

// Per-feature in-flight lock — prevents concurrent agent runs for the same feature.
// When a Slack event arrives while an agent run is still processing (PM agents take 10s+),
// the second invocation is rejected immediately rather than running a second agent in parallel.
const featureInFlight = new Map<string, boolean>()

// Content-addressed cache for phase entry upstream spec audits.
// Key: `${agentType}:${featureName}:${specFingerprint}` — invalidates automatically when upstream spec content changes.
// Value: formatted PLATFORM NOTICE string (empty string = no issues found).
// In-memory only: intentionally lost on restart so first message after deployment always re-audits.
const phaseEntryAuditCache = new Map<string, string>()

// Parallel cache storing raw findings arrays for design readiness — used to build the structured
// action menu on cache hits without re-parsing the notice string.
const designReadinessFindingsCache = new Map<string, Array<{ issue: string; recommendation: string }>>()

// Cache for LLM render ambiguity results from auditSpecRenderAmbiguity.
// Populated by state queries; consumed by subsequent regular-path messages without extra LLM calls.
// Key: `render-ambiguity:${featureName}:${specFingerprint}` — invalidates automatically on spec edits.
const renderAmbiguitiesCache = new Map<string, string[]>()

// Lightweight content fingerprint — fast, no crypto dependency.
// Detects any edit to spec content including manual edits mid-phase.
function specFingerprint(content: string): string {
  return `${content.length}:${content.slice(0, 100)}:${content.slice(-50)}`
}

// Exported for test isolation only — clears module-level audit caches between test runs.
// Never call in production code.
export function clearPhaseAuditCaches(): void {
  phaseEntryAuditCache.clear()
  designReadinessFindingsCache.clear()
  renderAmbiguitiesCache.clear()
}


// Detects when the design agent correctly identified PM gaps in prose but did not call
// offer_pm_escalation. Signals: response contains PM-escalation language — either an explicit
// "say yes" CTA ("bring the PM", "PM into this thread", "cannot move forward") OR an offer to
// escalate ("want me to escalate", "escalate to PM", "call the PM agent"). Returns the numbered
// questions extracted from the response (for pendingEscalation.question), or null if no
// escalation intent detected. Structural check on the agent's own output — not LLM judgment.
function extractPmEscalationFromAgentResponse(response: string): string | null {
  // Explicit CTA path: "say yes" + PM context ("bring the PM", "cannot move forward", etc.)
  const hasSayYes = /\bsay\s+\*?yes\*?\b/i.test(response)
  const hasPmCta = /\bbring the PM\b|\bPM into this thread\b|\bcannot move forward\b|\bPM spec\b|\bproduct spec gap\b/i.test(response)
  // Offer path: agent is ASKING if it should escalate ("want me to escalate to PM", "call the PM")
  const hasPmEscalationOffer = /\bescalat\w+\s+to\s+(the\s+)?PM\b|\bwant\s+me\s+to\s+escalat|\bcall\s+the\s+PM\b|\bbring\s+(in|the)\s+(the\s+)?PM\b/i.test(response)
  if (!hasSayYes && !hasPmCta && !hasPmEscalationOffer) return null
  const lines = response.match(/^\d+\.\s+\S.+/gm)
  if (!lines || lines.length === 0) return null
  return lines.join("\n")
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

// Builds a deterministic, platform-enforced structured action menu from pre-computed audit data.
// Exported for unit testing.
// Appended AFTER the agent's prose response — not a system prompt instruction (probabilistic),
// but structural output the platform constructs regardless of what the agent said.
// Format is stable: numbered issues across categories, single CTA so user can say "fix 1 3 5".
export type ActionItem = { issue: string; fix: string }

// Splits a quality issue string on the first " — " separator.
// Quality auditor strings use this delimiter: "<concise issue> — <recommendation>".
// Exported for unit testing.
export function splitQualityIssue(s: string): ActionItem {
  const sep = s.indexOf(" — ")
  return sep === -1
    ? { issue: s, fix: "fix before approval" }
    : { issue: s.slice(0, sep), fix: s.slice(sep + 3) }
}

// Builds a deterministic, platform-enforced structured action menu from pre-computed audit data.
// Exported for unit testing.
// Each item renders as: "N. [issue] — *Fix:* [fix]" so the user can say "fix 1 3 5".
export function buildActionMenu(categories: Array<{ emoji: string; label: string; issues: ActionItem[] }>): string {
  const filled = categories.filter(c => c.issues.length > 0)
  if (filled.length === 0) return ""
  let n = 0
  const lines: string[] = ["---", "*── OPEN ITEMS ──*"]
  for (const cat of filled) {
    lines.push(`\n*${cat.emoji} ${cat.label} (${cat.issues.length}):*`)
    for (const item of cat.issues) {
      lines.push(`${++n}. ${item.issue} — *Recommended fix:* ${item.fix}`)
    }
  }
  lines.push(`\nSay *fix 1 2 3* (or *fix all*) to apply.`)
  return "\n\n" + lines.join("\n")
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
  return /^(yes|yeah|yep|sure|go ahead|pull them in|pull (the )?pm in|do it|ok|okay|please|yes please|bring them in|bring (the )?pm in|confirmed|confirm|approved|approve|lock it in|let's go|lets go|agree)/.test(lower)
}

// Stricter form used in escalation notification reply: the message must be a standalone
// confirmation — not a mixed message like "approved for #4, can you recommend for 1-3?"
// If the message also contains a follow-up request to the agent, it routes back to the
// escalated agent (PM/architect/designer) rather than resuming the originating agent.
function isStandaloneConfirmation(message: string): boolean {
  if (!isAffirmative(message)) return false
  const lower = message.toLowerCase()
  // Contains a question or an explicit request for more from the agent → treat as continuation
  if (/\?|can you|ask (it|them|the pm|the designer|the architect)|recommend for|please (give|provide|add|recommend)|what about|and (ask|recommend|suggest)/.test(lower)) return false
  return true
}

// Detects "fix all" / "fix 1 2 3" / "fix 1, 2, 3" intent from platform-prescribed structured input.
// No Haiku — this is machine-prescribed format, not human free-text. Keywords are valid here.
// Returns isFixAll=true when the platform should run the fix-all loop, with optional selectedIndices
// (null = fix everything, array = fix specific 1-based item numbers from the action menu).
export function parseFixAllIntent(message: string): { isFixAll: boolean; selectedIndices: number[] | null } {
  const trimmed = message.toLowerCase().trim()
  if (/^fix\s+all\b/.test(trimmed)) return { isFixAll: true, selectedIndices: null }
  const indexMatch = trimmed.match(/^fix\s+([\d\s,]+)$/)
  if (indexMatch) {
    const indices = indexMatch[1].split(/[\s,]+/).map(Number).filter(n => n > 0)
    if (indices.length > 0) return { isFixAll: true, selectedIndices: indices }
  }
  return { isFixAll: false, selectedIndices: null }
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
  userId?: string
}): Promise<void> {
  const { channelName, threadTs, userMessage, userImages, channelId, client, channelState, userId } = params
  const featureName = getFeatureName(channelName)

  // In-flight lock: reject concurrent messages for the same feature.
  // PM agent runs take 10s+; without this, a Slack retry or rapid follow-up triggers a second
  // agent run while the first is still active, causing both PM and Design to respond in parallel.
  if (featureInFlight.get(featureName)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_Still working on your last message — I'll be with you shortly._",
    })
    return
  }
  featureInFlight.set(featureName, true)

  try {

  let confirmedAgent = getConfirmedAgent(featureName)

  // Recovery: server restart clears in-memory confirmedAgent but pendingEscalation survives
  // in .conversation-state.json. If the user is affirming and a pending escalation exists,
  // restore confirmedAgent from the escalation's origin so the escalation-confirmation branch
  // runs correctly without requiring a new message from the user.
  if (!confirmedAgent && isAffirmative(userMessage) && getPendingEscalation(featureName)) {
    const recovered = getPendingEscalation(featureName)!
    // Infer originating agent from the escalation target:
    // design→PM or design→architect: targetAgent is "pm" or "architect"
    // architect→design: targetAgent is "design"
    const recoveredAgent: string = recovered.targetAgent === "design" ? "architect" : "ux-design"
    confirmedAgent = recoveredAgent
    setConfirmedAgent(featureName, recoveredAgent)
    console.log(`[ROUTER] escalation-state-recovered: restored confirmedAgent=${recoveredAgent} from persisted pendingEscalation targetAgent=${recovered.targetAgent} for feature=${featureName}`)
  }

  console.log(`[ROUTER] handleFeatureChannelMessage: feature=${featureName} confirmedAgent=${confirmedAgent ?? "(none)"} msg="${userMessage.slice(0, 100)}"`)

  // Confirmed agent — check phase first, then run
  if (confirmedAgent === "ux-design") {
    // If the design agent offered a PM escalation last turn and the user is confirming it,
    // run the PM agent with the blocking question as its opening brief.
    const pendingEscalation = getPendingEscalation(featureName)
    if (pendingEscalation && isAffirmative(userMessage)) {
      console.log(`[ROUTER] branch=pending-escalation-confirmed targetAgent=${pendingEscalation.targetAgent} question="${pendingEscalation.question.slice(0, 100)}"`)

      // Do NOT clear yet — clear only after @mention is successfully posted.
      // Clearing early means a network failure or agent refusal permanently loses the escalation,
      // forcing the design agent to rediscover the gaps (possibly finding fewer or wrong ones).
      const { roles } = loadWorkspaceConfig()
      const isArchitectEscalation = pendingEscalation.targetAgent === "architect"
      const mention = isArchitectEscalation
        ? (roles.architectUser ? `<@${roles.architectUser}>` : `*Architect*`)
        : (roles.pmUser ? `<@${roles.pmUser}>` : `*Product Manager*`)
      const agentLabel = isArchitectEscalation ? "Architect" : "Product Manager"

      // Design agent's specific questions are the ONLY brief.
      // The pre-escalation audit was removed because it inflated every PM round from 2-3 specific
      // questions to 13-15 audit-discovered gaps. PM + Haiku handling 15 items at once introduced
      // new imprecision (e.g. "within one frame (~16ms)") at higher rate than natural convergence.
      // Natural convergence: designer asks 2 gaps → PM answers 2 → designer asks 2 more → 3-4 rounds.
      // Audit approach: 15 items → Haiku errors → 2 new gaps → repeat. Slower and less accurate.
      // The audit belongs at finalize_product_spec (already there), not at each escalation round.
      const comprehensiveQuestion = pendingEscalation.question

      // Run the PM/Architect agent with the blocking questions as a brief so it produces
      // concrete decisions before the human is notified — not a raw question dump.
      // Brief is forceful and decision-framed: the agent must make calls, not present options.
      const productSpecSection = pendingEscalation.productSpec
        ? `\n\nAPPROVED PRODUCT SPEC (for context):\n${pendingEscalation.productSpec}`
        : ""
      const pmBrief = `DESIGN TEAM ESCALATION — PM RECOMMENDATIONS NEEDED TO UNBLOCK DESIGN.

The UX Designer is blocked on the numbered items below. Your job: give a specific, concrete recommendation for each one so design can proceed today. These are your expert recommendations — not final decisions — the human PM will review and confirm or adjust each one.

For each numbered item, respond with the same number so the human can follow along. Output exactly:
[N]. My recommendation: [one specific, concrete answer — no conditionals, no "it depends", no "the PM should decide"]
→ Rationale: [one sentence grounded in product vision, user needs, or standard practice]
→ Note: Pending your approval — say yes to apply to the product spec

Do not ask for more context. Do not present multiple options. Do not explain why you cannot decide. Pick the best answer and state it. End with exactly this sentence on its own line: "Say *yes* to apply these to the product spec and continue design, or reply to adjust any recommendation."${productSpecSection}

BLOCKING ITEMS:
${comprehensiveQuestion}`

      const archBrief = `DESIGN TEAM ESCALATION — ARCHITECT RECOMMENDATIONS NEEDED TO UNBLOCK DESIGN.

The UX Designer is blocked on the numbered items below. Your job: give a specific, concrete recommendation for each one so design can proceed today. These are your expert recommendations — the engineering team will refine at the spec phase.

For each numbered item, respond with the same number so the human can follow along. Output exactly:
[N]. My recommendation: [one specific, concrete technical answer — no conditionals, no "it depends"]
→ Rationale: [one sentence grounded in the system architecture or standard practice]
→ Note: Pending architect confirmation at engineering spec phase

Do not ask for more context. Do not present multiple options. Pick the best answer and state it. End after the last recommendation — do not add a closing sentence, sign-off, or instructions about what to do next. The platform handles that.

BLOCKING ITEMS:
${pendingEscalation.question}`

      const brief = isArchitectEscalation ? archBrief : pmBrief

      // Structural recommendation gate (Principle 8):
      // After the agent runs, verify it produced a "My recommendation:" line for every item in the brief.
      // This catches ALL forms of non-compliance — refusal, clarification-stall, partial answer, tangent —
      // without pattern-matching the model's text for specific bad phrases (which is always incomplete).
      // Gate: count(required items in brief) vs count("My recommendation:" in response).
      // If response count < required count → enforcement re-run with the output format injected.
      function countBriefItems(question: string): number {
        const numbered = question.match(/^\d+\./gm)
        return numbered ? numbered.length : 1
      }
      function countRecommendations(response: string): number {
        return (response.match(/my recommendation:/gi) ?? []).length
      }

      let capturedAgentResponse = ""
      await withThinking({ client, channelId, threadTs, agent: agentLabel, run: async (update) => {
        const capturingUpdate = async (text: string) => { capturedAgentResponse = text; await update(text) }
        if (isArchitectEscalation) {
          await runArchitectAgent({ channelName, channelId, threadTs, featureName, userMessage: brief, client, update: capturingUpdate })
        } else {
          await runPmAgent({ channelName, channelId, threadTs, userMessage: brief, client, update: capturingUpdate })
          // Structural enforcement: verify the response contains a recommendation for every brief item.
          // One enforcement cycle — if the second run also fails, we use whatever was returned.
          const requiredCount = countBriefItems(comprehensiveQuestion)
          if (countRecommendations(capturedAgentResponse) < requiredCount) {
            console.log(`[ESCALATION] PM recommendation gate failed — expected ${requiredCount}, got ${countRecommendations(capturedAgentResponse)} — re-running with enforcement override`)
            await update("_Giving you concrete recommendations for every item..._")
            capturedAgentResponse = ""
            const enforcementMessage = `PLATFORM ENFORCEMENT: Your previous response did not include a "My recommendation:" line for every item. The brief has ${requiredCount} item(s). You must output exactly ${requiredCount} recommendation(s) — one per numbered item — using this exact format for each:

[N]. My recommendation: [one specific, concrete answer — no conditionals, no "it depends"]
→ Rationale: [one sentence grounded in product vision, user needs, or standard practice]
→ Note: Pending your approval — say yes to apply to the product spec

Do not ask for context. Do not clarify before recommending. Make the best call and state it. If a question has two valid interpretations, state both and recommend one.

ORIGINAL BRIEF:
${brief}`
            await runPmAgent({ channelName, channelId, threadTs, userMessage: enforcementMessage, client, update: capturingUpdate })
          }
        }
      }})
      // Clear after agent ran and output is captured — safe to commit now.
      clearPendingEscalation(featureName)

      if (isArchitectEscalation) {
        // Architect is a human — hold for their reply before writing to the engineering spec.
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `${mention} — review the recommendations above and reply here to confirm or adjust. Once you reply, the design agent will use each confirmed recommendation to unblock and advance the design spec.`,
        })
        setEscalationNotification(featureName, { targetAgent: "architect", question: pendingEscalation.question, recommendations: capturedAgentResponse || undefined, originAgent: "design" })
      } else {
        // PM recommendations require explicit human approval before spec is patched and design resumes.
        // Two-step pattern: PM runs → human says yes → spec patched → design resumes.
        // This matches the architect path and makes the "pending your approval" note in PM output honest.
        setEscalationNotification(featureName, { targetAgent: "pm", question: comprehensiveQuestion, recommendations: capturedAgentResponse || undefined, originAgent: "design" })
      }
      return
    }
    // Escalation pending but user did not confirm — remind and hold. Do not clear, do not run agent.
    if (pendingEscalation) {
      console.log(`[ROUTER] branch=pending-escalation-hold targetAgent=${pendingEscalation.targetAgent}`)

      const q = pendingEscalation.question
      const pendingAgentLabel = pendingEscalation.targetAgent === "architect" ? "Architect" : "PM"
      const pendingAgentFull = pendingEscalation.targetAgent === "architect" ? "the Architect" : "the PM"
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Design is paused — ${pendingAgentFull} needs to resolve a blocking gap before we can continue:\n\n*"${q}"*\n\nSay *yes* to bring ${pendingAgentLabel} into this thread.`,
      })
      return
    }

    // Escalation notification active — the PM/Architect/Designer was @mentioned and is expected
    // to resolve blocking items before design resumes.
    // If the human sends a standalone confirmation (yes/approved/confirmed), design resumes.
    // If they send any other message — including partial approvals or follow-up requests —
    // the message routes back to the escalated agent (PM or Architect) for continued conversation.
    // This mirrors real-world behavior: once you're in a PM conversation, you stay in it until
    // you explicitly confirm and close it.
    const escalationNotification = getEscalationNotification(featureName)
    if (escalationNotification && escalationNotification.originAgent !== "architect") {
      const isArchitectEscalation = escalationNotification.targetAgent === "architect"
      const notifAgentLabel = isArchitectEscalation ? "Architect" : "Product Manager"

      if (!isStandaloneConfirmation(userMessage)) {
        console.log(`[ROUTER] branch=escalation-continuation targetAgent=${escalationNotification.targetAgent} msg="${userMessage.slice(0, 80)}"`)
        let updatedRecommendations = ""
        const continuationToolCalls: ToolCallRecord[] = []
        await withThinking({ client, channelId, threadTs, agent: notifAgentLabel, run: async (update) => {
          const capturingUpdate = async (text: string) => { updatedRecommendations = text; await update(text) }
          if (isArchitectEscalation) {
            await runArchitectAgent({ channelName, channelId, threadTs, featureName, userMessage, userImages, client, update: capturingUpdate })
          } else {
            await runPmAgent({ channelName, channelId, threadTs, userMessage, client, update: capturingUpdate, toolCallsOut: continuationToolCalls })
          }
        }})

        // Platform enforcement: if the PM saved the spec this turn, the escalation is structurally
        // resolved regardless of how the human phrased their message ("agree", "looks good", etc.).
        // A spec save is a deterministic signal — clear the notification and resume design.
        const PM_SAVE_TOOLS = ["save_product_spec_draft", "apply_product_spec_patch", "finalize_product_spec"]
        const pmDidSave = !isArchitectEscalation && continuationToolCalls.some(t => PM_SAVE_TOOLS.includes(t.name))
        if (pmDidSave) {
          console.log(`[ROUTER] branch=escalation-auto-close — PM saved spec this turn, escalation resolved`)
          clearEscalationNotification(featureName)

          // If the PM also called offer_architect_escalation this turn, surface it before resuming design.
          // Platform enforcement: the tool call is the signal — not prose. Principle 8.
          const archEscalationCall = continuationToolCalls.find(t => t.name === "offer_architect_escalation")
          if (archEscalationCall) {
            const archQuestion = archEscalationCall.input.question as string
            setPendingEscalation(featureName, { targetAgent: "architect", question: archQuestion, designContext: "" })
            console.log(`[ROUTER] branch=escalation-auto-close-arch — PM flagged architecture gap: "${archQuestion.slice(0, 80)}"`)
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `*Product Manager* — Design questions resolved and spec updated.\n\nHowever, an architecture gap was identified that the architect must address before engineering begins:\n\n${archQuestion}\n\nSay *yes* to bring the architect into this thread now, or continue with design and the architect will address it when the engineering phase begins.`,
            })
            return
          }

          const injectedMessage = `PM decisions confirmed and product spec updated. Continue the design.`
          await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
            await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage: injectedMessage, userImages, client, update })
          }})
          return
        }

        // Only update stored recommendations if the PM's response is in recommendation format
        // (contains "My recommendation:" markers). This prevents a pivoted or confused PM response
        // (e.g. "I need to stop and clarify...") from overwriting valid decisions. A continuation
        // turn where the PM explicitly revises its recommendations (the user asked "can you adjust
        // #2?") should update; a turn where the PM pivots to an unrelated concern should not.
        const pmResponseHasRecommendations = updatedRecommendations.includes("My recommendation:")
        const preservedRecommendations = pmResponseHasRecommendations
          ? updatedRecommendations
          : (escalationNotification.recommendations || updatedRecommendations)
        setEscalationNotification(featureName, { ...escalationNotification, recommendations: preservedRecommendations })
        return
      }

      // Standalone confirmation — human is done talking to the PM/Architect. Resume design.
      const { roles } = loadWorkspaceConfig()
      const respondingRole = (isArchitectEscalation && roles.architectUser && userId === roles.architectUser)
        ? "Architect"
        : "PM"
      console.log(`[ROUTER] branch=escalation-reply targetAgent=${escalationNotification.targetAgent} respondingRole=${respondingRole} userId=${userId ?? "(none)"}`)
      clearEscalationNotification(featureName)

      // Write confirmed recommendations back to the appropriate spec:
      // - PM escalation → product spec (auditor won't re-discover same gaps)
      // - Architect escalation → engineering spec (decision captured before engineering begins)
      if (escalationNotification.recommendations) {
        if (isArchitectEscalation) {
          await patchEngineeringSpecWithDecision({
            featureName,
            question: escalationNotification.question,
            decision: escalationNotification.recommendations,
          }).catch(err => console.log(`[ESCALATION] engineering spec writeback failed (non-blocking): ${err}`))
        } else {
          await patchProductSpecWithRecommendations({
            featureName,
            question: escalationNotification.question,
            recommendations: escalationNotification.recommendations,
            humanConfirmation: userMessage,
          }).catch(err => console.log(`[ESCALATION] product spec writeback failed (non-blocking): ${err}`))
        }
      }

      // PM posts closure message — PM owns the spec update, not the design agent
      if (escalationNotification.recommendations) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `*Product Manager* — Product spec updated with the confirmed decisions. The design team can now continue.`,
        }).catch(err => console.log(`[ESCALATION] PM closure message failed (non-blocking): ${err}`))
      }

      const injectedMessage = `PM decisions confirmed and product spec updated. Continue the design.`
      await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
        await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage: injectedMessage, userImages, client, update })
      }})
      return
    }

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
    // Upstream escalation: architect offered to escalate a constraint to PM or Designer.
    // Mirrors the design agent's pendingEscalation / escalationNotification pattern exactly.
    const archPendingEscalation = getPendingEscalation(featureName)
    if (archPendingEscalation && isAffirmative(userMessage)) {
      const target = archPendingEscalation.targetAgent  // "pm" or "design"
      console.log(`[ROUTER] branch=arch-upstream-escalation-confirmed target=${target}`)
      const { roles } = loadWorkspaceConfig()
      const isDesignTarget = target === "design"
      const mention = isDesignTarget
        ? (roles.designerUser ? `<@${roles.designerUser}>` : `*UX Designer*`)
        : (roles.pmUser ? `<@${roles.pmUser}>` : `*Product Manager*`)
      const agentLabel = isDesignTarget ? "UX Designer" : "Product Manager"
      const brief = isDesignTarget
        ? `ARCHITECT ESCALATION — Design revision needed to unblock engineering.

While specifying the engineering approach, the architect found a constraint that requires the design spec to be revised before implementation can proceed.

Your job: review the constraint below and provide a concrete design decision so engineering can resume.

For each item, respond with:
[N]. My recommendation: [specific design decision — no conditionals, no "it depends"]
→ Rationale: [one sentence grounded in UX principles or the approved design system]

Do not ask for more context. Do not present multiple options. End with: "Once you confirm these revisions, the architect will update the engineering spec."

CONSTRAINT REQUIRING DESIGN REVISION:
${archPendingEscalation.question}`
        : `ARCHITECT ESCALATION — PM decision needed to unblock engineering.

While specifying the engineering approach, the architect found a constraint that requires a product decision before implementation can proceed.

Your job: give a specific, concrete recommendation for each item below so engineering can resume today.

For each item, respond with:
[N]. My recommendation: [one specific, concrete answer — no conditionals, no "it depends"]
→ Rationale: [one sentence grounded in product vision, user needs, or standard practice]

Do not ask for more context. Do not present multiple options.

CONSTRAINT REQUIRING PRODUCT DECISION:
${archPendingEscalation.question}`
      let capturedResponse = ""
      await withThinking({ client, channelId, threadTs, agent: agentLabel, run: async (update) => {
        const capturingUpdate = async (text: string) => { capturedResponse = text; await update(text) }
        if (isDesignTarget) {
          await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage: brief, userImages: [], client, update: capturingUpdate })
        } else {
          await runPmAgent({ channelName, channelId, threadTs, userMessage: brief, client, update: capturingUpdate })
        }
      }})
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: isDesignTarget
          ? `${mention} — the architect needs a design revision before engineering can proceed. Review the recommendations above and reply here to confirm or adjust. Once you reply, the architect will resume with your decision applied.`
          : `${mention} — the architect needs a product decision before engineering can proceed. Review the recommendations above and reply here to confirm or adjust. Once you reply, the architect will resume with your decision applied.`,
      })
      clearPendingEscalation(featureName)
      setEscalationNotification(featureName, { targetAgent: target, question: archPendingEscalation.question, recommendations: capturedResponse || undefined, originAgent: "architect" })
      return
    }
    if (archPendingEscalation) {
      // Hold — upstream revision pending, user has not confirmed
      console.log(`[ROUTER] branch=arch-upstream-escalation-hold target=${archPendingEscalation.targetAgent}`)
      const q = archPendingEscalation.question
      const holderName = archPendingEscalation.targetAgent === "design" ? "Designer" : "PM"
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Engineering is paused — the ${holderName} needs to review a constraint before we can continue:\n\n*"${q}"*\n\nSay *yes* to bring the ${holderName} into this thread.`,
      })
      return
    }
    // Upstream revision reply — Designer or PM is responding to architect's upstream escalation.
    // If standalone confirmation → resume architect. Otherwise → continue the conversation with
    // the design/PM agent, keeping the notification active until the human explicitly confirms.
    const archEscalationNotification = getEscalationNotification(featureName)
    if (archEscalationNotification && archEscalationNotification.originAgent === "architect") {
      const archNotifTarget = archEscalationNotification.targetAgent
      const archNotifAgentLabel = archNotifTarget === "design" ? "UX Designer" : "Product Manager"

      if (!isStandaloneConfirmation(userMessage)) {
        // Human continues the conversation with the Designer or PM — keep notification active.
        console.log(`[ROUTER] branch=arch-upstream-continuation target=${archNotifTarget} msg="${userMessage.slice(0, 80)}"`)
        let updatedRecommendations = ""
        await withThinking({ client, channelId, threadTs, agent: archNotifAgentLabel, run: async (update) => {
          const capturingUpdate = async (text: string) => { updatedRecommendations = text; await update(text) }
          if (archNotifTarget === "design") {
            await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages: [], client, update: capturingUpdate })
          } else {
            await runPmAgent({ channelName, channelId, threadTs, userMessage, client, update: capturingUpdate })
          }
        }})
        setEscalationNotification(featureName, { ...archEscalationNotification, recommendations: updatedRecommendations || archEscalationNotification.recommendations })
        return
      }

      // Standalone confirmation — resume architect with injected revision.
      console.log(`[ROUTER] branch=arch-upstream-revision-reply target=${archNotifTarget}`)
      // Write the architect's question + upstream answer to the engineering spec (non-blocking)
      // so the decision is recorded before the architect resumes.
      if (archEscalationNotification.recommendations) {
        await patchEngineeringSpecWithDecision({
          featureName,
          question: archEscalationNotification.question,
          decision: archEscalationNotification.recommendations,
        }).catch(err => console.log(`[ESCALATION] engineering spec writeback failed (non-blocking): ${err}`))
      }
      clearEscalationNotification(featureName)
      const respondingRole = archNotifTarget === "design" ? "Designer" : "PM"
      const injectedMessage = `${respondingRole} resolved the upstream constraint: "${archEscalationNotification.question}" → "${userMessage}". The upstream spec has been revised. Resume engineering spec development with this revision applied — update the affected sections and continue.`
      await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
        await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage: injectedMessage, userImages: [], client, update })
      }})
      return
    }
    console.log(`[ROUTER] branch=confirmed-architect feature=${featureName}`)
    await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
      await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
    }})
    return
  }

  if (confirmedAgent === "pm") {
    // If the product spec is already approved, route to the design phase.
    const currentPhase = await getFeaturePhase(getFeatureName(channelName))
    if (currentPhase === "product-spec-approved-awaiting-design") {
      console.log(`[ROUTER] branch=confirmed-pm-phase-advance feature=${featureName} → routing to ux-design (product spec approved)`)
      setConfirmedAgent(featureName, "ux-design")
      await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
        await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      }})
      return
    }
    console.log(`[ROUTER] branch=confirmed-pm feature=${featureName}`)
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
  console.log(`[ROUTER] branch=new-thread feature=${featureName} currentPhase=${currentPhase}`)
  const thinkingLabel =
    currentPhase === "product-spec-approved-awaiting-design" || currentPhase === "design-in-progress" ? "UX Designer" :
    currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress" ? "Architect" :
    undefined
  await withThinking({ client, channelId, threadTs, agent: thinkingLabel, run: async (update) => {
    if (currentPhase === "product-spec-approved-awaiting-design" || currentPhase === "design-in-progress") {
      console.log(`[ROUTER] branch=new-thread-design feature=${featureName}`)
      setConfirmedAgent(featureName, "ux-design")
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      return
    }

    if (currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress") {
      console.log(`[ROUTER] branch=new-thread-architect feature=${featureName}`)
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

  } finally {
    featureInFlight.delete(featureName)
  }
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
  toolCallsOut?: ToolCallRecord[]  // Optional: caller passes [] to collect tool calls (e.g. to detect spec saves)
}): Promise<void> {
  const { channelName, channelId, threadTs, userMessage, userImages, client, update, routingNote, readOnly, approvedSpecContext, toolCallsOut: callerToolCallsOut } = params
  const featureName = getFeatureName(channelName)

  // Pending spec approval — check before anything else
  const pendingApproval = getPendingApproval(featureName)
  if (pendingApproval && pendingApproval.specType === "product") {
    console.log(`[ROUTER] runPmAgent: pending product approval found for feature=${featureName}`)
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

  const systemPrompt = buildPmSystemBlocks(context, featureName, readOnly, approvedSpecContext)

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
        const rawContent = input.content as string
        // Structural gate: strip design-scope sections and cross-domain open questions
        // before any audit or save. PM spec must contain only PM-scope content.
        const sanitized = sanitizePmSpecDraft(rawContent)
        const content = sanitized.content
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
        const sanitizeNote = sanitized.wasModified
          ? { strippedSections: sanitized.strippedSections, strippedOpenQuestions: sanitized.strippedOpenQuestions }
          : undefined
        return { result: { url, audit: auditOut, ...(sanitizeNote ? { sanitized: sanitizeNote } : {}) } }
      }
      if (name === "apply_product_spec_patch") {
        const patch = input.patch as string
        const branchName = `spec/${featureName}-product`
        const existingDraft = await readFile(pmFilePath, branchName)
        const rawMerged = applySpecPatch(existingDraft ?? "", patch)
        // Structural gate: strip design-scope sections and cross-domain open questions
        const sanitized = sanitizePmSpecDraft(rawMerged)
        const mergedDraft = sanitized.content
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
        const allOpenQuestions = extractAllOpenQuestions(existingDraft)
        if (allOpenQuestions.length > 0) {
          return { error: `Approval blocked — ${allOpenQuestions.length} open question${allOpenQuestions.length > 1 ? "s" : ""} must be resolved first (blocking and non-blocking questions both block finalization):\n${allOpenQuestions.map(q => `• ${q}`).join("\n")}` }
        }
        const designNotes = extractHandoffSection(existingDraft, "## Design Notes")
        if (designNotes.trim()) {
          return { error: `Approval blocked — ## Design Notes must be empty before finalization. Address or move each design note before submitting the final spec.` }
        }
        const [designReadiness, adversarialReadiness] = await Promise.all([
          auditPhaseCompletion({ specContent: existingDraft, rubric: PM_DESIGN_READINESS_RUBRIC, featureName }),
          auditDownstreamReadiness({ specContent: existingDraft, downstreamRole: "designer", featureName }),
        ])
        const allReadinessFindings = [...designReadiness.findings, ...adversarialReadiness.findings]
        if (allReadinessFindings.length > 0) {
          const findingLines = allReadinessFindings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
          return { error: `Approval blocked — spec is not design-ready. A designer receiving this spec would need to invent the following answers:\n${findingLines}\n\nResolve each before finalizing.` }
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
      if (name === "offer_architect_escalation") {
        // Tool call captured in toolCallsOut — the caller (auto-close path) processes it after the PM run.
        // Design can still continue; the architecture gap is surfaced before engineering begins.
        return { result: "Architecture gap registered. If the user confirms, the architect will be brought in to resolve it before engineering begins." }
      }
      return { error: `Unknown tool: ${name}` }
    },
    toolCallsOut: toolCallsOutPm,
  })

  // Expose collected tool calls to caller if requested (e.g. to detect spec saves in continuation path)
  if (callerToolCallsOut) callerToolCallsOut.push(...toolCallsOutPm)

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
    console.log(`[ROUTER] runDesignAgent: pending design approval found for feature=${featureName}`)
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
      let pvContent = ""
      let saContent = ""
      let approvedPmSpecContent = ""
      if (draftContent) {
        const pmSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`
        ;[pvContent, saContent, approvedPmSpecContent] = await Promise.all([
          readFile(paths.productVision, "main").catch(() => ""),
          readFile(paths.systemArchitecture, "main").catch(() => ""),
          readFile(pmSpecPath, "main").catch(() => ""),
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

      // Full 4-pass quality audit — deterministic checks + Haiku semantic pass.
      // Runs on every state query regardless of how it's phrased — same audit that runs
      // on the design agent LLM path, now consistent across both paths (Principle 7).
      // Results cached by spec fingerprint — regular-path messages reuse them without extra LLM calls.
      let stateQualityIssues: string[] = []
      if (draftContent) {
        const stateQCacheKey = `render-ambiguity:${featureName}:${specFingerprint(draftContent)}`
        const auditCacheFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design-audit.json`
        const fp = specFingerprint(draftContent)
        if (renderAmbiguitiesCache.has(stateQCacheKey)) {
          // In-memory cache hit (same process, same spec version)
          stateQualityIssues = renderAmbiguitiesCache.get(stateQCacheKey)!
        } else {
          // Try persistent GitHub cache (survives restarts, shared across users)
          const persistedFindings = await readDraftAuditCache({ featureName, filePath: auditCacheFilePath, expectedFingerprint: fp }).catch(() => null)
          if (persistedFindings) {
            stateQualityIssues = persistedFindings
            renderAmbiguitiesCache.set(stateQCacheKey, persistedFindings)
          } else {
            // Cache miss — run Haiku once and persist
            stateQualityIssues = await auditSpecRenderAmbiguity(draftContent, { formFactors: targetFormFactors }).catch(() => [] as string[])
            renderAmbiguitiesCache.set(stateQCacheKey, stateQualityIssues)
            // Persist to GitHub — non-blocking, non-fatal
            saveDraftAuditCache({ featureName, filePath: auditCacheFilePath, content: { specFingerprint: fp, findings: stateQualityIssues } }).catch(() => {})
          }
        }
      }

      // Missing brand tokens — same computation as LLM path.
      const missingTokensState = brandContent && draftContent ? auditMissingBrandTokens(draftContent, brandContent) : []

      // Readiness gaps — same cache as LLM path so repeated state queries are free.
      let readinessFindingsState: Array<{ issue: string; recommendation: string }> = []
      if (draftContent) {
        const dfp = specFingerprint(draftContent)
        const ctxFp = specFingerprint(pvContent + saContent + approvedPmSpecContent)
        const stateCacheKey = `design-phase:${featureName}:${dfp}:${ctxFp}`
        if (designReadinessFindingsCache.has(stateCacheKey)) {
          readinessFindingsState = designReadinessFindingsCache.get(stateCacheKey) ?? []
        } else {
          const result = await auditPhaseCompletion({
            specContent: draftContent,
            rubric: buildDesignRubric(targetFormFactors),
            featureName,
            productVision: pvContent,
            systemArchitecture: saContent,
            approvedProductSpec: approvedPmSpecContent,
          }).catch(() => null)
          readinessFindingsState = result && !result.ready ? result.findings : []
          phaseEntryAuditCache.set(stateCacheKey, readinessFindingsState.length > 0 ? "[PLATFORM DESIGN READINESS]" : "")
          designReadinessFindingsCache.set(stateCacheKey, readinessFindingsState)
        }
      }

      // Build the same 4-category action menu used by the LLM path — unified format.
      const stateActionMenu = buildActionMenu([
        {
          emoji: ":art:",
          label: "Brand Drift",
          issues: [
            ...brandDrifts.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
            ...animationDrifts.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ],
        },
        {
          emoji: ":jigsaw:",
          label: "Missing Brand Tokens",
          issues: missingTokensState.map(m => ({ issue: `${m.token} not referenced in spec`, fix: `add with value \`${m.brandValue}\`` })),
        },
        {
          emoji: ":pencil:",
          label: "Design Issues",
          issues: [
            ...readinessFindingsState.map(f => ({ issue: f.issue, fix: f.recommendation })),
            ...stateQualityIssues.map(splitQualityIssue),
          ],
        },
      ])

      const stateOpenItemCount = brandDrifts.length + animationDrifts.length + missingTokensState.length +
        stateQualityIssues.length + readinessFindingsState.length
      const msg = buildDesignStateResponse({ featureName, draftContent, specUrl, previewNote, specGap, uncommittedDecisions, openItemCount: stateOpenItemCount })
      appendMessage(featureName, { role: "user", content: userMessage })
      appendMessage(featureName, { role: "assistant", content: msg })
      await update(msg + stateActionMenu)
      return
    }

  }

  await update("_UX Designer is reading the spec and design context..._")
  const historyDesign = getHistory(featureName)
  const DESIGN_HISTORY_LIMIT = 20
  const MAX_FIX_PASSES = 3
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
      ].join(", ")}. The platform displays these in a structured block. DO NOT restate or list them in your response. Apply any drift fixes the user requested and keep your prose to ≤3 sentences.]`
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
  let designReadinessFindings: Array<{ issue: string; recommendation: string }> = []
  const designSpecDraftPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designDraftContent = await readFile(designSpecDraftPath, `spec/${featureName}-design`).catch(() => null)

  // Deterministic design quality checks — zero LLM cost, run on every response when draft exists.
  // Uses designDraftContent (fetched above from the spec branch) — NOT context.currentDraft which
  // may be empty if the draft is only on a feature branch and not yet committed to main.
  const redundantBrandingIssues = designDraftContent ? auditRedundantBranding(designDraftContent) : []
  const copyCompletenessIssues = designDraftContent ? auditCopyCompleteness(designDraftContent) : []
  const qualityIssues = [...redundantBrandingIssues, ...copyCompletenessIssues]

  // Use cached LLM render ambiguities if populated by a recent state query for this spec version.
  // State queries write to this cache; regular-path messages read from it at zero LLM cost.
  // Falls back to deterministic-only qualityIssues when the cache is cold (no prior state query).
  const preRunLlmQuality: string[] = designDraftContent
    ? (renderAmbiguitiesCache.get(`render-ambiguity:${featureName}:${specFingerprint(designDraftContent)}`) ?? qualityIssues)
    : qualityIssues

  const qualityNotice = preRunLlmQuality.length > 0
    ? `\n\n[PLATFORM NOTICE — DESIGN QUALITY: ${preRunLlmQuality.length} issue${preRunLlmQuality.length === 1 ? "" : "s"} blocking approval:\n${preRunLlmQuality.map((i, n) => `${n + 1}. ${i}`).join("\n")}\nThe platform displays these in a structured block. DO NOT restate them in your response. Apply any quality fixes the user requested and keep your prose to ≤3 sentences.]`
    : ""
  if (designDraftContent) {
    const dfp = specFingerprint(designDraftContent)
    const designCtxFp = specFingerprint((context.productVision ?? "") + (context.systemArchitecture ?? "") + (context.approvedProductSpec ?? ""))
    const designCacheKey = `design-phase:${featureName}:${dfp}:${designCtxFp}`
    if (phaseEntryAuditCache.has(designCacheKey)) {
      designReadinessNotice = phaseEntryAuditCache.get(designCacheKey)!
      designReadinessFindings = designReadinessFindingsCache.get(designCacheKey) ?? []
    } else {
      const designAuditResult = await auditPhaseCompletion({
        specContent: designDraftContent,
        rubric: buildDesignRubric(targetFormFactors),
        featureName,
        productVision: context.productVision,
        systemArchitecture: context.systemArchitecture,
        approvedProductSpec: context.approvedProductSpec,
      }).catch(() => null)
      if (designAuditResult && !designAuditResult.ready) {
        designReadinessFindings = designAuditResult.findings
        const productFindingsPreRun = designAuditResult.findings.filter(f => f.issue.includes("[PM-GAP]"))
        console.log(`[ESCALATION] Gate 1 (pre-run audit) for ${featureName}: ${designAuditResult.findings.length} total findings, ${productFindingsPreRun.length} [PM-GAP]`)
        if (productFindingsPreRun.length > 0) {
          console.log(`[ESCALATION] Gate 1 [PM-GAP] findings:\n${productFindingsPreRun.map(f => f.issue).join("\n")}`)
        }
        const findingLines = designAuditResult.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        designReadinessNotice = `\n\n[DESIGN REVIEW — ${designAuditResult.findings.length} gap${designAuditResult.findings.length === 1 ? "" : "s"} blocking engineering handoff. These are displayed to the user in a structured block — DO NOT restate or list them in your response. Do NOT ask clarifying questions — your recommendation for each is stated. Do NOT reference "the platform" in your response; speak as the UX Designer throughout. For product gaps, escalate to the PM. For architecture gaps, escalate to the Architect. For design gaps you own, fix them when the user asks. Keep your prose to ≤2 sentences.\n${findingLines}]`
      } else if (designAuditResult?.ready) {
        console.log(`[ESCALATION] Gate 1 (pre-run audit) for ${featureName}: PASS — no findings`)
        designReadinessNotice = `\n\n[DESIGN REVIEW — Spec passed all design rubric criteria. You may confirm the spec is engineering-ready when asked.]`
      }
      phaseEntryAuditCache.set(designCacheKey, designReadinessNotice)
      designReadinessFindingsCache.set(designCacheKey, designReadinessFindings)
    }
  }

  // Inject ## Design Notes from approved PM spec as [PM DESIGN GUIDANCE] in design agent's brief.
  // PM finalizes with Design Notes seeded; designer must address each before design is approved.
  let pmDesignGuidanceNotice = ""
  if (pmSpecContent) {
    const pmDesignNotes = extractHandoffSection(pmSpecContent, "## Design Notes")
    if (pmDesignNotes.trim()) {
      pmDesignGuidanceNotice = `\n\n[PM DESIGN GUIDANCE — The PM identified the following design considerations. You must address each of these in the design spec before approval. They are not questions — they are constraints and observations the PM has flagged for the designer to act on:\n${pmDesignNotes}]`
    }
  }

  // Fix-all intent — detected before enriching the message so the PLATFORM FIX-ALL block
  // can be appended with the authoritative item list built from the same pre-run audit data.
  // Same source of truth as buildActionMenu — no drift between what's shown and what's fixed.
  // Fast path: keyword match on prescribed format ("fix all", "fix 1 3") — no API cost.
  // Fallback: Haiku classifier for natural English ("go ahead and fix all of these").
  // Pre-filter: only run Haiku when message contains a plausible fix-intent word —
  // avoids adding a Haiku call to every normal turn.
  // Safe default: Haiku errors → NOT-FIX, never accidentally enters the loop.
  // Only "fix" and "apply" are unambiguous fix-intent signals that won't appear in
  // platform-generated briefs (which contain "update", "resolve", "address", etc.).
  const FIX_PREFILTER = /\b(fix|apply)\b/i
  let fixIntent = parseFixAllIntent(userMessage)
  if (!fixIntent.isFixAll && FIX_PREFILTER.test(userMessage)) {
    fixIntent = await classifyFixIntent(userMessage).catch(() => ({ isFixAll: false, selectedIndices: null }))
  }
  console.log(`[FIX-INTENT] isFixAll=${fixIntent.isFixAll} selectedIndices=${JSON.stringify(fixIntent.selectedIndices)}`)
  const allActionItems = [
    ...brandDriftsDesign.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
    ...animDriftsDesign.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
    ...missingTokensDesign.map(m => ({ issue: `${m.token} not referenced in spec`, fix: `add with value \`${m.brandValue}\`` })),
    ...preRunLlmQuality.map(splitQualityIssue),
    ...designReadinessFindings.map(f => ({ issue: f.issue, fix: f.recommendation })),
  ]
  console.log(`[FIX-INTENT] allActionItems=${allActionItems.length} (brand=${brandDriftsDesign.length} anim=${animDriftsDesign.length} missing=${missingTokensDesign.length} quality=${preRunLlmQuality.length} readiness=${designReadinessFindings.length})`)
  const itemsToFix = !fixIntent.isFixAll ? [] :
    fixIntent.selectedIndices
      ? allActionItems.filter((_, i) => fixIntent.selectedIndices!.includes(i + 1))
      : allActionItems
  // autoFixItems: only brand drift (token + animation + missing tokens).
  // Quality issues and readiness findings are both excluded — the agent "fixes" them by writing
  // new spec content, which grows the spec and triggers new quality findings (unbounded growth).
  // Only brand drift is truly surgical: a specific value swap that cannot introduce new issues.
  const preRunReadinessIssues = new Set(designReadinessFindings.map(f => f.issue))
  const preRunQualityIssues = new Set(preRunLlmQuality.map(q => splitQualityIssue(q).issue))
  const autoFixItems = itemsToFix.filter(item =>
    !item.issue.includes("[PM-GAP]") &&
    !preRunReadinessIssues.has(item.issue) &&
    !preRunQualityIssues.has(item.issue)
  )
  const pmGapItems = itemsToFix.filter(item => item.issue.includes("[PM-GAP]"))
  // singlePassFixItems: quality + readiness items that need one agent pass (no convergence loop).
  // Excluded from autoFixItems (brand drift only) because quality/readiness "fixes" add spec content
  // rather than swap values — the loop would cause unbounded spec growth. One pass is safe.
  const singlePassFixItems = itemsToFix.filter(item =>
    !item.issue.includes("[PM-GAP]") &&
    (preRunReadinessIssues.has(item.issue) || preRunQualityIssues.has(item.issue))
  )
  // Split singlePassFixItems: structural conflicts route to rewrite_design_spec, others to patch.
  const isStructuralConflict = (issue: string) =>
    /duplicate|defined twice|conflicting|appears twice|multiple.*section/i.test(issue)
  const structuralFixItems = singlePassFixItems.filter(item => isStructuralConflict(item.issue))
  const targetedFixItems = singlePassFixItems.filter(item => !isStructuralConflict(item.issue))
  // Platform enforcement: when ALL fix items are structural conflicts, remove apply_design_spec_patch
  // from the tool list entirely — the agent physically cannot call the wrong tool.
  // Structural enforcement (Principle 8): tool-list restriction, not a prompt instruction.
  const designToolsForFixAll = (fixIntent.isFixAll && singlePassFixItems.length > 0 && targetedFixItems.length === 0)
    ? DESIGN_TOOLS.filter(t => t.name !== "apply_design_spec_patch")
    : DESIGN_TOOLS
  if (fixIntent.isFixAll) {
    console.log(`[FIX-INTENT] itemsToFix=${itemsToFix.length} autoFixItems=${autoFixItems.length} singlePassFixItems=${singlePassFixItems.length} (structural=${structuralFixItems.length} targeted=${targetedFixItems.length})`)
  }
  const fixAllNotice = (fixIntent.isFixAll && autoFixItems.length > 0)
    ? `\n\n[PLATFORM FIX-ALL — Apply ALL fixes below via apply_design_spec_patch. One patch per section. Do not ask for confirmation. Do not respond until every patch is applied. Output ≤2 sentences after all patches complete.\n${autoFixItems.map((item, i) => `${i + 1}. ${item.issue} — Fix: ${item.fix}`).join("\n")}]`
    : (fixIntent.isFixAll && singlePassFixItems.length > 0)
    ? `\n\n[PLATFORM FIX-ALL — Address the design issues listed below.${structuralFixItems.length > 0 ? ` For structural conflicts (duplicate sections, contradictory definitions): use rewrite_design_spec with a clean consolidated spec. For all other items: make targeted additions or corrections via apply_design_spec_patch.` : " Make targeted additions or corrections to the relevant spec sections via apply_design_spec_patch."} Do not ask for confirmation. Output ≤2 sentences after completing all changes.\n${singlePassFixItems.map((item, i) => `${i + 1}. ${item.issue} — Fix: ${item.fix}`).join("\n")}]`
    : ""

  if (fixIntent.isFixAll) {
    console.log(`[FIX-INTENT] fixAllNotice=${fixAllNotice ? "GENERATED (" + fixAllNotice.length + " chars)" : "EMPTY — no items to fix"}`)
  }
  let enrichedUserMessageDesign = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsDesign, priorContext: priorContextDesign }) + brandDriftNotice + qualityNotice + specTextNotice + upstreamNoticeDesign + designReadinessNotice + pmDesignGuidanceNotice + fixAllNotice
  const systemPrompt = buildDesignSystemBlocks(context, featureName, readOnly)

  await update("_UX Designer is thinking..._")

  const designFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
  const designBranchName = `spec/${featureName}-design`
  const prefix = routingNote ? `${routingNote}\n\n` : ""
  const toolCallsOutDesign: ToolCallRecord[] = []
  // Snapshot escalation state before agent runs — used after to detect if escalation was just offered
  const escalationBeforeRun = getPendingEscalation(featureName)

  // Extract the approved product spec from context for use in the audit.
  const productSpecMatch = context.currentDraft.match(/## Approved Product Spec\n([\s\S]*?)(?:\n\n## |$)/)
  const auditProductSpec = productSpecMatch ? productSpecMatch[1].trim() : ""

  // Tracks whether any apply_design_spec_patch calls happened this turn.
  // Used to do a single Slack preview upload after all patches complete,
  // instead of uploading after every patch (which spams the thread).
  let patchAppliedThisTurn = false
  // Caches the last successfully generated HTML so the post-patch upload can
  // use it directly without a GitHub round-trip.
  let lastGeneratedPreviewHtml: string | null = null

  // Shared save logic: audit + save + preview + checkpoint.
  // Used by both save_design_spec_draft and apply_design_spec_patch tools.
  // skipSlackUpload=true: save to GitHub and generate HTML but don't upload to Slack.
  // Used by apply_design_spec_patch so multi-patch turns only post one preview.
  const saveDesignDraft = async (content: string, { skipSlackUpload = false }: { skipSlackUpload?: boolean } = {}): Promise<{ result?: unknown; error?: string }> => {
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
      lastGeneratedPreviewHtml = previewResult.html
      await saveDraftHtmlPreview({ featureName, filePath: htmlFilePath, content: previewResult.html }).catch(() => {})
      if (!skipSlackUpload) {
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
        previewUrl = "saved_to_github"
      }
    } else {
      console.error(`[preview] HTML generation failed: ${previewResult.message}`)
    }

    const brandDrifts = context.brand ? auditBrandTokens(content, context.brand) : []
    const specGap = audit.status === "gap" ? audit.message : null
    // IMPORTANT: Render ambiguity findings are NOT returned in the tool response.
    // When included, the Sonnet agent treats them as work to do and calls
    // apply_design_spec_patch again, creating a divergent loop (each patch creates new
    // ambiguities → more patches → more ambiguities, ad infinitum). The spec went from
    // 50K → 31K → 50K with findings growing from 19 → 20 → 32 in a single turn.
    // Render ambiguities are surfaced to the *user* in the post-turn action menu — never
    // to the agent as actionable input. The agent only patches what the user approved.
    return { result: { specUrl: designSpecUrl, previewUrl, brandDrifts, specGap, renderWarnings: renderWarnings.length > 0 ? renderWarnings : undefined } }
  }

  // Design agent has a much larger context (system prompt + product vision + full draft spec)
  // than the PM agent. Cap at 20 messages (10 exchanges) so the combined payload stays well
  // under the token limit. Prior conversation context beyond the limit is summarized and
  // injected into the user message — no work is lost on long threads.
  // designSaveTools is declared here so both the runAgent try-catch and the post-response
  // audit below can reference the same constant without duplication.
  const designSaveTools = ["save_design_spec_draft", "apply_design_spec_patch", "rewrite_design_spec", "finalize_design_spec"]

  // PLATFORM ENFORCEMENT (P0): Spec-writing tools are ONLY available when:
  //   (a) No draft exists yet (initial spec creation), OR
  //   (b) Fix intent is confirmed (user said "fix N N N" or "fix all")
  // When a draft exists and there are open action items (review phase), the agent is read-only
  // on normal conversational turns. This prevents the agent from making unauthorized changes
  // when it misinterprets the user's message as an instruction to modify the spec.
  // Historical violation (2026-04-17): user said "approving fixes for 2, 3, 5 and 8", fix intent
  // detection failed, agent ran with full tool access and modified 20+ spec elements unauthorized.
  const draftExistsWithOpenItems = !!designDraftContent && allActionItems.length > 0
  const specWriteAllowed = !draftExistsWithOpenItems || fixIntent.isFixAll
  const designToolsNormalPath = specWriteAllowed
    ? DESIGN_TOOLS
    : DESIGN_TOOLS.filter(t => !designSaveTools.includes(t.name))
  if (!specWriteAllowed) {
    console.log(`[WRITE-GATE] Spec-writing tools STRIPPED for normal turn (draft exists, ${allActionItems.length} open items, fix intent not confirmed)`)
  }

  // PLATFORM ENFORCEMENT (P0): Audit findings must NEVER reach the agent as tool response data.
  // When audit results (render ambiguities, quality issues) are returned in tool responses,
  // the agent treats them as work to do and auto-patches in a divergent loop. This gate strips
  // audit-only keys from every tool response at the boundary — even if a future code change
  // accidentally adds them back to saveDesignDraft, they are stripped here before reaching the agent.
  // Keys on this list are user-facing (action menu) only, never agent-facing.
  const AGENT_STRIPPED_KEYS = ["renderAmbiguities", "qualityIssues"] as const
  const stripAuditFromToolResult = (result: { result?: unknown; error?: string }): typeof result => {
    if (result.result && typeof result.result === "object" && result.result !== null) {
      const cleaned = { ...result.result as Record<string, unknown> }
      for (const key of AGENT_STRIPPED_KEYS) delete cleaned[key]
      return { ...result, result: cleaned }
    }
    return result
  }

  // Tool handler extracted as named const so the fix-all loop can reuse it across passes
  // without re-creating the closure on each call.
  const designToolHandlerRaw = readOnly ? undefined : async (name: string, input: Record<string, unknown>) => {
      // During fix-all passes, block escalation tool calls — they would set stale pending state
      // that persists after the loop exits. The fix-all contract is: only spec patches this turn.
      // Any PM/architect gaps will surface in the action menu after fix-all completes.
      if (fixIntent.isFixAll && (name === "offer_pm_escalation" || name === "offer_architect_escalation")) {
        console.log(`[FIX-ALL] Blocked ${name} during fix-all — deferring to post-loop action menu`)
        return { result: `[Fix-all mode] Escalation is suspended during fix-all passes. Apply all spec patches first. Any PM or architect gaps will be surfaced in the structured action menu after fix-all completes — do not escalate during this pass.` }
      }
      if (name === "save_design_spec_draft") {
        return saveDesignDraft(input.content as string)
      }
      if (name === "apply_design_spec_patch") {
        const patch = input.patch as string
        const existingDraft = await readFile(designFilePath, designBranchName)
        const mergedDraft = applySpecPatch(existingDraft ?? "", patch)
        patchAppliedThisTurn = true
        return saveDesignDraft(mergedDraft, { skipSlackUpload: true })
      }
      if (name === "rewrite_design_spec") {
        patchAppliedThisTurn = true
        return saveDesignDraft(input.content as string, { skipSlackUpload: true })
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
        console.log(`[ESCALATION] offer_pm_escalation tool called for ${featureName}`)
        console.log(`[ESCALATION] tool question param:\n${input.question}`)
        // Platform-filter the agent's question through the PM-gap classifier before storing.
        // The agent may bundle design/brand issues alongside PM gaps — the classifier keeps
        // only PM-scope items, so the PM brief and escalation message are clean.
        const rawQuestion = input.question as string
        const classification = await classifyForPmGaps({
          agentResponse: rawQuestion,
          approvedProductSpec: context.approvedProductSpec ?? undefined,
        })
        if (classification.gaps.length === 0) {
          // Classifier found no PM-scope gaps — the agent escalated for design/brand/architecture
          // concerns that are not the PM's domain. Reject the tool call and redirect the agent.
          console.log(`[ESCALATION] Gate 2 classifier: 0 PM gaps — rejecting offer_pm_escalation, redirecting agent`)
          // Pre-seed any architect items before redirecting
          if (classification.architectItems.length > 0) {
            const { paths } = loadWorkspaceConfig()
            const archFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.engineering.md`
            await preseedEngineeringSpec({ featureName, filePath: archFilePath, architectItems: classification.architectItems })
              .catch(err => console.log(`[GATE2] preseedEngineeringSpec failed (non-blocking): ${err}`))
          }
          // Design-scope items: return them to the agent for self-resolution (no PM or architect needed)
          if (classification.designItems.length > 0) {
            const designItemList = classification.designItems.map((d, i) => `${i + 1}. ${d}`).join("\n")
            console.log(`[ESCALATION] Gate 2: ${classification.designItems.length} design-scope item(s) returned to agent for self-resolution`)
            return {
              result: `REJECTED: No PM-scope gaps found. The following items are visual/UX design decisions you own independently — resolve them yourself without escalating:\n\n${designItemList}\n\nFor architecture questions (schema, data model, technical mechanism), call offer_architect_escalation instead.`,
            }
          }
          return {
            result: "REJECTED: No PM-scope gaps found in your question. These appear to be design, brand, or architecture concerns. Resolve brand token conflicts directly from BRAND.md (it is the authoritative source). For architecture questions, call offer_architect_escalation instead. Do not escalate to PM for hex values, animation durations, or implementation decisions.",
          }
        }
        const filteredQuestion = classification.gaps.length === 1
          ? classification.gaps[0]                                           // single gap — no numbering
          : classification.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n") // multiple gaps — numbered
        if (classification.gaps.length < rawQuestion.split(/\d+\.\s/).filter(Boolean).length) {
          console.log(`[ESCALATION] Gate 2 classifier filtered ${rawQuestion.split(/\d+\.\s/).filter(Boolean).length - classification.gaps.length} non-PM items from tool question`)
        }
        setPendingEscalation(featureName, {
          targetAgent: "pm",
          question: filteredQuestion,
          designContext: context.currentDraft ?? "",
          productSpec: context.approvedProductSpec ?? undefined,
        })
        // Pre-seed architect-scope items filtered out by Gate 2 into the engineering spec draft.
        // These are not PM gaps — they belong to the architect at engineering phase.
        // Silent platform action: no user-facing message.
        if (classification.architectItems.length > 0) {
          const { paths } = loadWorkspaceConfig()
          const archFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.engineering.md`
          preseedEngineeringSpec({ featureName, filePath: archFilePath, architectItems: classification.architectItems })
            .catch(err => console.log(`[GATE2] preseedEngineeringSpec failed (non-blocking): ${err}`))
        }
        return {
          result: "Escalation offer stored. The user will be prompted to confirm. If they say yes, the PM will be notified with your question.",
        }
      }
      if (name === "offer_architect_escalation") {
        const archQuestion = input.question as string
        // Gate: classify whether this is a true design-blocking architectural unknown
        // or an implementation detail the designer should state as a design assumption.
        const archGapClass = await classifyForArchGap(archQuestion)
        if (archGapClass === "DESIGN-ASSUMPTION") {
          return {
            result: `[PLATFORM REJECTION] This question is an implementation detail — the UI design does not depend on the answer. Do NOT escalate this to the architect.\n\nInstead:\n1. Decide the user-visible behavior (e.g. "conversation is preserved when the user signs in").\n2. Add an entry to the ## Design Assumptions section documenting what the architect will need to confirm.\n3. Continue designing — the architect resolves this during engineering, not before.\n\nExample Design Assumption entry: "- Conversation data is preserved on sign-in via server-side or client-side storage (implementation TBD by architect)."`,
          }
        }
        setPendingEscalation(featureName, {
          targetAgent: "architect",
          question: archQuestion,
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
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          approvedProductSpec: context.approvedProductSpec,
        })
        return { result }
      }
      if (name === "finalize_design_spec") {
        const existingDraft = await readFile(designFilePath, designBranchName)
        if (!existingDraft) {
          return { error: "No draft saved yet — save a draft first before finalizing." }
        }
        const allOpenQuestions = extractAllOpenQuestions(existingDraft)
        if (allOpenQuestions.length > 0) {
          return { error: `Approval blocked — ${allOpenQuestions.length} open question${allOpenQuestions.length > 1 ? "s" : ""} must be resolved first (blocking and non-blocking questions both block finalization):\n${allOpenQuestions.map(q => `• ${q}`).join("\n")}` }
        }
        let finalContent = existingDraft
        const [decisionAudit, architectReadiness] = await Promise.all([
          auditSpecDecisions({ specContent: existingDraft, history: getHistory(featureName) }),
          auditDownstreamReadiness({ specContent: existingDraft, downstreamRole: "architect", featureName }),
        ])
        if (decisionAudit.status === "corrections") {
          const { corrected } = applyDecisionCorrections(existingDraft, decisionAudit.corrections)
          finalContent = corrected
        }
        if (architectReadiness.findings.length > 0) {
          const findingLines = architectReadiness.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
          return { error: `Approval blocked — spec is not architect-ready. An architect receiving this spec would need to invent the following answers:\n${findingLines}\n\nResolve each before finalizing.` }
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
        // Seed ## Design Assumptions to engineering spec branch (non-blocking)
        const assumptionsContent = extractDesignAssumptions(finalContent)
        if (assumptionsContent.trim()) {
          const engSpecFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.engineering.md`
          seedHandoffSection({
            featureName,
            targetFilePath: engSpecFilePath,
            targetBranchName: `spec/${featureName}-engineering`,
            targetSectionHeading: "## Design Assumptions To Validate",
            content: assumptionsContent,
          }).catch(err => console.log(`[DESIGN-FINALIZE] seedHandoffSection failed (non-blocking): ${err}`))
        }
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${designFilePath}`
        return { result: { url, nextPhase: "engineering" } }
      }
      return { error: `Unknown tool: ${name}` }
  }

  // Wrap the raw handler with the audit-stripping gate (P0 enforcement).
  // Every tool response passes through stripAuditFromToolResult before reaching the agent.
  const designToolHandler = designToolHandlerRaw
    ? async (name: string, input: Record<string, unknown>) =>
        stripAuditFromToolResult(await designToolHandlerRaw(name, input))
    : undefined

  // Effective audit variables — initialized from pre-run audit data.
  // The post-patch continuation loop (below, in the normal path) updates these to reflect
  // the spec state AFTER the agent's patches, replacing stale pre-run data.
  // All downstream consumers (Gate 2, action menu, platform status line) read these.
  let effectiveBrandDrifts = brandDriftsDesign
  let effectiveAnimDrifts = animDriftsDesign
  let effectiveMissingTokens = missingTokensDesign
  let effectiveDeterministicQuality = qualityIssues  // strings, not ActionItems — used in continuation loop
  let effectiveLlmQuality = preRunLlmQuality  // strings — used in action menu (LLM + deterministic when cache warm)
  let effectiveReadinessFindings = designReadinessFindings

  let response: string
  try {
    if (fixIntent.isFixAll && autoFixItems.length > 0) {
      // Platform-controlled fix-all completion loop (Embodiment 13).
      // Platform extracts authoritative item list → runs agent → re-audits from fresh GitHub read →
      // if items remain and progress was made, re-runs automatically (max MAX_FIX_PASSES passes).
      // User never re-engages. Agent prose is suppressed between passes. Platform composes final message.
      let prevItemCount = autoFixItems.length
      let residualItems: ActionItem[] = []
      // selectedResidual = intersection of targeted items and fresh audit — tracks only what the
      // user asked to fix. For "fix all" this equals residualItems. For "fix 1 3" this excludes
      // other open items the user didn't target, so loop termination and message composition are correct.
      let selectedResidual = [...autoFixItems]
      let fixAllComplete = false
      let lastFreshBrand = [] as ReturnType<typeof auditBrandTokens>
      let lastFreshAnim = [] as ReturnType<typeof auditAnimationTokens>
      let lastFreshMissing = [] as ReturnType<typeof auditMissingBrandTokens>
      let lastFreshQualityRaw: string[] = []
      let lastFreshReadiness: Awaited<ReturnType<typeof auditPhaseCompletion>> | null = null
      let lastFreshReadinessItems: ActionItem[] = []

      for (let pass = 1; pass <= MAX_FIX_PASSES; pass++) {
        if (pass > 1) {
          await update(`_Continuing fix-all (pass ${pass} of ${MAX_FIX_PASSES})..._`)
          enrichedUserMessageDesign = buildEnrichedMessage({ userMessage: `[PLATFORM: fix-all pass ${pass}]`, lockedDecisions: lockedDecisionsDesign, priorContext: "" }) +
            `\n\n[PLATFORM FIX-ALL PASS ${pass} — ${selectedResidual.length} item${selectedResidual.length === 1 ? "" : "s"} still unresolved:\n${selectedResidual.map((item, i) => `${i + 1}. ${item.issue} — Fix: ${item.fix}`).join("\n")}]`
        }

        const passResponse = await runAgent({
          systemPrompt,
          history: historyDesign,
          userMessage: enrichedUserMessageDesign,
          userImages: pass === 1 ? userImages : [],
          historyLimit: DESIGN_HISTORY_LIMIT,
          tools: readOnly ? undefined : designToolsForFixAll,
          toolHandler: designToolHandler,
          toolCallsOut: toolCallsOutDesign,
        })

        appendMessage(featureName, { role: "user", content: pass === 1 ? userMessage : `[PLATFORM: fix-all pass ${pass}]` })
        appendMessage(featureName, { role: "assistant", content: passResponse })

        // Re-audit from fresh GitHub read — currentDraft is stale after patches
        const freshDraft = await readFile(designFilePath, designBranchName).catch(() => null)
        if (!freshDraft) break

        lastFreshBrand = context.brand ? auditBrandTokens(freshDraft, context.brand) : []
        lastFreshAnim = context.brand ? auditAnimationTokens(freshDraft, context.brand) : []
        lastFreshMissing = context.brand ? auditMissingBrandTokens(freshDraft, context.brand) : []
        lastFreshQualityRaw = await auditSpecRenderAmbiguity(freshDraft, { formFactors: targetFormFactors }).catch(() => [] as string[])
        // Persist fresh render ambiguity results for this spec version — non-blocking
        const freshFp = specFingerprint(freshDraft)
        const freshAuditCachePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design-audit.json`
        renderAmbiguitiesCache.set(`render-ambiguity:${featureName}:${freshFp}`, lastFreshQualityRaw)
        saveDraftAuditCache({ featureName, filePath: freshAuditCachePath, content: { specFingerprint: freshFp, findings: lastFreshQualityRaw } }).catch(() => {})
        lastFreshReadiness = await auditPhaseCompletion({
          specContent: freshDraft,
          rubric: buildDesignRubric(targetFormFactors),
          featureName,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          approvedProductSpec: context.approvedProductSpec,
        }).catch(() => null)

        // freshFixableItems: brand drift only (token + animation + missing tokens).
        // Quality and readiness are both excluded from auto-patching — the agent "fixes" them
        // by writing new spec content, causing unbounded spec growth.
        const freshFixableItems: ActionItem[] = [
          ...lastFreshBrand.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ...lastFreshAnim.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ...lastFreshMissing.map(m => ({ issue: `${m.token} not referenced in spec`, fix: `add with value \`${m.brandValue}\`` })),
        ]
        lastFreshReadinessItems = lastFreshReadiness && !lastFreshReadiness.ready
          ? lastFreshReadiness.findings.map(f => ({ issue: f.issue, fix: f.recommendation }))
          : []
        residualItems = [...freshFixableItems, ...lastFreshReadinessItems]

        // selectedResidual tracks only fixable items (brand + quality):
        // - "fix all": fresh fixable count IS the ground truth for no-progress detection.
        //   Readiness text is non-deterministic across LLM calls so text-matching is unreliable;
        //   count-based detection on fixable items only is correct.
        // - "fix 1,3": match by issue text from targeted fixable items only.
        if (fixIntent.selectedIndices === null) {
          selectedResidual = freshFixableItems
        } else {
          selectedResidual = autoFixItems.filter(a => freshFixableItems.some(r => r.issue === a.issue))
        }

        if (selectedResidual.length === 0) { fixAllComplete = true; break }
        if (selectedResidual.length >= prevItemCount) break  // no progress on targeted items — stop
        prevItemCount = selectedResidual.length
      }

      // Single preview upload after all passes (individual apply_design_spec_patch calls skipped upload)
      if (patchAppliedThisTurn && lastGeneratedPreviewHtml) {
        client.files.uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          content: lastGeneratedPreviewHtml,
          filename: `${featureName}.preview.html`,
          title: `${featureName} — Design Preview`,
        }).catch(() => {})
      }

      // Clamp at 0: patches may add content that triggers new issues (fresh count > original).
      // selectedResidual = residualItems for "fix all" — can exceed autoFixItems.length.
      const totalFixed = Math.max(0, autoFixItems.length - selectedResidual.length)
      const totalItems = autoFixItems.length + pmGapItems.length
      let fixAllResponse: string
      if (fixAllComplete) {
        // All fixable (brand+quality) items resolved. Readiness gaps may still remain — they
        // require designer judgment to add missing spec content; not auto-patchable.
        if (lastFreshReadinessItems.length > 0) {
          const readinessMenu = buildActionMenu([
            { emoji: ":white_check_mark:", label: "Design Readiness Gaps", issues: lastFreshReadinessItems },
          ])
          fixAllResponse = `Fixed all ${totalItems} quality item${totalItems === 1 ? "" : "s"}.${patchAppliedThisTurn && lastGeneratedPreviewHtml ? " Preview above." : ""} ${lastFreshReadinessItems.length} readiness gap${lastFreshReadinessItems.length === 1 ? "" : "s"} require designer decisions before approving:${readinessMenu}`
        } else {
          fixAllResponse = `Fixed all ${totalItems} item${totalItems === 1 ? "" : "s"}.${patchAppliedThisTurn && lastGeneratedPreviewHtml ? " Preview above." : ""}\n\nSay *approved* to move to engineering.${pmGapItems.length > 0 ? `\n\n_${pmGapItems.length} item${pmGapItems.length === 1 ? "" : "s"} require PM decisions — say *yes* to escalate._` : ""}`
        }
      } else {
        // For partial fix: show unfixed quality items + all remaining readiness gaps
        const totalResidual = selectedResidual.length + lastFreshReadinessItems.length
        const selectedResidualMenu = buildActionMenu([
          { emoji: ":art:", label: "Brand Drift", issues: selectedResidual.filter(i => lastFreshBrand.some(d => i.issue.startsWith(d.token))) },
          { emoji: ":jigsaw:", label: "Missing Brand Tokens", issues: selectedResidual.filter(i => i.issue.includes("not referenced in spec")) },
          { emoji: ":mag:", label: "Design Quality", issues: selectedResidual.filter(i => lastFreshQualityRaw.map(splitQualityIssue).some(q => q.issue === i.issue)) },
          { emoji: ":white_check_mark:", label: "Design Readiness Gaps", issues: lastFreshReadinessItems },
        ])
        fixAllResponse = `Fixed ${totalFixed} of ${totalItems} item${totalItems === 1 ? "" : "s"}. ${totalResidual} item${totalResidual === 1 ? "" : "s"} still need attention:${selectedResidualMenu}`
      }

      await update(`${prefix}${fixAllResponse}`)
      return
    }

    // Normal path (non-fix-all)
    response = await runAgent({
      systemPrompt,
      history: historyDesign,
      userMessage: enrichedUserMessageDesign,
      userImages,
      historyLimit: DESIGN_HISTORY_LIMIT,
      tools: readOnly ? undefined : designToolsNormalPath,
      toolHandler: designToolHandler,
      toolCallsOut: toolCallsOutDesign,
    })

    // Post-patch platform continuation loop — extends platform-owned completion to ALL normal-path
    // patch-producing turns, not just explicit "fix all" requests.
    //
    // Root cause this closes: the agent decides which subset of findings to address per turn.
    // This is prompt-dependent behavior — a behavior that "usually works" is not shippable.
    //
    // Fix: after the agent makes any spec patches, the PLATFORM re-audits from GitHub (fresh,
    // not stale pre-run data) and automatically continues fixing remaining design items (brand
    // drift, quality, rubric gaps without [PM-GAP] tag). PM/architect gaps are left for the
    // escalation gates below — they require user decisions, not more agent passes.
    //
    // Completion is structurally verified by the platform (re-audit after each pass), not by
    // trusting the agent's prose claims. Max 2 continuation passes to bound latency.
    if (patchAppliedThisTurn && !readOnly) {
      const runFreshDesignAudit = async (draft: string) => {
        const freshBrand = context.brand ? auditBrandTokens(draft, context.brand) : []
        const freshAnim = context.brand ? auditAnimationTokens(draft, context.brand) : []
        const freshMissing = context.brand ? auditMissingBrandTokens(draft, context.brand) : []
        const freshDeterministicQuality = [...auditRedundantBranding(draft), ...auditCopyCompleteness(draft)]
        const freshReadiness = await auditPhaseCompletion({
          specContent: draft,
          rubric: buildDesignRubric(targetFormFactors),
          featureName,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          approvedProductSpec: context.approvedProductSpec,
        }).catch(() => null)
        return { freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness }
      }

      let freshDraft = await readFile(designFilePath, designBranchName).catch(() => null)
      if (freshDraft) {
        let { freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness } = await runFreshDesignAudit(freshDraft)

        // Design-only residual: everything that isn't a PM-GAP (which needs escalation, not more patches)
        const computeDesignResidual = (
          b: ReturnType<typeof auditBrandTokens>,
          a: ReturnType<typeof auditAnimationTokens>,
          m: ReturnType<typeof auditMissingBrandTokens>,
          q: string[],
          r: Awaited<ReturnType<typeof auditPhaseCompletion>> | null,
        ): ActionItem[] => [
          ...b.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ...a.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ...m.map(m2 => ({ issue: `${m2.token} not referenced in spec`, fix: `add with value \`${m2.brandValue}\`` })),
          ...q.map(splitQualityIssue),
          ...(r && !r.ready ? r.findings.filter(f => !f.issue.includes("[PM-GAP]")).map(f => ({ issue: f.issue, fix: f.recommendation })) : []),
        ]

        let designResidual = computeDesignResidual(freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness)
        let contPrevCount = designResidual.length

        // Capture pre-run state BEFORE continuation passes update findings.
        // designReadinessFindings here is still the pre-agent-run value — correct baseline.
        // Health invariant uses readiness count only — same rubric on both sides (apples-to-apples).
        // LLM quality count is excluded: post-patch we switch to deterministic quality (fewer items
        // by design), so comparing LLM pre-run vs deterministic post-run always shows false improvement.
        const preRunSpecSize = designDraftContent?.length ?? 0
        const preRunReadinessCount = designReadinessFindings.length
        const { maxAllowedSpecGrowthRatio } = loadWorkspaceConfig()

        for (let contPass = 1; contPass <= 2 && designResidual.length > 0; contPass++) {
          await update(`_${designResidual.length} item${designResidual.length === 1 ? "" : "s"} remaining — continuing..._`)
          const contStructural = designResidual.filter(item => isStructuralConflict(item.issue))
          const contTargeted = designResidual.filter(item => !isStructuralConflict(item.issue))
          // Platform enforcement: strip apply_design_spec_patch when all residual items are structural.
          const contTools = (contTargeted.length === 0)
            ? DESIGN_TOOLS.filter(t => t.name !== "apply_design_spec_patch")
            : DESIGN_TOOLS
          const continuationMsg = buildEnrichedMessage({ userMessage: `[PLATFORM: continuation pass ${contPass}]`, lockedDecisions: lockedDecisionsDesign, priorContext: "" }) +
            `\n\n[PLATFORM CONTINUATION — ${designResidual.length} design item${designResidual.length === 1 ? "" : "s"} still unresolved after your patches. ${contStructural.length > 0 ? "Use rewrite_design_spec with a clean consolidated spec." : "Use apply_design_spec_patch for each remaining item."} Do not ask for confirmation. Output ≤2 sentences after all changes complete.\n${designResidual.map((item, i) => `${i + 1}. ${item.issue} — Fix: ${item.fix}`).join("\n")}]`

          const contResponse = await runAgent({
            systemPrompt,
            history: historyDesign,
            userMessage: continuationMsg,
            userImages: [],
            historyLimit: DESIGN_HISTORY_LIMIT,
            tools: readOnly ? undefined : contTools,
            toolHandler: designToolHandler,
            toolCallsOut: toolCallsOutDesign,
          })

          appendMessage(featureName, { role: "user", content: `[PLATFORM: continuation pass ${contPass}]` })
          appendMessage(featureName, { role: "assistant", content: contResponse })

          freshDraft = await readFile(designFilePath, designBranchName).catch(() => null)
          if (!freshDraft) break

          ;({ freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness } = await runFreshDesignAudit(freshDraft))
          designResidual = computeDesignResidual(freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness)
          if (designResidual.length >= contPrevCount) break  // no progress — stop
          contPrevCount = designResidual.length
        }

        // Propagate fresh audit state to all downstream consumers:
        // Gate 2 (PM gap check), Gate 4 (Haiku classifier), action menu, and platform status line.
        // This is the critical correctness step: stale pre-run data showed items the agent just fixed.
        // designReadinessFindings is `let` — reassign it so Gate 2 reads post-patch PM gaps.
        effectiveBrandDrifts = freshBrand
        effectiveAnimDrifts = freshAnim
        effectiveMissingTokens = freshMissing
        effectiveDeterministicQuality = freshDeterministicQuality
        effectiveLlmQuality = freshDeterministicQuality  // post-patch: use deterministic (LLM call deferred to next state query)
        effectiveReadinessFindings = freshReadiness && !freshReadiness.ready ? freshReadiness.findings : []
        designReadinessFindings = effectiveReadinessFindings

        // Post-patch spec health invariant (Principle 8 — arithmetic gate, no LLM).
        // Fires after every turn that modifies the spec — not phrasing-dependent.
        // Compares pre-run vs post-run spec size and finding count.
        // Blocks if the spec grew beyond the configured ratio OR gained more findings.
        // preRunSpecSize and preRunFindingCount were captured before the continuation loop
        // where designReadinessFindings still had the pre-agent-run values.
        const postRunSpecSize = freshDraft.length
        const postRunReadinessCount = effectiveReadinessFindings.length
        const bloated = preRunSpecSize > 0 && postRunSpecSize > preRunSpecSize * maxAllowedSpecGrowthRatio
        const degraded = postRunReadinessCount > preRunReadinessCount

        if (bloated || degraded) {
          let healthMsg = "The spec wasn't in better shape after that update:"
          if (bloated) {
            const growthPct = Math.round((postRunSpecSize / preRunSpecSize - 1) * 100)
            healthMsg += `\n- It grew significantly (${growthPct}% larger than before). There may be duplicate or conflicting sections — consolidating them may help more than another targeted patch.`
          }
          if (degraded) {
            healthMsg += `\n- There are more spec gaps now (${postRunReadinessCount}) than before (${preRunReadinessCount}). The patches may have introduced new conflicts rather than resolving them.`
          }
          healthMsg += "\n\nSay *try again* and I'll take a different approach, or we can review what changed together."
          await update(healthMsg)
          return
        }
      }
    }
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
      // Upload the final preview once if patches were applied (skipped per-patch to avoid spam)
      if (patchAppliedThisTurn && lastGeneratedPreviewHtml) {
        client.files.uploadV2({ channel_id: channelId, thread_ts: threadTs, content: lastGeneratedPreviewHtml, filename: `${featureName}.preview.html`, title: `${featureName} — Design Preview` }).catch(() => {})
      }
      await update(saveMsg)
      return
    }
    throw err
  }

  appendMessage(featureName, { role: "user", content: userMessage })

  // If patches were applied this turn, do a single preview upload now that all patches are done.
  // Individual patch calls saved to GitHub (skipSlackUpload=true) to avoid spamming the thread.
  if (patchAppliedThisTurn && lastGeneratedPreviewHtml) {
    client.files.uploadV2({
      channel_id: channelId,
      thread_ts: threadTs,
      content: lastGeneratedPreviewHtml,
      filename: `${featureName}.preview.html`,
      title: `${featureName} — Design Preview`,
    }).catch((uploadErr: any) => console.error(`[preview] post-patch Slack upload failed: ${uploadErr?.message}`))
  }

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

  // Platform enforcement: if there are [PM-GAP] findings from the design rubric and the agent
  // did NOT call offer_pm_escalation, auto-trigger escalation. Prompt rules are probabilistic —
  // this makes product gap escalation structurally deterministic regardless of agent prose choices.
  // [PM-GAP] is a rubric-level tag — it never appears in the design spec itself (root cause fix).
  const productFindings = designReadinessFindings.filter(f => f.issue.includes("[PM-GAP]"))
  const agentCalledEscalation = !!getPendingEscalation(featureName)
  console.log(`[ESCALATION] gate check for ${featureName}: productFindings=${productFindings.length}, agentCalledEscalation=${agentCalledEscalation}, toolCalls=${toolCallsOutDesign.map(t => t.name).join(",") || "none"}`)
  if (productFindings.length > 0 && !agentCalledEscalation) {
    console.log(`[ESCALATION] Gate 2 (N18) fired — productFindings:\n${productFindings.map(f => f.issue).join("\n")}`)
    const consolidated = productFindings.map((f, i) => `${i + 1}. ${f.issue}`).join("\n")
    setPendingEscalation(featureName, { targetAgent: "pm", question: consolidated, designContext: "", productSpec: context.approvedProductSpec ?? undefined })
    const assertionText = `Design cannot move forward until the PM closes these gaps. Say *yes* and I'll bring the PM into this thread now.`
    const escalationResponse = `${consolidated}\n\n${assertionText}`
    appendMessage(featureName, { role: "assistant", content: escalationResponse })
    await update(`${prefix}${escalationResponse}`)
    return
  }

  // Deterministic fallback escalation gate: agent correctly identified PM gaps in prose
  // ("say *yes*" + PM context appears) but did not call offer_pm_escalation.
  // Unlike the N18 gate above (which requires criterion 10 to generate [type: product] findings),
  // this gate is purely structural — it matches the agent's own controlled output pattern.
  // The agent's prose is preserved (not overridden); we only record the pending escalation
  // so the action menu is suppressed and the "yes" → PM flow can proceed.
  let gate3ClassifierRan = false
  if (!agentCalledEscalation) {
    const pmQuestions = extractPmEscalationFromAgentResponse(response)
    if (pmQuestions) {
      console.log(`[ESCALATION] Gate 3 (fallback prose) fired for ${featureName}`)
      console.log(`[ESCALATION] extracted questions:\n${pmQuestions}`)
      // Filter through classifier before storing — agent prose may include design/brand items
      // alongside real PM gaps. Only PM-scope items should reach the PM brief.
      const g3Classification = await classifyForPmGaps({
        agentResponse: pmQuestions,
        approvedProductSpec: context.approvedProductSpec ?? undefined,
      }).catch(() => ({ gaps: [] }))
      gate3ClassifierRan = true
      console.log(`[ESCALATION] Gate 3 classifier: ${g3Classification.gaps.length} PM gaps retained (${pmQuestions.split("\n").filter(l => l.trim()).length} lines extracted)`)
      if (g3Classification.gaps.length === 0) {
        // Classifier found no PM-scope gaps — the prose matched the extraction pattern but
        // the questions are design/brand/architecture concerns, not PM decisions. Drop it.
        // Gate 4 must also be skipped: re-classifying the same response with more noise would
        // risk LLM non-determinism overturning this correct suppression decision.
        console.log(`[ESCALATION] Gate 3 classifier: 0 PM gaps — suppressing escalation; Gate 4 skipped`)
      } else {
        const g3FilteredQuestion = g3Classification.gaps.length === 1
          ? g3Classification.gaps[0]
          : g3Classification.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")
        setPendingEscalation(featureName, { targetAgent: "pm", question: g3FilteredQuestion, designContext: "", productSpec: context.approvedProductSpec ?? undefined })
      }
    } else {
      console.log(`[ESCALATION] Gate 3 (fallback prose) — no pattern match`)
    }
  }

  // Haiku PM-gap classifier: catches prose responses that describe PM gaps without any
  // recognizable pattern (no numbered list, no CTA language, no "escalate to PM" phrasing).
  // Final safety net — only runs when all earlier gates passed and no escalation is set.
  // Skipped when the agent saved the spec (no PM gap prose to classify in a save response).
  // Fail-safe at call site: .catch returns empty gaps, never blocks the response.
  if (!agentCalledEscalation && !getPendingEscalation(featureName) && !didSave && !agentStillSeeking && !gate3ClassifierRan) {
    console.log(`[ESCALATION] Gate 4 (Haiku classifier) running for ${featureName}`)
    const classification = await classifyForPmGaps({
      agentResponse: response,
      approvedProductSpec: context.approvedProductSpec ?? undefined,
    }).catch(() => ({ gaps: [] }))
    console.log(`[ESCALATION] Gate 4 result: ${classification.gaps.length} gaps — ${classification.gaps.length === 0 ? "NONE" : classification.gaps.join(" | ")}`)
    if (classification.gaps.length > 0) {
      const consolidated = classification.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")
      setPendingEscalation(featureName, { targetAgent: "pm", question: consolidated, designContext: "", productSpec: context.approvedProductSpec ?? undefined })
    }
  } else {
    console.log(`[ESCALATION] Gate 4 (Haiku classifier) skipped — agentCalledEscalation=${agentCalledEscalation}, pendingAlreadySet=${!!getPendingEscalation(featureName)}, didSave=${didSave}, agentStillSeeking=${agentStillSeeking}, gate3ClassifierRan=${gate3ClassifierRan}`)
  }

  // If escalation was just offered this turn (via tool call, N18 gate, fallback prose-detection
  // gate, or Haiku classifier above), suppress the action menu — showing fixable design items
  // when the user cannot act on them until PM gaps close is actively misleading.
  const escalationJustOffered = !escalationBeforeRun && !!getPendingEscalation(featureName)

  // Platform-enforced assertive escalation text: when escalation was just offered this turn
  // (via tool call, N18 gate, or fallback prose-detection gate) but the agent's prose is passive
  // (asked a question instead of asserting the block), override with the assertive CTA.
  // "Assertive" means the prose already contains the required escalation language — "bring the PM"
  // or "Design cannot move forward" — in which case it is preserved. Passive prose ("Want me to
  // escalate?", "Would you like to call the PM?") is always overridden.
  // Scoped: only overrides PM escalation (not architect escalation, which has different language).
  const agentCalledPmEscalationTool = toolCallsOutDesign.some(t => t.name === "offer_pm_escalation")
  let finalResponse = response
  if (escalationJustOffered && (agentCalledPmEscalationTool || !agentCalledEscalation)) {
    // agentCalledPmEscalationTool: tool was explicitly called this turn (PM-specific)
    // !agentCalledEscalation: fallback gate fired (agent didn't call any escalation tool)
    const pending = getPendingEscalation(featureName)
    if (pending?.targetAgent === "pm") {
      // Always replace with the structured format — agent prose may say "bring the PM"
      // without listing the actual gaps, leaving the user without actionable content.
      const assertionText = `Design cannot move forward until the PM closes these gaps. Say *yes* and I'll bring the PM into this thread now.`
      finalResponse = `${pending.question}\n\n${assertionText}`
      console.log(`[ESCALATION] Override applied for ${featureName}. pending.question:\n${pending.question}`)
    }
  }

  appendMessage(featureName, { role: "assistant", content: finalResponse })

  // Platform-enforced structured action menu — built from EFFECTIVE audit data (post-patch
  // if the agent made patches this turn; pre-run otherwise). Effective variables are kept in
  // sync with the actual spec state, so the action menu reflects what actually remains rather
  // than stale pre-run findings that the agent may have already fixed.
  const actionMenu = escalationJustOffered ? "" : buildActionMenu([
    {
      emoji: ":art:",
      label: "Brand Drift",
      issues: [
        ...effectiveBrandDrifts.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
        ...effectiveAnimDrifts.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
      ],
    },
    {
      emoji: ":jigsaw:",
      label: "Missing Brand Tokens",
      issues: effectiveMissingTokens.map(m => ({ issue: `${m.token} not referenced in spec`, fix: `add with value \`${m.brandValue}\`` })),
    },
    {
      emoji: ":pencil:",
      label: "Design Issues",
      issues: [
        ...effectiveReadinessFindings.filter(f => !f.issue.includes("[PM-GAP]")).map(f => ({ issue: f.issue, fix: f.recommendation })),
        ...effectiveLlmQuality.map(splitQualityIssue),
      ],
    },
  ])

  // Platform status line: authoritative audit count prepended when items remain.
  // Structural condition (action menu non-empty) — no text-pattern detection of agent prose.
  // This ensures the platform's ground truth is always visible regardless of what the agent said.
  //
  // Suppression rule: suppress ONLY for PM escalations — user cannot act on design items until
  // PM gaps close, so showing a count with no action menu is misleading. For architect escalations,
  // the count stays visible: the arch question does not resolve all design gaps, and the agent
  // must not be able to claim "engineering-ready" when the rubric shows items remaining.
  const escalationJustOfferedPm = escalationJustOffered && getPendingEscalation(featureName)?.targetAgent === "pm"
  const totalEffectiveItems = effectiveBrandDrifts.length + effectiveAnimDrifts.length +
    effectiveMissingTokens.length + effectiveLlmQuality.length +
    effectiveReadinessFindings.filter(f => !f.issue.includes("[PM-GAP]")).length
  const platformStatusPrefix = (!escalationJustOfferedPm && totalEffectiveItems > 0)
    ? `_${totalEffectiveItems} item${totalEffectiveItems === 1 ? "" : "s"} to address before engineering handoff._\n\n`
    : ""

  await update(`${prefix}${platformStatusPrefix}${finalResponse}${uncommittedNote}${actionMenu}`)
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
        ? auditPhaseCompletion({ specContent: designSpecContentArch, rubric: buildDesignRubric(targetFormFactors), featureName, productVision: context.productVision, systemArchitecture: context.systemArchitecture, approvedProductSpec: pmSpecContentArch ?? undefined }).catch(() => null)
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

  // Inject ## Design Assumptions To Validate from engineering spec branch into architect's brief.
  // At engineering phase start, design finalization has seeded these — architect must confirm/override each.
  let designAssumptionsNotice = ""
  const engDraftForAssumptions = engDraftContent  // already fetched above for archReadinessNotice
  if (engDraftForAssumptions) {
    const assumptionsToValidate = extractHandoffSection(engDraftForAssumptions, "## Design Assumptions To Validate")
    if (assumptionsToValidate.trim()) {
      designAssumptionsNotice = `\n\n[PLATFORM DESIGN ASSUMPTIONS — The design team made the following assumptions that must be confirmed or overridden before the engineering spec is approved. For each: either confirm it inline in the spec (remove from this list) or call offer_upstream_revision(design) if the assumption is incorrect:\n${assumptionsToValidate}]`
    }
  }

  const enrichedUserMessageArch = buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsArch, priorContext: priorContextArch }) + upstreamNoticeArch + archReadinessNotice + designAssumptionsNotice
  const systemPrompt = buildArchitectSystemBlocks(context, featureName, readOnly)

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
        const allOpenQuestions = extractAllOpenQuestions(existingDraft)
        if (allOpenQuestions.length > 0) {
          return { error: `Approval blocked — ${allOpenQuestions.length} open question${allOpenQuestions.length > 1 ? "s" : ""} must be resolved first (blocking and non-blocking questions both block finalization):\n${allOpenQuestions.map(q => `• ${q}`).join("\n")}` }
        }
        // Structural gate: all Design Assumptions To Validate must be confirmed or overridden before engineering is approved
        const unconfirmedAssumptions = extractHandoffSection(existingDraft, "## Design Assumptions To Validate")
        if (unconfirmedAssumptions.trim()) {
          return { error: `Approval blocked — ## Design Assumptions To Validate contains unconfirmed items. Confirm each assumption or call offer_upstream_revision(design) to reject it before finalizing:\n${unconfirmedAssumptions}` }
        }
        let finalContent = existingDraft
        const [decisionAudit, engineerReadiness] = await Promise.all([
          auditSpecDecisions({ specContent: existingDraft, history: getHistory(featureName) }),
          auditDownstreamReadiness({ specContent: existingDraft, downstreamRole: "engineer", featureName }),
        ])
        if (decisionAudit.status === "corrections") {
          const { corrected } = applyDecisionCorrections(existingDraft, decisionAudit.corrections)
          finalContent = corrected
        }
        if (engineerReadiness.findings.length > 0) {
          const findingLines = engineerReadiness.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
          return { error: `Approval blocked — spec is not engineer-ready. An engineer receiving this spec would need to invent the following answers:\n${findingLines}\n\nResolve each before finalizing.` }
        }
        await update("_Saving final engineering spec..._")
        await saveApprovedEngineeringSpec({ featureName, filePath: archFilePath, content: finalContent })
        // Clear ## Design Assumptions from design spec on main (non-blocking)
        const designSpecFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design.md`
        clearHandoffSection({
          featureName,
          filePath: designSpecFilePath,
          sectionHeading: "## Design Assumptions",
        }).catch(err => console.log(`[ENG-FINALIZE] clearHandoffSection failed (non-blocking): ${err}`))
        const { githubOwner, githubRepo } = loadWorkspaceConfig()
        const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${archFilePath}`
        return { result: { url, nextPhase: "build" } }
      }
      if (name === "offer_upstream_revision") {
        const target = input.targetAgent as "pm" | "design"
        const question = input.question as string
        console.log(`[ESCALATION] offer_upstream_revision: targetAgent=${target} question="${question.slice(0, 100)}"`)
        setPendingEscalation(featureName, {
          targetAgent: target,
          question,
          designContext: "",
          engineeringContext: context.currentDraft ?? undefined,
        })
        return {
          result: `Upstream revision request stored (target: ${target}). The user will be prompted to confirm. If they say yes, the ${target === "design" ? "Designer" : "PM"} will be notified with your constraint.`,
        }
      }
      return { error: `Unknown tool: ${name}` }
    },
    toolCallsOut: toolCallsOutArch,
  })

  appendMessage(featureName, { role: "user", content: userMessage })
  appendMessage(featureName, { role: "assistant", content: response })
  await update(`${prefix}${response}`)
}
