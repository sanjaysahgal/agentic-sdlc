import { loadAgentContext, loadDesignAgentContext, loadArchitectAgentContext } from "../../../runtime/context-loader"
import { runAgent, UserImage, ToolCallRecord } from "../../../runtime/claude-client"
import { getHistory, getLegacyMessages, appendMessage, getConfirmedAgent, setConfirmedAgent, getPendingEscalation, setPendingEscalation, clearPendingEscalation, getPendingApproval, setPendingApproval, clearPendingApproval, getPendingDecisionReview, setPendingDecisionReview, clearPendingDecisionReview, getEscalationNotification, setEscalationNotification, clearEscalationNotification, isUserOriented, markUserOriented, getThreadAgent, setThreadAgent, Message } from "../../../runtime/conversation-store"
import { buildPmSystemPrompt, buildPmSystemBlocks, PM_TOOLS } from "../../../agents/pm"
import { buildDesignSystemPrompt, buildDesignSystemBlocks, buildDesignStateResponse, DESIGN_TOOLS } from "../../../agents/design"
import { buildArchitectSystemPrompt, buildArchitectSystemBlocks, ARCHITECT_TOOLS } from "../../../agents/architect"
import { createSpecPR, saveDraftSpec, saveApprovedSpec, saveDraftDesignSpec, saveApprovedDesignSpec, saveDraftEngineeringSpec, saveApprovedEngineeringSpec, saveDraftHtmlPreview, saveDraftAuditCache, readDraftAuditCache, getInProgressFeatures, readFile, preseedEngineeringSpec, seedHandoffSection, clearHandoffSection, updateApprovedSpecOnMain } from "../../../runtime/github-client"
import { classifyIntent, detectPhase, isOffTopicForAgent, isSpecStateQuery, AgentType } from "../../../runtime/agent-router"
import { withThinking } from "./thinking"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"
import { auditSpecDraft, auditSpecDecisions, applyDecisionCorrections, extractLockedDecisions, auditSpecRenderAmbiguity, filterDesignContent, auditRedundantBranding, auditCopyCompleteness, auditSpecStructure } from "../../../runtime/spec-auditor"
import { auditPhaseCompletion, auditDownstreamReadiness, PM_RUBRIC, PM_DESIGN_READINESS_RUBRIC, buildDesignRubric, ENGINEER_RUBRIC, ARCHITECT_UPSTREAM_PM_RUBRIC } from "../../../runtime/phase-completion-auditor"
import { auditBrandTokens, auditAnimationTokens, auditMissingBrandTokens } from "../../../runtime/brand-auditor"
import { auditPmSpec, auditPmDesignReadiness, auditDesignSpec, auditEngineeringSpec, detectHedgeLanguage } from "../../../runtime/deterministic-auditor"
import { verifyActionClaims } from "../../../runtime/action-verifier"
import { getPriorContext, buildEnrichedMessage, identifyUncommittedDecisions, generateSaveCheckpoint } from "../../../runtime/conversation-summarizer"
import { generateDesignPreview } from "../../../runtime/html-renderer"
import { extractBlockingQuestions, extractAllOpenQuestions, extractDesignAssumptions, extractHandoffSection, extractSpecTextLiterals } from "../../../runtime/spec-utils"
import { applySpecPatch } from "../../../runtime/spec-patcher"
import { classifyForPmGaps } from "../../../runtime/pm-gap-classifier"
import { classifyForArchGap } from "../../../runtime/arch-gap-classifier"
import { classifyFixIntent } from "../../../runtime/fix-intent-classifier"
import { patchProductSpecWithRecommendations } from "../../../runtime/pm-escalation-spec-writer"
import { patchDesignSpecWithRecommendations } from "../../../runtime/design-escalation-spec-writer"
import { patchEngineeringSpecWithDecision } from "../../../runtime/engineering-spec-decision-writer"
import { sanitizePmSpecDraft } from "../../../runtime/pm-spec-sanitizer"
import { handlePmTool, handleArchitectTool, handleDesignTool } from "../../../runtime/tool-handlers"
import type { ToolHandlerContext, PmToolDeps, ArchitectToolDeps, ArchitectToolState, DesignToolDeps, DesignToolCtx, DesignToolState } from "../../../runtime/tool-handlers"
import { featureKey, threadKey } from "../../../runtime/routing/types"
import { logShadowProposalForFeature } from "../../../runtime/routing/shadow"

const { paths: workspacePaths, targetFormFactors } = loadWorkspaceConfig()

// Per-feature flag: tracks which features have already received the context-summarization notice.
// Prevents spamming the user on every message after the history limit is reached.
const summarizationWarnedFeatures = new Set<string>()

// Per-feature in-flight lock — prevents concurrent agent runs for the same feature.
// When a Slack event arrives while an agent run is still processing (PM agents take 10s+),
// the second invocation is rejected immediately rather than running a second agent in parallel.
const featureInFlight = new Map<string, boolean>()

// Per-feature+user orientation tracking — first message from a userId in a feature
// suppresses audit notice injection so the agent can orient the newcomer without
// being compelled by "MUST surface" notices. Structural enforcement of Principle 8:
// the agent cannot dump gaps on orientation turns because it doesn't have them in context.
// Key: `${featureName}:${userId}` — set after first turn completes.
// orientedUsers moved to conversation-store.ts for persistence across restarts.
// Import isUserOriented/markUserOriented from there.

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
  // Match "fix 1 2 3", "fix 1, 2, 3", "fix 1-5", "fix 1-3 5 7-9", "fix 1, 3-5, 8"
  const indexMatch = trimmed.match(/^fix\s+([\d\s,\-]+)$/)
  if (indexMatch) {
    const parts = indexMatch[1].split(/[\s,]+/).filter(Boolean)
    const indices: number[] = []
    for (const part of parts) {
      const rangeMatch = part.match(/^(\d+)-(\d+)$/)
      if (rangeMatch) {
        const start = Number(rangeMatch[1])
        const end = Number(rangeMatch[2])
        if (start > 0 && end >= start && end - start < 100) {
          for (let i = start; i <= end; i++) indices.push(i)
        }
      } else {
        const n = Number(part)
        if (n > 0) indices.push(n)
      }
    }
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

/**
 * Single source of truth for routing — resolves the authoritative agent for a feature.
 *
 * Reads the feature phase from GitHub and maps it deterministically to the correct agent.
 * If the persisted `confirmedAgent` disagrees, it is corrected and the correction is logged.
 * Called at the top of every feature channel message — stale state is structurally impossible.
 *
 * @deterministic — same phase always maps to the same agent. No LLM, no heuristics.
 */
const PHASE_TO_AGENT: Record<string, string> = {
  "product-spec-in-progress": "pm",
  "product-spec-approved-awaiting-design": "ux-design",
  "design-in-progress": "ux-design",
  "design-approved-awaiting-engineering": "architect",
  "engineering-in-progress": "architect",
}

export async function resolveAgent(featureName: string, prefetchedPhase?: string): Promise<string> {
  // Phase 3 stage 2: callers can pass a pre-computed phase so the shadow runner
  // and resolveAgent share one getFeaturePhase call (test mocks use
  // mockResolvedValueOnce — duplicate calls cause production to see the
  // default-empty mock and route incorrectly).
  const phase = prefetchedPhase ?? await getFeaturePhase(featureName)
  const canonicalAgent = PHASE_TO_AGENT[phase] ?? "pm"
  const currentConfirmed = getConfirmedAgent(featureKey(featureName))

  // If no confirmed agent, set from phase (first message in this feature)
  if (!currentConfirmed) {
    console.log(`[ROUTER] resolveAgent: setting initial confirmedAgent=${canonicalAgent} for feature=${featureName} (phase=${phase})`)
    setConfirmedAgent(featureKey(featureName), canonicalAgent)
    return canonicalAgent
  }

  // If confirmed agent disagrees with phase AND the phase indicates advancement
  // (not the default "product-spec-in-progress"), correct it. The default phase
  // could mean "no branches found" (GitHub API issue or new feature) — in that
  // case, trust the existing confirmed agent.
  if (currentConfirmed !== canonicalAgent && phase !== "product-spec-in-progress") {
    console.log(`[ROUTER] resolveAgent: correcting stale confirmedAgent=${currentConfirmed} → ${canonicalAgent} for feature=${featureName} (phase=${phase})`)
    setConfirmedAgent(featureKey(featureName), canonicalAgent)
    return canonicalAgent
  }

  return currentConfirmed
}

// Handles messages in the design phase — routes to the UX Design agent.
// UPSTREAM READINESS GATE: before the design agent runs, check the PM spec
// deterministically. If findings exist, auto-escalate to PM with a categorized
// brief. The design agent's spec-writing tools are stripped until upstream is clean.
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
  readOnly?: boolean
}): Promise<void> {
  const { channelName, channelId, threadTs, featureName, userMessage, userImages, client, update, routingNote, readOnly } = params

  await runDesignAgent({ channelName, channelId, threadTs, featureName, userMessage, userImages, client, update, routingNote, readOnly })
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
  const { channelName, threadTs, userMessage: rawUserMessage, userImages, channelId, client, channelState, userId } = params
  const featureName = getFeatureName(channelName)

  // ─── ROUTING V2 SHADOW (Phase 3 Stage 2) ────────────────────────────────────
  // Compute the phase once at function entry and share it with both the
  // shadow runner and resolveAgent below. Sharing the call avoids consuming
  // a second slot in test mockResolvedValueOnce setups and keeps production
  // GitHub traffic identical to pre-shadow.
  // DESIGN-REVIEWED: phase fetch was already happening inside resolveAgent;
  // pulling it out keeps the call count at 1 per message. Goes away at
  // Phase 4 cutover when the new router becomes the single source of truth.
  let resolvedPhase: string | undefined
  try {
    resolvedPhase = await getFeaturePhase(featureName)
    logShadowProposalForFeature({ featureName, threadTs, rawText: rawUserMessage, user: userId, phase: resolvedPhase })
  } catch (err) {
    console.log(`[ROUTING-V2-SHADOW-ERROR] feature=${featureName} reason=${String(err).slice(0, 200)}`)
  }

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

  // ─── ROUTING AUTHORITY: resolveAgent() ────────────────────────────────────
  // Single source of truth for which agent handles this feature.
  // Reads GitHub phase, maps deterministically to agent, corrects stale state.
  // Called on EVERY message — stale confirmedAgent is structurally impossible.
  //
  // Exception: pending escalation recovery runs first — if the user is confirming
  // an escalation after a restart, we need to restore the originating agent before
  // resolveAgent corrects it to the phase agent.
  let confirmedAgent = getConfirmedAgent(featureKey(featureName))

  // Thread agent persistence: if a slash override previously set an agent for this thread,
  // follow-up messages in the same thread stay with that agent. This ensures /pm conversations
  // don't snap back to the phase agent after one message. Applies to all agents.
  const threadAgent = getThreadAgent(threadKey(threadTs))
  // KEYWORD-JUSTIFIED: matching @agent: prefix — machine-generated by slash command handler, not user prose
  if (threadAgent && !rawUserMessage.match(/^@(pm|design|architect)[:\s]/i)) {
    confirmedAgent = threadAgent
    console.log(`[ROUTER] thread-agent: continuing ${threadAgent} conversation in thread=${threadTs}`)
  }

  // Recovery: server restart clears in-memory confirmedAgent but pendingEscalation survives
  // in .conversation-state.json. If the user is affirming and a pending escalation exists,
  // restore confirmedAgent from the escalation's origin so the escalation-confirmation branch
  // runs correctly without requiring a new message from the user.
  if (!confirmedAgent && isAffirmative(rawUserMessage) && getPendingEscalation(featureKey(featureName))) {
    const recovered = getPendingEscalation(featureKey(featureName))!
    const validTargets = ["pm", "architect", "design"]
    if (!validTargets.includes(recovered.targetAgent)) {
      console.log(`[ROUTER] escalation-state-recovered: INVALID targetAgent="${recovered.targetAgent}" — clearing stale escalation for ${featureName}`)
      clearPendingEscalation(featureKey(featureName))
    } else {
      const recoveredAgent: string = recovered.targetAgent === "design" ? "architect" : "ux-design"
      confirmedAgent = recoveredAgent
      setConfirmedAgent(featureKey(featureName), recoveredAgent)
      console.log(`[ROUTER] escalation-state-recovered: restored confirmedAgent=${recoveredAgent} from persisted pendingEscalation targetAgent=${recovered.targetAgent} for feature=${featureName}`)
    }
  } else if (!threadAgent && !getPendingEscalation(featureKey(featureName)) && !getPendingApproval(featureKey(featureName))) {
    // No thread agent, no active escalation or approval — resolve from GitHub phase (single source of truth).
    // Skip during active escalation/approval/thread-agent flows to avoid overriding mid-flow state.
    confirmedAgent = await resolveAgent(featureName, resolvedPhase)
  }

  // Agent addressing: @pm, @design, @architect prefix overrides phase-based routing.
  // TEMPORARY override — routes this one message to the addressed agent without
  // persisting the change or wiping conversation history. The next unaddressed
  // message routes back to the phase-based agent.
  let userMessage = rawUserMessage
  const agentAddressMatch = rawUserMessage.match(/^@(pm|design|architect)[:\s]\s*([\s\S]*)$/i)
  if (agentAddressMatch) {
    const addressedAgent = agentAddressMatch[1].toLowerCase()
    const agentMap: Record<string, string> = { pm: "pm", design: "ux-design", architect: "architect" }
    const targetAgent = agentMap[addressedAgent]
    if (targetAgent) {
      if (targetAgent !== confirmedAgent) {
        console.log(`[ROUTER] agent-addressing: temporary override @${addressedAgent}, confirmedAgent=${confirmedAgent} stays (no phase transition)`)
      }
      confirmedAgent = targetAgent
      // Do NOT call setConfirmedAgent — that triggers phase transition and history wipe.
      // Instead, persist the override for THIS THREAD so follow-up messages stay with the
      // addressed agent. New threads resolve from GitHub phase as normal.
      setThreadAgent(threadKey(threadTs), targetAgent)
      userMessage = agentAddressMatch[2].trim() || rawUserMessage
    }
  }

  console.log(`[ROUTER] handleFeatureChannelMessage: feature=${featureName} confirmedAgent=${confirmedAgent ?? "(none)"} msg="${userMessage.slice(0, 100)}"`)

  // ─── UNIVERSAL PRE-ROUTING GUARDS ──────────────────────────────────────────
  // DESIGN-REVIEWED: Single guard layer scales to N agents — one code path, not per-agent checks.
  // Run on EVERY message regardless of which agent is confirmed.
  // Slash command overrides cannot bypass these.

  // Guard 1: Pending escalation — blocks ALL agents until resolved.
  const universalPending = getPendingEscalation(featureKey(featureName))
  if (universalPending && !isAffirmative(userMessage)) {
    const holderName = universalPending.targetAgent === "design"
      ? "Designer" : universalPending.targetAgent === "architect" ? "Architect" : "PM"
    const originPhase = universalPending.targetAgent === "design"
      ? "Engineering" : "Design"
    console.log(`[ROUTER] universal-guard: pending escalation hold — targetAgent=${universalPending.targetAgent}`)
    console.log(`[ROUTER] branch=hold-pending-escalation feature=${featureName} targetAgent=${universalPending.targetAgent}`)
    await client.chat.postMessage({
      channel: channelId, thread_ts: threadTs,
      text: `${originPhase} is paused — the ${holderName} needs to resolve a constraint:\n\n*"${universalPending.question}"*\n\nSay *yes* to bring the ${holderName} into this thread.`,
    })
    featureInFlight.delete(featureName)
    return
  }

  // Guard 2: Pending escalation + affirmative → restore confirmedAgent to originating agent
  // so the correct branch handles the confirmation flow.
  if (universalPending && isAffirmative(userMessage)) {
    const originAgent = universalPending.targetAgent === "design" ? "architect" : "ux-design"
    if (confirmedAgent !== originAgent) {
      console.log(`[ROUTER] universal-guard: restoring confirmedAgent=${confirmedAgent} → ${originAgent} for escalation confirmation`)
      confirmedAgent = originAgent
    }
  }

  // Guard 3: Slash override → read-only when past the agent's phase.
  // If addressed agent ≠ phase agent AND there's active downstream work, run read-only.
  // Exception: completed features (all specs on main, no active branches) get full tools.
  let slashOverrideReadOnly = false
  let slashOverrideContext = ""
  // KEYWORD-JUSTIFIED: matching @agent: prefix — machine-generated by slash command handler, not user prose
  const isSlashOverride = !!(agentAddressMatch || (threadAgent && !rawUserMessage.match(/^@(pm|design|architect)[:\s]/i)))
  if (isSlashOverride) {
    const phaseAgent = getConfirmedAgent(featureKey(featureName))
    if (phaseAgent && phaseAgent !== confirmedAgent) {
      slashOverrideReadOnly = true
      console.log(`[ROUTER] universal-guard: slash override ${confirmedAgent} in ${phaseAgent}-phase → read-only`)

      // Build phase-aware context so the agent knows it's a consultant, not the primary agent.
      const phaseLabels: Record<string, string> = { pm: "product spec", "ux-design": "design", architect: "engineering" }
      const agentLabels: Record<string, string> = { pm: "PM", "ux-design": "Designer", architect: "Architect" }
      const currentPhaseLabel = phaseLabels[phaseAgent] ?? phaseAgent
      const { githubOwner, githubRepo, paths: wsPaths } = loadWorkspaceConfig()
      const specPath = `${wsPaths.featuresRoot}/${featureName}/${featureName}.product.md`
      const specUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${specPath}`
      const designSpecUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${wsPaths.featuresRoot}/${featureName}/${featureName}.design.md`

      if (confirmedAgent === "pm") {
        slashOverrideContext = `\n\n[PLATFORM CONTEXT: You are running as a read-only consultant via /pm slash command. The feature "${featureName}" is currently in ${currentPhaseLabel} phase (the ${agentLabels[phaseAgent] ?? phaseAgent} is the active agent). Your product spec is already approved on main: ${specUrl}. You cannot edit the spec in this mode. Tell the user: (1) what phase the feature is in, (2) that the product spec is approved with a link, (3) offer to discuss any aspect or flag if they want to make changes.]`
      } else if (confirmedAgent === "ux-design") {
        slashOverrideContext = `\n\n[PLATFORM CONTEXT: You are running as a read-only consultant via /design slash command. The feature "${featureName}" is currently in ${currentPhaseLabel} phase (the ${agentLabels[phaseAgent] ?? phaseAgent} is the active agent). Your design spec is approved on main: ${designSpecUrl}. You cannot edit the spec in this mode. Tell the user: (1) what phase the feature is in, (2) that the design spec is approved with a link, (3) offer to discuss any aspect or flag if they want to make changes.]`
      } else if (confirmedAgent === "architect") {
        slashOverrideContext = `\n\n[PLATFORM CONTEXT: You are running as a read-only consultant via /architect slash command. The feature "${featureName}" is currently in ${currentPhaseLabel} phase. Engineering has not started yet. You cannot edit any specs in this mode. Tell the user: (1) what phase the feature is in, (2) that engineering hasn't started, (3) offer to discuss architecture questions.]`
      }
    }
  }
  if (slashOverrideContext) {
    userMessage = userMessage + slashOverrideContext
  }
  // ─── END UNIVERSAL PRE-ROUTING GUARDS ──────────────────────────────────────

  // Confirmed agent — check phase first, then run
  if (confirmedAgent === "ux-design") {
    // If the design agent offered a PM escalation last turn and the user is confirming it,
    // run the PM agent with the blocking question as its opening brief.
    const pendingEscalation = getPendingEscalation(featureKey(featureName))
    if (pendingEscalation && isAffirmative(userMessage)) {
      console.log(`[ROUTER] branch=pending-escalation-confirmed feature=${featureName} targetAgent=${pendingEscalation.targetAgent} question="${pendingEscalation.question.slice(0, 100)}"`)

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
          await runArchitectAgent({ channelName, channelId, threadTs, featureName, userMessage: brief, client, update: capturingUpdate, readOnly: true })
        } else {
          await runPmAgent({ channelName, channelId, threadTs, userMessage: brief, client, update: capturingUpdate, readOnly: true })
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
            await runPmAgent({ channelName, channelId, threadTs, userMessage: enforcementMessage, client, update: capturingUpdate, readOnly: true })
          }
        }
      }})
      // Clear after agent ran and output is captured — safe to commit now.
      clearPendingEscalation(featureKey(featureName))

      if (isArchitectEscalation) {
        // Architect is a human — hold for their reply before writing to the engineering spec.
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `${mention} — review the recommendations above and reply here to confirm or adjust. Once you reply, the design agent will use each confirmed recommendation to unblock and advance the design spec.`,
        })
        setEscalationNotification(featureKey(featureName), { targetAgent: "architect", question: pendingEscalation.question, recommendations: capturedAgentResponse || undefined, originAgent: "design" })
      } else {
        // PM recommendations require explicit human approval before spec is patched and design resumes.
        // Two-step pattern: PM runs → human says yes → spec patched → design resumes.
        // This matches the architect path and makes the "pending your approval" note in PM output honest.
        setEscalationNotification(featureKey(featureName), { targetAgent: "pm", question: comprehensiveQuestion, recommendations: capturedAgentResponse || undefined, originAgent: "design" })
      }
      return
    }
    // Pending escalation hold is handled by the universal pre-routing guard above.
    // If we reach here with a pending escalation, the user said "yes" and Guard 2
    // restored confirmedAgent to the originating agent — this branch handles confirmation.

    // Escalation notification active — the PM/Architect/Designer was @mentioned and is expected
    // to resolve blocking items before design resumes.
    // If the human sends a standalone confirmation (yes/approved/confirmed), design resumes.
    // If they send any other message — including partial approvals or follow-up requests —
    // the message routes back to the escalated agent (PM or Architect) for continued conversation.
    // This mirrors real-world behavior: once you're in a PM conversation, you stay in it until
    // you explicitly confirm and close it.
    const escalationNotification = getEscalationNotification(featureKey(featureName))
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
        // Invariant: approved spec lives on main. PM saved to a branch; apply to main before resuming.
        const PM_SAVE_TOOLS = ["save_product_spec_draft", "apply_product_spec_patch", "finalize_product_spec"]
        const pmDidSave = !isArchitectEscalation && continuationToolCalls.some(t => PM_SAVE_TOOLS.includes(t.name))
        if (pmDidSave) {
          console.log(`[ROUTER] branch=escalation-auto-close — PM saved spec this turn`)

          // Apply PM's branch changes to main — approved specs live on main.
          const pmBranch = `spec/${featureName}-product`
          const pmSpecPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
          const updatedPmSpec = await readFile(pmSpecPath, pmBranch).catch(() => null)
          if (updatedPmSpec) {
            const writebackOk = await updateApprovedSpecOnMain({
              filePath: pmSpecPath,
              content: updatedPmSpec,
              commitMessage: `[SPEC] ${featureName} · product.md — escalation fix applied`,
            }).then(() => true).catch((err: unknown) => { console.log(`[ESCALATION] auto-close writeback to main FAILED: ${err}`); return false })

            if (!writebackOk) {
              // Writeback failed — do NOT clear escalation; keep PM in the loop
              console.log(`[ESCALATION] auto-close: writeback failed — keeping escalation active for ${featureName}`)
              return
            }
            console.log(`[ESCALATION] auto-close: PM branch content applied to main for ${featureName}`)
            clearEscalationNotification(featureKey(featureName))

            // ─── RE-AUDIT AFTER WRITEBACK (Principle 14) ────────────────────────
            const { verifyEscalationResolution } = await import("../../../runtime/escalation-orchestrator")
            const reaudit = verifyEscalationResolution("pm", updatedPmSpec, "ux-design", targetFormFactors)
            if (!reaudit.ready && reaudit.escalationBrief) {
              console.log(`[ESCALATION] auto-close re-audit: PM spec still has ${reaudit.findings.length} finding(s) — re-escalating`)
              setPendingEscalation(featureKey(featureName), {
                targetAgent: "pm",
                question: reaudit.escalationBrief,
                designContext: "",
                productSpec: updatedPmSpec,
              })
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `*Product Manager* — Spec updated on main, but ${reaudit.findings.length} gap${reaudit.findings.length === 1 ? " remains" : "s remain"}. Say *yes* to bring the PM back.`,
              }).catch((err: unknown) => console.log(`[ESCALATION] re-audit message failed (non-blocking): ${err}`))
              return
            }
            // ─── END RE-AUDIT ───────────────────────────────────────────────────
          } else {
            // Branch read failed — PM saved but we can't read the content.
            // Clear escalation anyway — PM's work is done, resume design.
            console.log(`[ESCALATION] auto-close: could not read PM branch — clearing escalation and resuming`)
            clearEscalationNotification(featureKey(featureName))
          }

          // If the PM also called offer_architect_escalation this turn, surface it before resuming design.
          // Platform enforcement: the tool call is the signal — not prose. Principle 8.
          const archEscalationCall = continuationToolCalls.find(t => t.name === "offer_architect_escalation")
          if (archEscalationCall) {
            const archQuestion = archEscalationCall.input.question as string
            setPendingEscalation(featureKey(featureName), { targetAgent: "architect", question: archQuestion, designContext: "" })
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
        setEscalationNotification(featureKey(featureName), { ...escalationNotification, recommendations: preservedRecommendations })
        return
      }

      // Standalone confirmation — human is done talking to the PM/Architect. Resume design.
      const { roles } = loadWorkspaceConfig()
      const respondingRole = (isArchitectEscalation && roles.architectUser && userId === roles.architectUser)
        ? "Architect"
        : "PM"
      console.log(`[ROUTER] branch=escalation-reply targetAgent=${escalationNotification.targetAgent} respondingRole=${respondingRole} userId=${userId ?? "(none)"}`)

      // Write confirmed recommendations back to the appropriate spec:
      // - PM escalation → product spec (auditor won't re-discover same gaps)
      // - Architect escalation → engineering spec (decision captured before engineering begins)
      // NOTE: escalationNotification is cleared AFTER writeback succeeds — not before.
      if (escalationNotification.recommendations) {
        if (isArchitectEscalation) {
          await patchEngineeringSpecWithDecision({
            featureName,
            question: escalationNotification.question,
            decision: escalationNotification.recommendations,
          }).catch(err => console.log(`[ESCALATION] engineering spec writeback failed (non-blocking): ${err}`))
          clearEscalationNotification(featureKey(featureName))
        } else {
          const patchedSpec = await patchProductSpecWithRecommendations({
            featureName,
            question: escalationNotification.question,
            recommendations: escalationNotification.recommendations,
            humanConfirmation: userMessage,
          }).catch((err: unknown) => { console.log(`[ESCALATION] product spec writeback FAILED: ${err}`); return null })

          if (!patchedSpec) {
            // Writeback failed — keep escalation active, don't resume design
            console.log(`[ESCALATION] product spec writeback failed — keeping escalation active for ${featureName}`)
            return
          }
          clearEscalationNotification(featureKey(featureName))

          // ─── RE-AUDIT AFTER WRITEBACK (Principle 14) ────────────────────────
          // Deterministic re-audit: verify the patched PM spec is now clean.
          // If findings remain, trigger a new escalation brief instead of resuming design.
          if (patchedSpec) {
            const { verifyEscalationResolution } = await import("../../../runtime/escalation-orchestrator")
            const reaudit = verifyEscalationResolution("pm", patchedSpec, "ux-design", targetFormFactors)
            if (!reaudit.ready && reaudit.escalationBrief) {
              console.log(`[ESCALATION] re-audit: PM spec still has ${reaudit.findings.length} finding(s) after writeback — re-escalating`)
              setPendingEscalation(featureKey(featureName), {
                targetAgent: "pm",
                question: reaudit.escalationBrief,
                designContext: "",
                productSpec: patchedSpec,
              })
              await client.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: `*Product Manager* — Spec partially updated, but ${reaudit.findings.length} gap${reaudit.findings.length === 1 ? " remains" : "s remain"}. Say *yes* to bring the PM back.`,
              }).catch((err: unknown) => console.log(`[ESCALATION] re-audit message failed (non-blocking): ${err}`))
              return
            }
          }
          // ─── END RE-AUDIT ───────────────────────────────────────────────────
        }
      }

      // Clear notification if not already cleared (no-recommendations path)
      if (getEscalationNotification(featureKey(featureName))) clearEscalationNotification(featureKey(featureName))

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

    // resolveAgent() already verified ux-design is the correct agent for the current phase.
    // No phase-advance checks needed — stale state was corrected at the top.
    // DESIGN-REVIEWED: Parity with architect orientation — same pattern, no new context injection.
    // Orientation enforcement (Principle 15 parity with architect): first message from a userId
    // runs readOnly — designer orients without gap dump.
    const designIsOrientation = (userId && userId.length > 0) ? !isUserOriented(featureKey(featureName), userId) : false
    await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update, readOnly: designIsOrientation || slashOverrideReadOnly })
    }})
    if (designIsOrientation) {
      console.log(`[ROUTER] branch=confirmed-design-auto-continue feature=${featureName} — orientation done, running full-context turn`)
      await withThinking({ client, channelId, threadTs, agent: "UX Designer", run: async (update) => {
        await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage: "You already oriented the user in your previous message. Do NOT welcome them again or repeat orientation. Go straight to: review the spec chain, surface brand drift and design gaps, and present your design proposal.", userImages: [], client, update })
      }})
    }
    return
  }

  if (confirmedAgent === "architect") {
    // Upstream escalation: architect offered to escalate a constraint to PM or Designer.
    // Mirrors the design agent's pendingEscalation / escalationNotification pattern exactly.
    const archPendingEscalation = getPendingEscalation(featureKey(featureName))
    if (archPendingEscalation && isAffirmative(userMessage)) {
      const target = archPendingEscalation.targetAgent  // "pm" or "design"
      console.log(`[ROUTER] branch=arch-upstream-escalation-confirmed feature=${featureName} target=${target}`)
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
          await runPmAgent({ channelName, channelId, threadTs, userMessage: brief, client, update: capturingUpdate, readOnly: true })
        }
      }})
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: isDesignTarget
          ? `${mention} — the architect needs a design revision before engineering can proceed. Review the recommendations above and reply here to confirm or adjust. Once you reply, the architect will resume with your decision applied.`
          : `${mention} — the architect needs a product decision before engineering can proceed. Review the recommendations above and reply here to confirm or adjust. Once you reply, the architect will resume with your decision applied.`,
      })
      clearPendingEscalation(featureKey(featureName))
      setEscalationNotification(featureKey(featureName), { targetAgent: target, question: archPendingEscalation.question, recommendations: capturedResponse || undefined, originAgent: "architect" })
      return
    }
    // Pending escalation hold is handled by the universal pre-routing guard above.

    // Upstream revision reply — Designer or PM is responding to architect's upstream escalation.
    // If standalone confirmation → resume architect. Otherwise → continue the conversation with
    // the design/PM agent, keeping the notification active until the human explicitly confirms.
    const archEscalationNotification = getEscalationNotification(featureKey(featureName))
    if (archEscalationNotification && archEscalationNotification.originAgent === "architect") {
      const archNotifTarget = archEscalationNotification.targetAgent
      const archNotifAgentLabel = archNotifTarget === "design" ? "UX Designer" : "Product Manager"

      if (!isStandaloneConfirmation(userMessage)) {
        // Human continues the conversation with the Designer or PM — keep notification active.
        // readOnly: true — the PM/Designer can discuss and recommend but cannot patch specs,
        // escalate, or offer to finalize. This is an escalation response, not a full agent session.
        console.log(`[ROUTER] branch=arch-upstream-continuation feature=${featureName} target=${archNotifTarget} msg="${userMessage.slice(0, 80)}"`)
        let updatedRecommendations = ""
        await withThinking({ client, channelId, threadTs, agent: archNotifAgentLabel, run: async (update) => {
          const capturingUpdate = async (text: string) => { updatedRecommendations = text; await update(text) }
          if (archNotifTarget === "design") {
            // Design escalation continuation — design agent handles its own tool scoping
            await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages: [], client, update: capturingUpdate })
          } else {
            // PM escalation continuation — readOnly prevents the PM from patching specs,
            // escalating new items, or offering to finalize. Answer the question only.
            await runPmAgent({ channelName, channelId, threadTs, userMessage, client, update: capturingUpdate, readOnly: true })
          }
        }})
        setEscalationNotification(featureKey(featureName), { ...archEscalationNotification, recommendations: updatedRecommendations || archEscalationNotification.recommendations })
        return
      }

      // Standalone confirmation — resume architect with injected revision.
      console.log(`[ROUTER] branch=arch-upstream-revision-reply feature=${featureName} target=${archNotifTarget}`)
      // Write the decision to BOTH the engineering spec AND the upstream spec.
      // Engineering spec: records the decision so the architect has it.
      // Upstream spec (product or design): applies the PM/designer's recommendation
      // so the approved spec on main reflects the confirmed change.
      if (archEscalationNotification.recommendations) {
        // Write to engineering spec (non-blocking)
        await patchEngineeringSpecWithDecision({
          featureName,
          question: archEscalationNotification.question,
          decision: archEscalationNotification.recommendations,
        }).catch(err => console.log(`[ESCALATION] engineering spec writeback failed (non-blocking): ${err}`))

        // Write to upstream spec — product spec for PM escalations, design spec for design escalations
        // Capture the patched spec for re-audit below.
        let patchedUpstreamSpec: string | null = null
        if (archNotifTarget === "pm") {
          patchedUpstreamSpec = await patchProductSpecWithRecommendations({
            featureName,
            question: archEscalationNotification.question,
            recommendations: archEscalationNotification.recommendations,
            humanConfirmation: userMessage,
          }).catch((err: unknown) => { console.log(`[ESCALATION] product spec writeback failed (non-blocking): ${err}`); return null })
          console.log(`[ESCALATION] product spec patched with confirmed PM recommendation for ${featureName}`)
        }
        if (archNotifTarget === "design") {
          patchedUpstreamSpec = await patchDesignSpecWithRecommendations({
            featureName,
            question: archEscalationNotification.question,
            recommendations: archEscalationNotification.recommendations,
            humanConfirmation: userMessage,
          }).catch((err: unknown) => { console.log(`[ESCALATION] design spec writeback failed (non-blocking): ${err}`); return null })
          console.log(`[ESCALATION] design spec patched with confirmed Designer recommendation for ${featureName}`)
        }

        // If upstream writeback failed entirely, keep escalation active
        if (!patchedUpstreamSpec) {
          console.log(`[ESCALATION] upstream spec writeback failed — keeping escalation active for ${featureName}`)
          return
        }

        // ─── RE-AUDIT AFTER WRITEBACK (Principle 14) ────────────────────────
        // Deterministic re-audit: verify the patched upstream spec is now clean.
        // If findings remain, trigger a new escalation brief instead of resuming architect.
        if (patchedUpstreamSpec && archNotifTarget) {
          const { verifyEscalationResolution } = await import("../../../runtime/escalation-orchestrator")
          const blockingSpec = archNotifTarget as "pm" | "design"
          const reaudit = verifyEscalationResolution(blockingSpec, patchedUpstreamSpec, "architect", targetFormFactors)
          if (!reaudit.ready && reaudit.escalationBrief) {
            const targetLabel = blockingSpec === "pm" ? "PM" : "Design"
            console.log(`[ESCALATION] re-audit: ${targetLabel} spec still has ${reaudit.findings.length} finding(s) after writeback — re-escalating`)
            setPendingEscalation(featureKey(featureName), {
              targetAgent: blockingSpec,
              question: reaudit.escalationBrief,
              designContext: "",
              productSpec: blockingSpec === "pm" ? patchedUpstreamSpec : undefined,
            })
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `*${targetLabel === "PM" ? "Product Manager" : "Designer"}* — Spec partially updated, but ${reaudit.findings.length} gap${reaudit.findings.length === 1 ? " remains" : "s remain"}. Say *yes* to bring the ${targetLabel} agent back.`,
            }).catch((err: unknown) => console.log(`[ESCALATION] re-audit message failed (non-blocking): ${err}`))
            clearEscalationNotification(featureKey(featureName))
            return
          }
        }
        // ─── END RE-AUDIT ───────────────────────────────────────────────────
      }

      // Closure message — confirm to user that the upstream spec was updated
      const respondingRole = archNotifTarget === "design" ? "Designer" : "PM"
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `*${respondingRole}* — ${respondingRole === "PM" ? "Product" : "Design"} spec updated with the confirmed decision. The architect will resume.`,
      }).catch(err => console.log(`[ESCALATION] closure message failed (non-blocking): ${err}`))

      clearEscalationNotification(featureKey(featureName))
      const injectedMessage = `${respondingRole} resolved the upstream constraint: "${archEscalationNotification.question}" → "${userMessage}". The upstream spec has been revised. Resume engineering spec development with this revision applied — update the affected sections and continue.`
      await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
        await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage: injectedMessage, userImages: [], client, update })
      }})
      return
    }
    console.log(`[ROUTER] branch=confirmed-architect feature=${featureName}`)
    // Orientation enforcement (Principle 8): first message from a userId in this feature
    // runs readOnly — architect orients without spec content, can't dump gaps.
    // The orientation key is also computed inside runArchitectAgent for notice suppression.
    const archIsOrientation = (userId && userId.length > 0) ? !isUserOriented(featureKey(featureName), userId) : false
    await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
      await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update, userId, readOnly: archIsOrientation || slashOverrideReadOnly })
    }})
    // Auto-continue: after orientation, immediately run the full-context turn so the
    // user doesn't have to send a second message. One user message → orientation + proposal.
    if (archIsOrientation) {
      console.log(`[ROUTER] branch=confirmed-architect-auto-continue feature=${featureName} — orientation done, running full-context turn`)
      await withThinking({ client, channelId, threadTs, agent: "Architect", run: async (update) => {
        await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage: "You already oriented the user in your previous message. Do NOT welcome them again or repeat orientation. Go straight to: review the full spec chain, surface any upstream gaps with escalation tool calls, and present your structural proposal for the engineering spec.", client, update, userId })
      }})
    }
    return
  }

  if (confirmedAgent === "pm") {
    // resolveAgent() already verified this is the correct agent for the current phase.
    // No phase-advance checks needed — stale state was corrected at the top.
    console.log(`[ROUTER] branch=confirmed-pm feature=${featureName}${slashOverrideReadOnly ? " (read-only slash override)" : ""}`)
    await withThinking({ client, channelId, threadTs, agent: "Product Manager", run: async (update) => {
      await runPmAgent({ channelName, channelId, threadTs, userMessage, userImages, client, update, readOnly: slashOverrideReadOnly })
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
      setConfirmedAgent(featureKey(featureName), "ux-design")
      await handleDesignPhase({ channelId, threadTs, channelName, featureName: getFeatureName(channelName), userMessage, userImages, client, update })
      return
    }

    if (currentPhase === "design-approved-awaiting-engineering" || currentPhase === "engineering-in-progress") {
      console.log(`[ROUTER] branch=new-thread-architect feature=${featureName}`)
      setConfirmedAgent(featureKey(featureName), "architect")
      await runArchitectAgent({ channelName, channelId, threadTs, featureName: getFeatureName(channelName), userMessage, userImages, client, update, userId })
      return
    }

    const phase = detectPhase({
      productSpecApproved: channelState.productSpecApproved,
      engineeringSpecApproved: channelState.engineeringSpecApproved,
    })
    const history = getHistory(featureKey(featureName))
    const suggestedAgent = await classifyIntent({ message: userMessage, history, phase })

    setConfirmedAgent(featureKey(featureName), suggestedAgent)

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
  const pendingApproval = getPendingApproval(featureKey(featureName))
  if (pendingApproval && pendingApproval.specType === "product") {
    console.log(`[ROUTER] runPmAgent: pending product approval found for feature=${featureName}`)
    if (isAffirmative(userMessage)) {
      // Re-fetch spec from branch to detect stale cached content
      const freshContent = await readFile(pendingApproval.filePath, `spec/${featureName}-product`).catch(() => null)
      if (freshContent && freshContent !== pendingApproval.specContent) {
        console.log(`[ROUTER] runPmAgent: spec content changed since approval was offered — warning user`)
        clearPendingApproval(featureKey(featureName))
        await update("The spec has been modified since the approval was offered. Please review the current version and say *approve* again when ready.")
        return
      }
      clearPendingApproval(featureKey(featureName))
      await update("_Saving the final product spec..._")
      await saveApprovedSpec({ featureName, filePath: pendingApproval.filePath, content: pendingApproval.specContent })
      const approvalMessage =
        `The *${featureName}* product spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `A UX designer produces the screens and user flows before any engineering begins. ` +
        `If you're wearing the designer hat on this one, just say so right here and the design phase will begin.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(featureKey(featureName))
      // Not confirming — fall through to normal agent flow
    }
  }

  await update("_Product Manager is reading the spec..._")
  const historyPm = getHistory(featureKey(featureName))
  const PM_HISTORY_LIMIT = 40
  // When called via escalation (readOnly=true), skip history-dependent enrichment.
  // The brief is self-contained; prior-phase history adds hallucination risk.
  const [context, lockedDecisionsPm, priorContextPm] = await Promise.all([
    loadAgentContext(featureName),
    readOnly ? "" : extractLockedDecisions(historyPm).catch(() => ""),
    readOnly ? "" : getPriorContext(featureName, historyPm, PM_HISTORY_LIMIT),
  ])
  const enrichedUserMessagePm = readOnly
    ? userMessage  // escalation brief is already complete
    : buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsPm, priorContext: priorContextPm })

  // Product-level questions (vision, architecture, principles) in feature channels:
  // The PM answers from its full prompt with feature context — it already has the vision loaded.
  // For deep product-level discussions, use /pm in the general channel.
  // (The product-context bypass was removed because it used a minimal prompt without
  // the PM's formatting rules, causing inconsistent output.)

  const systemPrompt = buildPmSystemBlocks(context, featureName, readOnly, approvedSpecContext)

  await update("_Product Manager is thinking..._")

  const pmFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
  const prefix = routingNote ? `${routingNote}\n\n` : ""
  const toolCallsOutPm: ToolCallRecord[] = []

  // When called via escalation (readOnly=true), pass EMPTY history. The escalation brief
  // contains everything the PM needs. Prior-phase conversation history causes hallucination
  // ("discussions not committed to GitHub"). Same fix as architect pre-run gate.
  const effectiveHistoryPm = readOnly ? [] : historyPm

  let response = await runAgent({
    systemPrompt,
    history: effectiveHistoryPm,
    userMessage: enrichedUserMessagePm,
    userImages,
    tools: readOnly ? undefined : PM_TOOLS,
    toolHandler: readOnly ? undefined : (name, input) => handlePmTool(name, input, {
      featureName,
      specFilePath: pmFilePath,
      specBranchName: `spec/${featureName}-product`,
      context,
      update,
      readFile: (path, branch) => readFile(path, branch),
      getHistory: () => getHistory(featureKey(featureName)),
      loadWorkspaceConfig,
    }, {
      sanitizePmSpecDraft,
      auditSpecDraft,
      saveDraftSpec,
      saveApprovedSpec,
      applySpecPatch,
      extractAllOpenQuestions,
      extractHandoffSection,
      auditPhaseCompletion,
      auditDownstreamReadiness,
      auditSpecDecisions,
      applyDecisionCorrections,
      PM_RUBRIC,
      PM_DESIGN_READINESS_RUBRIC,
    }),
    toolCallsOut: toolCallsOutPm,
  })

  // Expose collected tool calls to caller if requested (e.g. to detect spec saves in continuation path)
  if (callerToolCallsOut) callerToolCallsOut.push(...toolCallsOutPm)

  // ─── POST-RUN: Universal hedge detection (Principle 11 — deterministic) ────
  // Same pattern as architect. PM has no escalation-offered state (root agent).
  if (!readOnly) {
    const hedges = detectHedgeLanguage(response)
    if (hedges.length > 0) {
      console.log(`[HEDGE-GATE] pm: detected ${hedges.length} deferral phrase(s): ${hedges.join(", ")}`)
      const lines = response.trim().split("\n")
      while (lines.length > 0 && lines[lines.length - 1].trim().endsWith("?")) {
        lines.pop()
      }
      response = lines.join("\n") + "\n\nI'll proceed with the approach outlined above."
    }
  }
  // ─── END HEDGE GATE ─────────────────────────────────────────────────────────

  // ─── POST-RUN: Action verification (Principle 8) ───────────────────────────
  // Verify agent prose claims match actual tool calls. Strip false claims.
  if (!readOnly) {
    response = verifyActionClaims(response, toolCallsOutPm)
  }
  // ─── END ACTION VERIFICATION ──────────────────────────────────────────────

  appendMessage(featureKey(featureName), { role: "user", content: userMessage })
  appendMessage(featureKey(featureName), { role: "assistant", content: response })
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
  const pendingDesignApproval = getPendingApproval(featureKey(featureName))
  if (pendingDesignApproval && pendingDesignApproval.specType === "design") {
    console.log(`[ROUTER] runDesignAgent: pending design approval found for feature=${featureName}`)
    if (isAffirmative(userMessage)) {
      // Re-fetch spec from branch to detect stale cached content
      const freshDesign = await readFile(pendingDesignApproval.filePath, `spec/${featureName}-design`).catch(() => null)
      if (freshDesign && freshDesign !== pendingDesignApproval.specContent) {
        console.log(`[ROUTER] runDesignAgent: spec content changed since approval was offered — warning user`)
        clearPendingApproval(featureKey(featureName))
        await update("The design spec has been modified since the approval was offered. Please review the current version and say *approve* again when ready.")
        return
      }
      clearPendingApproval(featureKey(featureName))
      await update("_Saving the final design spec..._")
      await saveApprovedDesignSpec({ featureName, filePath: pendingDesignApproval.filePath, content: pendingDesignApproval.specContent })
      const approvalMessage =
        `The *${featureName}* design spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `A software architect produces the engineering plan before any code is written. ` +
        `If you're wearing the architect hat on this one, just say so right here and the engineering phase will begin.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(featureKey(featureName))
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
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: msg })
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
          const pmSpecForAudit = await readFile(`${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`, "main").catch(() => null)
          const specAudit = await auditSpecDraft({ draft: draftContent, productVision: pvContent, systemArchitecture: saContent, featureName, productSpec: pmSpecForAudit ?? undefined }).catch(() => ({ status: "ok" as const, message: "" }))
          specGap = specAudit.status === "gap" ? specAudit.message : null
        }
      }

      const threadHistory = getHistory(featureKey(featureName))
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
      // Deterministic structural checks — convergence floor for state query
      const stateStructuralFindings = draftContent ? auditSpecStructure(draftContent, "design") : []

      let stateQualityIssues: string[] = []
      if (draftContent) {
        const stateQCacheKey = `render-ambiguity:${featureName}:${specFingerprint(draftContent)}`
        const auditCacheFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design-audit.json`
        const fp = specFingerprint(draftContent)
        // 3-tier cache lookup for render ambiguity
        if (renderAmbiguitiesCache.has(stateQCacheKey)) {
          stateQualityIssues = renderAmbiguitiesCache.get(stateQCacheKey)!
        } else {
          const persistedCache = await readDraftAuditCache({ featureName, filePath: auditCacheFilePath, expectedFingerprint: fp }).catch(() => null)
          if (persistedCache?.renderAmbiguity) {
            stateQualityIssues = persistedCache.renderAmbiguity
            renderAmbiguitiesCache.set(stateQCacheKey, persistedCache.renderAmbiguity)
          } else {
            stateQualityIssues = await auditSpecRenderAmbiguity(draftContent, { formFactors: targetFormFactors }).catch(() => [] as string[])
            renderAmbiguitiesCache.set(stateQCacheKey, stateQualityIssues)
            saveDraftAuditCache({ featureName, filePath: auditCacheFilePath, content: { specFingerprint: fp, renderAmbiguity: stateQualityIssues } }).catch(() => {})
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
          // Try persistent GitHub cache for readiness findings
          const auditCacheFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design-audit.json`
          const persistedCache = await readDraftAuditCache({ featureName, filePath: auditCacheFilePath, expectedFingerprint: dfp }).catch(() => null)
          if (persistedCache?.readiness) {
            readinessFindingsState = persistedCache.readiness
          } else {
            // Principle 11: deterministic audit is the PRIMARY gate.
            const deterministicDesign = auditDesignSpec(draftContent, { targetFormFactors })
            // LLM rubric as @enrichment (parallel, additive findings)
            const llmResult = await auditPhaseCompletion({
              specContent: draftContent,
              rubric: buildDesignRubric(targetFormFactors),
              featureName,
              productVision: pvContent,
              systemArchitecture: saContent,
              approvedProductSpec: approvedPmSpecContent,
            }).catch(() => null)
            // Merge: deterministic floor + LLM enrichment
            const mergedFindings: Array<{ issue: string; recommendation: string }> = [
              ...deterministicDesign.findings.map(f => ({ issue: f.issue, recommendation: f.recommendation })),
            ]
            if (llmResult && !llmResult.ready) {
              for (const lf of llmResult.findings) {
                const isDuplicate = mergedFindings.some(df => df.issue.toLowerCase().includes(lf.issue.slice(0, 40).toLowerCase()))
                if (!isDuplicate) mergedFindings.push(lf)
              }
            }
            readinessFindingsState = mergedFindings
            // Persist readiness findings — non-blocking
            saveDraftAuditCache({ featureName, filePath: auditCacheFilePath, content: { specFingerprint: dfp, readiness: readinessFindingsState } }).catch(() => {})
          }
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
            ...stateStructuralFindings.map(f => ({ issue: `[STRUCTURAL] ${f.issue}`, fix: f.recommendation })),
            ...readinessFindingsState.map(f => ({ issue: f.issue, fix: f.recommendation })),
            ...stateQualityIssues.map(splitQualityIssue),
          ],
        },
      ])

      const stateOpenItemCount = stateStructuralFindings.length + brandDrifts.length + animationDrifts.length + missingTokensState.length +
        stateQualityIssues.length + readinessFindingsState.length
      const msg = buildDesignStateResponse({ featureName, draftContent, specUrl, previewNote, specGap, uncommittedDecisions, openItemCount: stateOpenItemCount })
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: msg })
      await update(msg + stateActionMenu)
      return
    }

  }

  await update("_UX Designer is reading the spec and design context..._")
  const historyDesign = getHistory(featureKey(featureName))
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
  // Principle 11: deterministic audit is the PRIMARY gate (same input = same output).
  // LLM rubric runs in parallel as @enrichment — additional findings only, never the sole gate.
  // Content-addressed cache on the combined result (deterministic + enrichment).
  let upstreamNoticeDesign = ""
  const pmSpecPath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.product.md`
  const pmSpecContent = await readFile(pmSpecPath, "main").catch(() => null)

  if (pmSpecContent) {
    const fp = specFingerprint(pmSpecContent)
    const cacheKey = `design:${featureName}:${fp}`
    if (phaseEntryAuditCache.has(cacheKey)) {
      upstreamNoticeDesign = phaseEntryAuditCache.get(cacheKey)!
    } else {
      // Primary: deterministic audit (instant, no API call)
      const deterministicResult = auditPmSpec(pmSpecContent)
      // Enrichment: LLM rubric (parallel, may find semantic gaps the parser misses)
      const llmResult = await auditPhaseCompletion({
        specContent: pmSpecContent,
        rubric: PM_RUBRIC,
        featureName,
        productVision: context.productVision,
        systemArchitecture: context.systemArchitecture,
      }).catch(() => null)
      // Merge: deterministic findings are the floor, LLM findings are additive (deduplicated)
      const allFindings = [...deterministicResult.findings.map(f => ({ issue: f.issue, recommendation: f.recommendation }))]
      if (llmResult && !llmResult.ready) {
        for (const lf of llmResult.findings) {
          // Only add LLM findings that don't duplicate a deterministic finding
          const isDuplicate = allFindings.some(df => df.issue.toLowerCase().includes(lf.issue.slice(0, 40).toLowerCase()))
          if (!isDuplicate) allFindings.push(lf)
        }
      }
      if (allFindings.length > 0) {
        const findingLines = allFindings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        upstreamNoticeDesign = `\n\n[INTERNAL — You found ${allFindings.length} gap${allFindings.length === 1 ? "" : "s"} in the approved PM spec that must be surfaced to the user before proceeding. Present these as YOUR findings, never as "the platform's":\n${findingLines}\nYou MUST surface these gaps prominently in your response and recommend returning to the PM agent to address them before the design phase continues.]`
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

  // Deterministic structural checks — convergence floor (no LLM, same input = same output always).
  // These findings are always present regardless of LLM rubric non-determinism.
  const structuralFindings = designDraftContent
    ? auditSpecStructure(designDraftContent, "design")
    : []

  // Deterministic design quality checks — zero LLM cost, run on every response when draft exists.
  // Uses designDraftContent (fetched above from the spec branch) — NOT context.currentDraft which
  // may be empty if the draft is only on a feature branch and not yet committed to main.
  const redundantBrandingIssues = designDraftContent ? auditRedundantBranding(designDraftContent) : []
  const copyCompletenessIssues = designDraftContent ? auditCopyCompleteness(designDraftContent) : []
  const qualityIssues = [...redundantBrandingIssues, ...copyCompletenessIssues]

  // Use cached LLM render ambiguities — same 3-tier lookup as state query path:
  // 1. In-memory cache (same process, same spec version)
  // 2. Persistent GitHub cache (survives restarts — {feature}.design-audit.json on design branch)
  // 3. Falls back to deterministic-only qualityIssues (no LLM call on fix-all path)
  // CRITICAL: Without the persistent cache check, bot restarts cause allActionItems to drop
  // from 27 to 9 — the user's item numbers no longer match the platform's list.
  let preRunLlmQuality: string[] = qualityIssues
  if (designDraftContent) {
    const fp = specFingerprint(designDraftContent)
    const cacheKey = `render-ambiguity:${featureName}:${fp}`
    const inMemory = renderAmbiguitiesCache.get(cacheKey)
    if (inMemory) {
      preRunLlmQuality = inMemory
    } else {
      const auditCacheFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design-audit.json`
      const persisted = await readDraftAuditCache({ featureName, filePath: auditCacheFilePath, expectedFingerprint: fp }).catch(() => null)
      if (persisted?.renderAmbiguity) {
        preRunLlmQuality = persisted.renderAmbiguity
        renderAmbiguitiesCache.set(cacheKey, persisted.renderAmbiguity)
      }
    }
  }

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
      // Try persistent GitHub cache for readiness findings
      const readinessCacheFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.design-audit.json`
      const persistedReadiness = await readDraftAuditCache({ featureName, filePath: readinessCacheFilePath, expectedFingerprint: dfp }).catch(() => null)
      if (persistedReadiness?.readiness && persistedReadiness.readiness.length > 0) {
        designReadinessFindings = persistedReadiness.readiness
        const productFindingsPreRun = designReadinessFindings.filter(f => f.issue.includes("[PM-GAP]"))
        console.log(`[ESCALATION] Gate 1 (pre-run audit, cached) for ${featureName}: ${designReadinessFindings.length} total findings, ${productFindingsPreRun.length} [PM-GAP]`)
        if (productFindingsPreRun.length > 0) {
          console.log(`[ESCALATION] Gate 1 [PM-GAP] findings:\n${productFindingsPreRun.map(f => f.issue).join("\n")}`)
        }
        const findingLines = designReadinessFindings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        designReadinessNotice = `\n\n[DESIGN REVIEW — ${designReadinessFindings.length} gap${designReadinessFindings.length === 1 ? "" : "s"} blocking engineering handoff. These are displayed to the user in a structured block — DO NOT restate or list them in your response. Do NOT ask clarifying questions — your recommendation for each is stated. Do NOT reference "the platform" in your response; speak as the UX Designer throughout. For product gaps, escalate to the PM. For architecture gaps, escalate to the Architect. For design gaps you own, fix them when the user asks. Keep your prose to ≤2 sentences.\n${findingLines}]`
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
        // Persist readiness findings — non-blocking
        saveDraftAuditCache({ featureName, filePath: readinessCacheFilePath, content: { specFingerprint: dfp, readiness: designReadinessFindings } }).catch(() => {})
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
        // Persist empty readiness (ready=true means 0 findings)
        saveDraftAuditCache({ featureName, filePath: readinessCacheFilePath, content: { specFingerprint: dfp, readiness: [] } }).catch(() => {})
      }
      } // close persistent cache else
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
    // Deterministic structural findings FIRST — convergence floor, always stable
    ...structuralFindings.map(f => ({ issue: `[STRUCTURAL] ${f.issue}`, fix: f.recommendation })),
    ...brandDriftsDesign.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
    ...animDriftsDesign.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
    ...missingTokensDesign.map(m => ({ issue: `${m.token} not referenced in spec`, fix: `add with value \`${m.brandValue}\`` })),
    ...preRunLlmQuality.map(splitQualityIssue),
    ...designReadinessFindings.map(f => ({ issue: f.issue, fix: f.recommendation })),
  ]
  console.log(`[FIX-INTENT] allActionItems=${allActionItems.length} (structural=${structuralFindings.length} brand=${brandDriftsDesign.length} anim=${animDriftsDesign.length} missing=${missingTokensDesign.length} quality=${preRunLlmQuality.length} readiness=${designReadinessFindings.length})`)
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
  const escalationBeforeRun = getPendingEscalation(featureKey(featureName))

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
  // "approve/approved/finalize" messages must always have finalize_design_spec available.
  // But "approving fixes for 2, 3, 5" is a fix intent, not an approval — exclude when numbers follow.
  const isApprovalIntent = /\b(approv|finaliz)/i.test(userMessage) && !/\b(fix|fixes)\b/i.test(userMessage)
  const specWriteAllowed = !draftExistsWithOpenItems || fixIntent.isFixAll || isApprovalIntent
  // When write-gated: strip all save tools EXCEPT finalize_design_spec (approval path)
  const writeGatedTools = DESIGN_TOOLS.filter(t =>
    !designSaveTools.includes(t.name) || t.name === "finalize_design_spec"
  )
  const designToolsNormalPath = specWriteAllowed
    ? DESIGN_TOOLS
    : writeGatedTools
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

  // Design tool handler — extracted to runtime/tool-handlers.ts for unit testability.
  // Mutable state passed by reference so the caller can observe mutations (patchAppliedThisTurn).
  const designToolState: DesignToolState = { patchAppliedThisTurn: false, lastGeneratedPreviewHtml: null }
  const designToolCtx: DesignToolCtx = {
    featureName,
    specFilePath: designFilePath,
    specBranchName: designBranchName,
    context,
    update,
    readFile,
    getHistory: () => getHistory(featureKey(featureName)),
    loadWorkspaceConfig,
    auditProductSpec,
    brand: context.brand,
    targetFormFactors,
    channelId,
    threadTs,
    isFixAll: fixIntent.isFixAll,
  }
  const designToolDeps: DesignToolDeps = {
    auditSpecDraft,
    saveDraftDesignSpec,
    saveApprovedDesignSpec,
    applySpecPatch,
    extractAllOpenQuestions,
    auditPhaseCompletion,
    auditDownstreamReadiness,
    auditSpecDecisions,
    applyDecisionCorrections,
    auditSpecStructure,
    auditBrandTokens,
    auditAnimationTokens,
    extractDesignAssumptions,
    seedHandoffSection,
    classifyForPmGaps,
    classifyForArchGap,
    preseedEngineeringSpec,
    setPendingEscalation,
    generateDesignPreview,
    saveDraftHtmlPreview,
    filterDesignContent,
    buildDesignRubric,
    uploadFileToSlack: async ({ channelId: cId, threadTs: tTs, content: c, filename: fn, title: t }) => {
      await client.files.uploadV2({ channel_id: cId, thread_ts: tTs, content: c, filename: fn, title: t })
    },
    readFile,
  }
  const designToolHandlerRaw = readOnly ? undefined : async (name: string, input: Record<string, unknown>) => {
    const result = await handleDesignTool(name, input, designToolCtx, designToolDeps, designToolState)
    // Propagate mutable state back to the enclosing scope
    patchAppliedThisTurn = designToolState.patchAppliedThisTurn
    lastGeneratedPreviewHtml = designToolState.lastGeneratedPreviewHtml
    return result
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
  let effectiveStructuralFindings = structuralFindings

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

        appendMessage(featureKey(featureName), { role: "user", content: pass === 1 ? userMessage : `[PLATFORM: fix-all pass ${pass}]` })
        appendMessage(featureKey(featureName), { role: "assistant", content: passResponse })

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
        saveDraftAuditCache({ featureName, filePath: freshAuditCachePath, content: { specFingerprint: freshFp, renderAmbiguity: lastFreshQualityRaw } }).catch(() => {})
        // Principle 11: deterministic floor + LLM enrichment for fix-all re-audit
        const freshDeterministic = auditDesignSpec(freshDraft, { targetFormFactors })
        const freshLlm = await auditPhaseCompletion({
          specContent: freshDraft,
          rubric: buildDesignRubric(targetFormFactors),
          featureName,
          productVision: context.productVision,
          systemArchitecture: context.systemArchitecture,
          approvedProductSpec: context.approvedProductSpec,
        }).catch(() => null)
        const freshMerged: Array<{ issue: string; recommendation: string }> = [
          ...freshDeterministic.findings.map(f => ({ issue: f.issue, recommendation: f.recommendation })),
        ]
        if (freshLlm && !freshLlm.ready) {
          for (const lf of freshLlm.findings) {
            const isDuplicate = freshMerged.some(df => df.issue.toLowerCase().includes(lf.issue.slice(0, 40).toLowerCase()))
            if (!isDuplicate) freshMerged.push(lf)
          }
        }
        lastFreshReadiness = freshMerged.length > 0
          ? { ready: false, findings: freshMerged }
          : { ready: true, findings: [] }
        // Persist readiness findings for this new spec version — non-blocking
        const readinessToCache = lastFreshReadiness.ready ? [] : lastFreshReadiness.findings
        saveDraftAuditCache({ featureName, filePath: freshAuditCachePath, content: { specFingerprint: freshFp, readiness: readinessToCache } }).catch(() => {})

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

    // Phase 3: Platform-enforced finalization (Principle 8 — structural, not prompt-dependent).
    // When the user says "approved" and the spec has no structural conflicts, the platform calls
    // finalize_design_spec directly instead of letting the agent decide. This prevents the agent
    // from running auditPhaseCompletion and finding new LLM-generated items to block on.
    if (isApprovalIntent && designDraftContent && !readOnly) {
      const approvalStructural = auditSpecStructure(designDraftContent, "design")
      if (approvalStructural.length === 0) {
        console.log(`[PLATFORM-FINALIZE] approval intent detected, 0 structural findings — calling finalize_design_spec directly`)
        const finalizeResult = await designToolHandlerRaw!("finalize_design_spec", {})
        if (finalizeResult.error) {
          // Finalize gate blocked (open questions, downstream readiness, brand drift) — let user know
          console.log(`[PLATFORM-FINALIZE] blocked: ${finalizeResult.error}`)
          response = `Finalization blocked:\n${finalizeResult.error}`
          appendMessage(featureKey(featureName), { role: "user", content: userMessage })
          appendMessage(featureKey(featureName), { role: "assistant", content: response })
          await update(response)
          return
        }
        // Success — spec merged to main
        const url = (finalizeResult.result as { url?: string })?.url ?? ""
        response = `Design spec approved and merged to main. ${url}\n\nThe architect agent is now available — say *current state* to begin the engineering spec.`
        appendMessage(featureKey(featureName), { role: "user", content: userMessage })
        appendMessage(featureKey(featureName), { role: "assistant", content: response })
        await update(response)
        return
      } else {
        console.log(`[PLATFORM-FINALIZE] approval intent detected but ${approvalStructural.length} structural finding(s) — delegating to agent`)
      }
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
          draft: string,
          b: ReturnType<typeof auditBrandTokens>,
          a: ReturnType<typeof auditAnimationTokens>,
          m: ReturnType<typeof auditMissingBrandTokens>,
          q: string[],
          r: Awaited<ReturnType<typeof auditPhaseCompletion>> | null,
        ): ActionItem[] => [
          // Deterministic structural findings — convergence floor
          ...auditSpecStructure(draft, "design").map(f => ({ issue: `[STRUCTURAL] ${f.issue}`, fix: f.recommendation })),
          ...b.map(d => ({ issue: `${d.token}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ...a.map(d => ({ issue: `${d.param}: spec \`${d.specValue}\``, fix: `change to \`${d.brandValue}\`` })),
          ...m.map(m2 => ({ issue: `${m2.token} not referenced in spec`, fix: `add with value \`${m2.brandValue}\`` })),
          ...q.map(splitQualityIssue),
          ...(r && !r.ready ? r.findings.filter(f => !f.issue.includes("[PM-GAP]")).map(f => ({ issue: f.issue, fix: f.recommendation })) : []),
        ]

        let designResidual = computeDesignResidual(freshDraft!, freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness)
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

          appendMessage(featureKey(featureName), { role: "user", content: `[PLATFORM: continuation pass ${contPass}]` })
          appendMessage(featureKey(featureName), { role: "assistant", content: contResponse })

          freshDraft = await readFile(designFilePath, designBranchName).catch(() => null)
          if (!freshDraft) break

          ;({ freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness } = await runFreshDesignAudit(freshDraft))
          designResidual = computeDesignResidual(freshDraft!, freshBrand, freshAnim, freshMissing, freshDeterministicQuality, freshReadiness)
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
        // Recompute deterministic structural findings on post-patch spec
        effectiveStructuralFindings = freshDraft ? auditSpecStructure(freshDraft, "design") : []

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
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: saveMsg })
      // Upload the final preview once if patches were applied (skipped per-patch to avoid spam)
      if (patchAppliedThisTurn && lastGeneratedPreviewHtml) {
        client.files.uploadV2({ channel_id: channelId, thread_ts: threadTs, content: lastGeneratedPreviewHtml, filename: `${featureName}.preview.html`, title: `${featureName} — Design Preview` }).catch(() => {})
      }
      await update(saveMsg)
      return
    }
    throw err
  }

  appendMessage(featureKey(featureName), { role: "user", content: userMessage })

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

  // UPSTREAM-GATE: design
  // Platform enforcement: if there are [PM-GAP] findings from the design rubric and the agent
  // did NOT call offer_pm_escalation, auto-trigger escalation. Prompt rules are probabilistic —
  // this makes product gap escalation structurally deterministic regardless of agent prose choices.
  // [PM-GAP] is a rubric-level tag — it never appears in the design spec itself (root cause fix).
  const productFindings = designReadinessFindings.filter(f => f.issue.includes("[PM-GAP]"))
  const agentCalledEscalation = !!getPendingEscalation(featureKey(featureName))
  console.log(`[ESCALATION] gate check for ${featureName}: productFindings=${productFindings.length}, agentCalledEscalation=${agentCalledEscalation}, toolCalls=${toolCallsOutDesign.map(t => t.name).join(",") || "none"}`)
  if (productFindings.length > 0 && !agentCalledEscalation) {
    console.log(`[ESCALATION] Gate 2 (N18) fired — productFindings:\n${productFindings.map(f => f.issue).join("\n")}`)
    const consolidated = productFindings.map((f, i) => `${i + 1}. ${f.issue}`).join("\n")
    setPendingEscalation(featureKey(featureName), { targetAgent: "pm", question: consolidated, designContext: "", productSpec: context.approvedProductSpec ?? undefined })
    const assertionText = `Design cannot move forward until the PM closes these gaps. Say *yes* and I'll bring the PM into this thread now.`
    const escalationResponse = `${consolidated}\n\n${assertionText}`
    appendMessage(featureKey(featureName), { role: "assistant", content: escalationResponse })
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
        setPendingEscalation(featureKey(featureName), { targetAgent: "pm", question: g3FilteredQuestion, designContext: "", productSpec: context.approvedProductSpec ?? undefined })
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
  if (!agentCalledEscalation && !getPendingEscalation(featureKey(featureName)) && !didSave && !agentStillSeeking && !gate3ClassifierRan) {
    console.log(`[ESCALATION] Gate 4 (Haiku classifier) running for ${featureName}`)
    const classification = await classifyForPmGaps({
      agentResponse: response,
      approvedProductSpec: context.approvedProductSpec ?? undefined,
    }).catch(() => ({ gaps: [] }))
    console.log(`[ESCALATION] Gate 4 result: ${classification.gaps.length} gaps — ${classification.gaps.length === 0 ? "NONE" : classification.gaps.join(" | ")}`)
    if (classification.gaps.length > 0) {
      const consolidated = classification.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")
      setPendingEscalation(featureKey(featureName), { targetAgent: "pm", question: consolidated, designContext: "", productSpec: context.approvedProductSpec ?? undefined })
    }
  } else {
    console.log(`[ESCALATION] Gate 4 (Haiku classifier) skipped — agentCalledEscalation=${agentCalledEscalation}, pendingAlreadySet=${!!getPendingEscalation(featureKey(featureName))}, didSave=${didSave}, agentStillSeeking=${agentStillSeeking}, gate3ClassifierRan=${gate3ClassifierRan}`)
  }

  // If escalation was just offered this turn (via tool call, N18 gate, fallback prose-detection
  // gate, or Haiku classifier above), suppress the action menu — showing fixable design items
  // when the user cannot act on them until PM gaps close is actively misleading.
  const escalationJustOffered = !escalationBeforeRun && !!getPendingEscalation(featureKey(featureName))

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
    const pending = getPendingEscalation(featureKey(featureName))
    if (pending?.targetAgent === "pm") {
      // Always replace with the structured format — agent prose may say "bring the PM"
      // without listing the actual gaps, leaving the user without actionable content.
      const assertionText = `Design cannot move forward until the PM closes these gaps. Say *yes* and I'll bring the PM into this thread now.`
      finalResponse = `${pending.question}\n\n${assertionText}`
      console.log(`[ESCALATION] Override applied for ${featureName}. pending.question:\n${pending.question}`)
    }
  }

  // ─── POST-RUN: Universal hedge detection (Principle 11 — deterministic) ────
  // Same pattern as architect. Guard: skip on readOnly AND on escalation-just-offered
  // (the CTA text is platform-generated — hedge-stripping it would be a false positive).
  if (!readOnly && !escalationJustOffered) {
    const hedges = detectHedgeLanguage(finalResponse)
    if (hedges.length > 0) {
      console.log(`[HEDGE-GATE] design: detected ${hedges.length} deferral phrase(s): ${hedges.join(", ")}`)
      const lines = finalResponse.trim().split("\n")
      while (lines.length > 0 && lines[lines.length - 1].trim().endsWith("?")) {
        lines.pop()
      }
      finalResponse = lines.join("\n") + "\n\nI'll proceed with the approach outlined above."
    }
  }
  // ─── END HEDGE GATE ─────────────────────────────────────────────────────────

  // ─── POST-RUN: Action verification (Principle 8) ───────────────────────────
  if (!readOnly && !escalationJustOffered) {
    finalResponse = verifyActionClaims(finalResponse, toolCallsOutDesign)
  }
  // ─── END ACTION VERIFICATION ──────────────────────────────────────────────

  appendMessage(featureKey(featureName), { role: "assistant", content: finalResponse })

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
        // Deterministic structural findings FIRST — convergence floor
        ...effectiveStructuralFindings.map(f => ({ issue: `[STRUCTURAL] ${f.issue}`, fix: f.recommendation })),
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
  const escalationJustOfferedPm = escalationJustOffered && getPendingEscalation(featureKey(featureName))?.targetAgent === "pm"
  const totalEffectiveItems = effectiveStructuralFindings.length + effectiveBrandDrifts.length + effectiveAnimDrifts.length +
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
  userId?: string
}): Promise<void> {
  const { channelId, threadTs, featureName, userMessage, userImages, update, routingNote, readOnly, userId } = params

  // Upstream readiness: informational only — findings injected into agent context via
  // always-on upstream audit (below). Blocking gates apply at finalization time (Principle 14).

  // Pending decision review — check before spec approval and fast paths.
  // Fix B: When the architect resolves open questions, decisions are held for human confirmation.
  const pendingReview = getPendingDecisionReview(featureKey(featureName))
  if (pendingReview) {
    if (isAffirmative(userMessage)) {
      clearPendingDecisionReview(featureKey(featureName))
      await update("_Saving engineering spec draft with confirmed decisions..._")
      await saveDraftEngineeringSpec({ featureName, filePath: pendingReview.filePath, content: pendingReview.specContent })
      const { githubOwner, githubRepo } = loadWorkspaceConfig()
      const branchName = `spec/${featureName}-engineering`
      const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${branchName}/${pendingReview.filePath}`
      const confirmMessage = `Decisions confirmed — engineering spec draft saved.\n\n${url}`
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: confirmMessage })
      await update(confirmMessage)
      return
    } else {
      clearPendingDecisionReview(featureKey(featureName))
      // Not confirming — discard held content, fall through to normal agent flow.
      // The user's message will be processed by the architect with context that
      // the decisions were not approved.
    }
  }

  // Pending spec approval — check before fast paths
  const pendingEngineeringApproval = getPendingApproval(featureKey(featureName))
  if (pendingEngineeringApproval && pendingEngineeringApproval.specType === "engineering") {
    if (isAffirmative(userMessage)) {
      // Re-fetch spec from branch to detect stale cached content
      const freshEng = await readFile(pendingEngineeringApproval.filePath, `spec/${featureName}-engineering`).catch(() => null)
      if (freshEng && freshEng !== pendingEngineeringApproval.specContent) {
        console.log(`[ROUTER] runArchitectAgent: spec content changed since approval was offered — warning user`)
        clearPendingApproval(featureKey(featureName))
        await update("The engineering spec has been modified since the approval was offered. Please review the current version and say *approve* again when ready.")
        return
      }
      clearPendingApproval(featureKey(featureName))
      await update("_Saving the final engineering spec..._")
      await saveApprovedEngineeringSpec({ featureName, filePath: pendingEngineeringApproval.filePath, content: pendingEngineeringApproval.specContent })
      const approvalMessage =
        `The *${featureName}* engineering spec is saved and approved. :white_check_mark:\n\n` +
        `*What happens next:*\n` +
        `The engineer agents will use this spec to implement the feature — data model, APIs, and UI components.\n\n` +
        `To confirm the approved state or check where any feature stands, go to *#${loadWorkspaceConfig().mainChannel}* and ask.`
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: approvalMessage })
      await update(approvalMessage)
      return
    } else {
      clearPendingApproval(featureKey(featureName))
      // Not confirming — fall through to normal agent flow
    }
  }

  if (!readOnly) {
    const isCheckInArch = CHECK_IN_RE.test(userMessage.trim())

    const offTopic = isCheckInArch ? false : await isOffTopicForAgent(userMessage, "engineering")
    if (offTopic) {
      const mainChannel = loadWorkspaceConfig().mainChannel
      const msg = `For status and progress updates, ask in *#${mainChannel}* — the concierge has the full picture across all features.\n\nI'm the Architect — I'm here when you're ready to work on data models, APIs, or engineering decisions for this feature.`
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: msg })
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
      appendMessage(featureKey(featureName), { role: "user", content: userMessage })
      appendMessage(featureKey(featureName), { role: "assistant", content: msg })
      await update(msg)
      return
    }
  }

  await update("_Architect is reading the spec chain..._")
  const historyArch = getHistory(featureKey(featureName))
  const ARCH_HISTORY_LIMIT = 40
  // When called via escalation (readOnly=true), skip history-dependent enrichment.
  // The brief is self-contained; prior-phase history adds hallucination risk.
  const [context, lockedDecisionsArch, priorContextArch] = await Promise.all([
    loadArchitectAgentContext(featureName),
    readOnly ? "" : extractLockedDecisions(historyArch).catch(() => ""),
    readOnly ? "" : getPriorContext(featureName, historyArch, ARCH_HISTORY_LIMIT),
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
    // Principle 11: deterministic audits are the PRIMARY gate. LLM rubric is @enrichment.
    // Primary: instant deterministic checks (same input = same output)
    const pmDeterministic = pmSpecContentArch ? auditPmSpec(pmSpecContentArch) : null
    const designDeterministic = designSpecContentArch ? auditDesignSpec(designSpecContentArch, { targetFormFactors }) : null
    // Enrichment: LLM rubric in parallel (may find semantic gaps the parser misses)
    const [pmLlmArch, designLlmArch] = await Promise.all([
      pmSpecContentArch
        ? auditPhaseCompletion({ specContent: pmSpecContentArch, rubric: ARCHITECT_UPSTREAM_PM_RUBRIC, featureName, productVision: context.productVision, systemArchitecture: context.systemArchitecture }).catch(() => null)
        : null,
      designSpecContentArch
        ? auditPhaseCompletion({ specContent: designSpecContentArch, rubric: buildDesignRubric(targetFormFactors), featureName, productVision: context.productVision, systemArchitecture: context.systemArchitecture, approvedProductSpec: pmSpecContentArch ?? undefined }).catch(() => null)
        : null,
    ])
    // Merge PM findings: deterministic floor + LLM enrichment
    const pmAllFindings: Array<{ issue: string; recommendation: string }> = []
    if (pmDeterministic && !pmDeterministic.ready) {
      pmAllFindings.push(...pmDeterministic.findings.map(f => ({ issue: f.issue, recommendation: f.recommendation })))
    }
    if (pmLlmArch && !pmLlmArch.ready) {
      for (const lf of pmLlmArch.findings) {
        const isDuplicate = pmAllFindings.some(df => df.issue.toLowerCase().includes(lf.issue.slice(0, 40).toLowerCase()))
        if (!isDuplicate) pmAllFindings.push(lf)
      }
    }
    // Merge Design findings: deterministic floor + LLM enrichment
    const designAllFindings: Array<{ issue: string; recommendation: string }> = []
    if (designDeterministic && !designDeterministic.ready) {
      designAllFindings.push(...designDeterministic.findings.map(f => ({ issue: f.issue, recommendation: f.recommendation })))
    }
    if (designLlmArch && !designLlmArch.ready) {
      for (const lf of designLlmArch.findings) {
        const isDuplicate = designAllFindings.some(df => df.issue.toLowerCase().includes(lf.issue.slice(0, 40).toLowerCase()))
        if (!isDuplicate) designAllFindings.push(lf)
      }
    }
    const archFindings: string[] = []
    if (pmAllFindings.length > 0) {
      const lines = pmAllFindings.map((f, i) => `${i + 1}. [PM] ${f.issue} — ${f.recommendation}`).join("\n")
      archFindings.push(`APPROVED PM SPEC — ${pmAllFindings.length} GAP${pmAllFindings.length === 1 ? "" : "S"}:\n${lines}`)
    }
    if (designAllFindings.length > 0) {
      const lines = designAllFindings.map((f, i) => `${i + 1}. [Design] ${f.issue} — ${f.recommendation}`).join("\n")
      archFindings.push(`APPROVED DESIGN SPEC — ${designAllFindings.length} GAP${designAllFindings.length === 1 ? "" : "S"}:\n${lines}`)
    }
    if (archFindings.length > 0) {
      upstreamNoticeArch = `\n\n[INTERNAL — Upstream spec gaps you found during your review. Present these as YOUR findings to the user, never as "the platform's". Follow your "How you open every conversation" rules to determine WHEN to surface them (orientation turns: do not surface; substantive turns: assert escalation plan per PM-first ordering).\n${archFindings.join("\n\n")}]`
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

  // Deterministic structural checks — convergence floor for architect (same as design path)
  const archStructuralFindings = engDraftContent ? auditSpecStructure(engDraftContent, "engineering") : []
  if (archStructuralFindings.length > 0) {
    console.log(`[AUDITOR] archStructuralFindings: ${archStructuralFindings.length} deterministic finding(s)`)
  }
  if (engDraftContent) {
    const efp = specFingerprint(engDraftContent)
    const archPhaseCacheKey = `arch-phase:${featureName}:${efp}`
    if (phaseEntryAuditCache.has(archPhaseCacheKey)) {
      archReadinessNotice = phaseEntryAuditCache.get(archPhaseCacheKey)!
    } else {
      // Principle 11: deterministic audit is the PRIMARY gate for engineering readiness.
      const engDeterministic = auditEngineeringSpec(engDraftContent)
      // LLM rubric as @enrichment
      const archAuditResult = await auditPhaseCompletion({
        specContent: engDraftContent,
        rubric: ENGINEER_RUBRIC,
        featureName,
      }).catch(() => null)
      // Merge: deterministic floor + LLM enrichment
      const engMerged: Array<{ issue: string; recommendation: string }> = [
        ...engDeterministic.findings.map(f => ({ issue: f.issue, recommendation: f.recommendation })),
      ]
      if (archAuditResult && !archAuditResult.ready) {
        for (const lf of archAuditResult.findings) {
          const isDuplicate = engMerged.some(df => df.issue.toLowerCase().includes(lf.issue.slice(0, 40).toLowerCase()))
          if (!isDuplicate) engMerged.push(lf)
        }
      }
      if (engMerged.length > 0) {
        const findingLines = engMerged.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
        archReadinessNotice = `\n\n[INTERNAL — Engineering readiness: ${engMerged.length} gap${engMerged.length === 1 ? "" : "s"} blocking implementation handoff. These are YOUR findings from reviewing the spec. Follow your "How you open every conversation" rules to determine WHEN to surface them.\n${findingLines}]`
      } else if (engDeterministic.ready && (archAuditResult?.ready ?? true)) {
        archReadinessNotice = `\n\n[INTERNAL — Engineering readiness: Spec passed all rubric criteria. You may confirm the spec is implementation-ready when asked.]`
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
      designAssumptionsNotice = `\n\n[INTERNAL — Design assumptions to validate before engineering approval. For each: either confirm it inline in the spec (remove from this list) or call offer_upstream_revision(design) if the assumption is incorrect:\n${assumptionsToValidate}]`
    }
  }

  // ─── UPSTREAM GAPS: INFORMATIONAL CONTEXT, NOT A GATE ───────────────────────
  // Upstream audit findings are injected into the architect's context so it can
  // decide which gaps to escalate via offer_upstream_revision(pm|design) and which
  // to handle as engineering assumptions in ## Design Assumptions To Validate.
  // The architect is NOT blocked — it decides what's blocking, not the platform.
  // Non-blocking gaps are enforced at the EXIT gate (finalize_engineering_spec
  // blocks if unvalidated assumptions remain), not the entry gate.
  //
  // Orientation tracking: suppress upstream notices on the first message from a
  // userId in this feature so the architect can orient the newcomer first.
  // Orientation tracking requires a real userId — if userId is not available
  // (e.g. Slack API didn't provide it), skip orientation suppression and show notices.
  const isOrientationTurn = (userId && userId.length > 0) ? !isUserOriented(featureKey(featureName), userId) : false

  // Suppress upstream notices on orientation turns — architect orients first, gaps come next turn.
  const archNotices = readOnly ? "" : isOrientationTurn ? "" : (upstreamNoticeArch + archReadinessNotice + designAssumptionsNotice)
  const enrichedUserMessageArch = readOnly
    ? userMessage  // escalation brief is already complete
    : buildEnrichedMessage({ userMessage, lockedDecisions: lockedDecisionsArch, priorContext: priorContextArch }) + archNotices
  const systemPrompt = buildArchitectSystemBlocks(context, featureName, readOnly)

  await update("_Architect is thinking..._")

  const archFilePath = `${workspacePaths.featuresRoot}/${featureName}/${featureName}.engineering.md`
  const archBranchName = `spec/${featureName}-engineering`
  const prefix = routingNote ? `${routingNote}\n\n` : ""
  const toolCallsOutArch: ToolCallRecord[] = []
  const archToolState: ArchitectToolState = { escalationFired: false, pendingDecisionReview: null }

  // When called via escalation (readOnly=true), pass EMPTY history. The escalation brief
  // contains everything the architect needs. Prior-phase conversation history causes hallucination.
  // Same pattern as PM agent's readOnly gate (line 897).
  const effectiveHistoryArch = readOnly ? [] : historyArch

  let response = await runAgent({
    systemPrompt,
    history: effectiveHistoryArch,
    userMessage: enrichedUserMessageArch,
    userImages,
    historyLimit: ARCH_HISTORY_LIMIT,
    tools: readOnly ? undefined : ARCHITECT_TOOLS,
    toolHandler: readOnly ? undefined : (name, input) => handleArchitectTool(name, input, {
      featureName,
      specFilePath: archFilePath,
      specBranchName: archBranchName,
      context,
      update,
      readFile: (path, branch) => readFile(path, branch),
      getHistory: () => getHistory(featureKey(featureName)),
      loadWorkspaceConfig,
    }, {
      auditSpecDraft,
      saveDraftEngineeringSpec,
      saveApprovedEngineeringSpec,
      applySpecPatch,
      extractAllOpenQuestions,
      extractHandoffSection,
      auditSpecDecisions,
      applyDecisionCorrections,
      auditDownstreamReadiness,
      auditSpecStructure,
      clearHandoffSection,
      setPendingEscalation,
      readFile: (path, branch) => readFile(path, branch),
    }, archToolState),
    toolCallsOut: toolCallsOutArch,
    // Fix A: When the architect escalates upstream, stop the tool loop after wrapping up.
    forceStopToolNames: ["offer_upstream_revision"],
  })

  // Mark user as oriented after first architect response (persisted across restarts).
  if (userId) markUserOriented(featureKey(featureName), userId)

  // ─── POST-RUN: Orientation response enforcement (Principle 8 + 10) ──────────
  // Orientation responses must NEVER end with a question that defers to the user.
  // The architect is the expert — it states what it will do next, not what the user
  // should decide. Structural check: if readOnly (orientation) and response ends
  // with a question, strip the trailing question and append the standard next step.
  if (readOnly && response.trim().endsWith("?")) {
    const lines = response.trim().split("\n")
    // Remove trailing lines that end with "?" (could be multi-line question)
    while (lines.length > 0 && lines[lines.length - 1].trim().endsWith("?")) {
      lines.pop()
    }
    const nextStep = "\n\nI'll review the full spec chain and come back with a structural proposal for the engineering spec."
    response = lines.join("\n") + nextStep
    console.log(`[ORIENTATION-GATE] stripped trailing question from orientation response — replaced with architect's next step`)
  }

  // UPSTREAM-GATE: architect
  // ─── POST-RUN: Upstream gap auto-escalation (Principle 8) ───────────────────
  // Same pattern as design agent's Gate 2. If upstream audit found gaps and the
  // architect did NOT call offer_upstream_revision, auto-trigger escalation.
  // PM-first ordering: if BOTH PM and design gaps exist, only escalate PM.
  // Design gaps wait until PM gaps are resolved.
  if (!readOnly && !getPendingEscalation(featureKey(featureName))) {
    const archCalledPmEscalation = toolCallsOutArch.some(t => t.name === "offer_upstream_revision" && (t.input as any)?.target === "pm")
    const archCalledDesignEscalation = toolCallsOutArch.some(t => t.name === "offer_upstream_revision" && (t.input as any)?.target === "design")
    const pmGapsInNotice = upstreamNoticeArch.includes("APPROVED PM SPEC")
    const designGapsInNotice = upstreamNoticeArch.includes("APPROVED DESIGN SPEC")

    if (pmGapsInNotice && !archCalledPmEscalation) {
      // PM gaps take priority — escalate PM first, design waits
      const pmGapRegex = /APPROVED PM SPEC — \d+ GAPS?:\n([\s\S]*?)(?=APPROVED DESIGN|$)/
      const pmGapText = upstreamNoticeArch.match(pmGapRegex)?.[1]?.trim()
      if (pmGapText) {
        console.log(`[ESCALATION-GATE] architect post-run: PM gaps in context but agent did not call offer_upstream_revision(pm) — auto-triggering`)
        setPendingEscalation(featureKey(featureName), { targetAgent: "pm", question: pmGapText, designContext: "" })
      }
    } else if (designGapsInNotice && !archCalledDesignEscalation) {
      // No PM gaps (or already escalated) — now check design gaps
      const designGapRegex = /APPROVED DESIGN SPEC — \d+ GAPS?:\n([\s\S]*?)$/
      const designGapText = upstreamNoticeArch.match(designGapRegex)?.[1]?.trim()
      if (designGapText) {
        console.log(`[ESCALATION-GATE] architect post-run: design gaps in context but agent did not call offer_upstream_revision(design) — auto-triggering`)
        setPendingEscalation(featureKey(featureName), { targetAgent: "design", question: designGapText, designContext: "" })
      }
    }
  }
  // ─── END POST-RUN ESCALATION GATE ──────────────────────────────────────────

  // ─── POST-RUN: Recommendation count gate (Principle 10) ────────────────────
  // Same pattern as PM brief enforcement. If the architect identifies blocking
  // issues but doesn't provide "My recommendation:" for each one, re-run with
  // enforcement. Only on substantive turns (not orientation, not auto-escalation).
  if (!readOnly && !getPendingEscalation(featureKey(featureName))) {
    // Count blocking issues: lines starting with a number followed by "**" (bold issue header)
    const blockingIssueCount = (response.match(/^\d+\.\s+\*\*/gm) ?? []).length
    const recommendationCount = (response.match(/my recommendation:/gi) ?? []).length
    if (blockingIssueCount > 0 && recommendationCount < blockingIssueCount) {
      console.log(`[RECOMMENDATION-GATE] architect: ${blockingIssueCount} blocking issues but only ${recommendationCount} recommendations — re-running with enforcement`)
      const enforcementMessage = `PLATFORM ENFORCEMENT: Your previous response identified ${blockingIssueCount} blocking issue(s) but only provided ${recommendationCount} "My recommendation:" line(s). For EVERY blocking issue you identify, you MUST provide your expert recommendation — not just state the problem. Output exactly:

[N]. **[issue]** — My recommendation: [one specific, concrete answer — no conditionals, no "it depends"]

If an issue requires an upstream decision, call offer_upstream_revision(pm) or offer_upstream_revision(design) instead of recommending. Do not list issues without either a recommendation or an escalation tool call.

ORIGINAL RESPONSE TO FIX:
${response}`
      // Reset state for enforcement re-run (escalation flag carries over — if escalation
      // fired in the first run, it stays active for the enforcement run too).
      response = await runAgent({
        systemPrompt,
        history: effectiveHistoryArch,
        userMessage: enforcementMessage,
        historyLimit: ARCH_HISTORY_LIMIT,
        tools: ARCHITECT_TOOLS,
        toolHandler: (name, input) => handleArchitectTool(name, input, {
          featureName,
          specFilePath: archFilePath,
          specBranchName: archBranchName,
          context,
          update,
          readFile: (path, branch) => readFile(path, branch),
          getHistory: () => getHistory(featureKey(featureName)),
          loadWorkspaceConfig,
        }, {
          auditSpecDraft,
          saveDraftEngineeringSpec,
          saveApprovedEngineeringSpec,
          applySpecPatch,
          extractAllOpenQuestions,
          extractHandoffSection,
          auditSpecDecisions,
          applyDecisionCorrections,
          auditDownstreamReadiness,
          auditSpecStructure,
          clearHandoffSection,
          setPendingEscalation,
          readFile: (path, branch) => readFile(path, branch),
        }, archToolState),
        toolCallsOut: toolCallsOutArch,
        forceStopToolNames: ["offer_upstream_revision"],
      })
    }
  }
  // ─── END RECOMMENDATION GATE ───────────────────────────────────────────────

  // ─── POST-RUN: Escalation assertive language override (Principle 10) ───────
  // Same pattern as design agent: if escalation was offered (agent called
  // offer_upstream_revision or auto-gate fired), replace agent prose with
  // structured CTA. Passive framing ("should we ask PM?") → assertive CTA.
  const escalationBeforeRunArch = !!getPendingEscalation(featureKey(featureName))
  const escalationJustOfferedArch = !escalationBeforeRunArch || toolCallsOutArch.some(t => t.name === "offer_upstream_revision")
  let finalArchResponse = response
  if (escalationJustOfferedArch && getPendingEscalation(featureKey(featureName)) && !readOnly) {
    const pending = getPendingEscalation(featureKey(featureName))
    if (pending) {
      const escLabel = pending.targetAgent === "pm" ? "PM" : "Design"
      finalArchResponse = `${pending.question}\n\nUpstream ${escLabel} gaps must be resolved before engineering can proceed. Say *yes* and I'll bring in the ${escLabel} agent to close them.`
      console.log(`[ESCALATION] architect assertive override applied for ${featureName}`)
    }
  }
  // ─── END ESCALATION ASSERTIVE OVERRIDE ─────────────────────────────────────

  // ─── POST-RUN: Universal hedge detection (Principle 11 — deterministic) ────
  // Detect deferral language in agent response. If found, strip trailing questions
  // and replace with an assertive statement. Same check applies to all agents.
  // Guard: skip on escalation-just-offered (CTA is platform-generated, not agent prose).
  if (!readOnly && !escalationJustOfferedArch) {
    const hedges = detectHedgeLanguage(finalArchResponse)
    if (hedges.length > 0) {
      console.log(`[HEDGE-GATE] architect: detected ${hedges.length} deferral phrase(s): ${hedges.join(", ")}`)
      const lines = finalArchResponse.trim().split("\n")
      while (lines.length > 0 && lines[lines.length - 1].trim().endsWith("?")) {
        lines.pop()
      }
      finalArchResponse = lines.join("\n") + "\n\nI'll proceed with the approach outlined above."
    }
  }
  // ─── END HEDGE GATE ─────────────────────────────────────────────────────────

  // ─── POST-RUN: Action verification (Principle 8) ───────────────────────────
  if (!readOnly && !escalationJustOfferedArch) {
    finalArchResponse = verifyActionClaims(finalArchResponse, toolCallsOutArch)
  }
  // ─── END ACTION VERIFICATION ──────────────────────────────────────────────

  // ─── POST-RUN: Uncommitted decisions audit (Principle 7) ───────────────────
  // Same pattern as design agent: detect decisions discussed but not saved.
  let archUncommittedNote = ""
  if (!readOnly) {
    const archDidSave = toolCallsOutArch.some(t =>
      ["save_engineering_spec_draft", "apply_engineering_spec_patch", "finalize_engineering_spec"].includes(t.name)
    )
    const archStillSeeking = /lock this in\?|confirm\?|shall i (save|apply|commit|update)\?|save this\?|ready to (commit|save|lock)\?/i.test(finalArchResponse)
    if (!archDidSave && !archStillSeeking) {
      const archCurrentTurn: Message[] = [
        { role: "user", content: userMessage },
        { role: "assistant", content: finalArchResponse },
      ]
      const archUncommitted = await identifyUncommittedDecisions(archCurrentTurn, context.currentDraft ?? "").catch(() => "")
      const archAllCommitted = !archUncommitted || archUncommitted.trim().toLowerCase() === "none"
      if (archUncommitted && !archAllCommitted) {
        archUncommittedNote = `\n\n⚠️ *Heads up:* decisions were discussed this turn but not saved to the spec. Say *save those* to commit them.`
      }
    }
  }
  // ─── END UNCOMMITTED DECISIONS AUDIT ───────────────────────────────────────

  // ─── POST-RUN: Platform status line (Principle 7) ──────────────────────────
  // Same pattern as design agent: authoritative audit count prepended when items remain.
  // Suppress only when upstream escalation just fired (user can't act until upstream resolves).
  const escalationJustOfferedUpstream = escalationJustOfferedArch && !!getPendingEscalation(featureKey(featureName))
  const archTotalEffectiveItems = archStructuralFindings.length +
    (engDraftContent ? auditEngineeringSpec(engDraftContent).findings.length : 0)
  const archStatusPrefix = (!escalationJustOfferedUpstream && archTotalEffectiveItems > 0 && !readOnly)
    ? `_${archTotalEffectiveItems} item${archTotalEffectiveItems === 1 ? "" : "s"} to address before implementation handoff._\n\n`
    : ""
  // ─── END PLATFORM STATUS LINE ─────────────────────────────────────────────

  appendMessage(featureKey(featureName), { role: "user", content: userMessage })
  appendMessage(featureKey(featureName), { role: "assistant", content: finalArchResponse })

  // If auto-escalation was triggered, append the escalation CTA after the agent's response
  const postRunEscalation = getPendingEscalation(featureKey(featureName))
  if (postRunEscalation && !readOnly) {
    await update(`${prefix}${archStatusPrefix}${finalArchResponse}${archUncommittedNote}`)
  } else if (archToolState.pendingDecisionReview && !readOnly) {
    // Fix B: Decisions detected — store in conversation state and surface for human review.
    const review = archToolState.pendingDecisionReview
    setPendingDecisionReview(featureKey(featureName), {
      specContent: review.content,
      filePath: review.filePath,
      featureName,
      resolvedQuestions: review.resolvedQuestions,
    })
    const decisionList = review.resolvedQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
    const reviewCta = `\n\n---\n\n*Architectural decisions for your review:*\n\n${decisionList}\n\nThese open questions have been resolved in this update. Say *yes* to confirm and save, or tell me what you'd like changed.`
    await update(`${prefix}${archStatusPrefix}${finalArchResponse}${archUncommittedNote}${reviewCta}`)
  } else {
    await update(`${prefix}${archStatusPrefix}${finalArchResponse}${archUncommittedNote}`)
  }
}
