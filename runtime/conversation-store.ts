// Stores conversation history per feature name (e.g. "onboarding").
// All threads in a feature channel share one accumulated history under the featureName key.
// In production this would be Redis — for now in-memory + file persistence is sufficient.
//
// Both conversation history and confirmed agents survive bot restarts via disk persistence.
//
// Legacy note: before the featureName-keying migration, history was stored under Slack threadTs
// float strings (e.g. "1774391965.646909"). On startup, migrateThreadTsKeys() consolidates all
// those entries into a single "_legacy_" key, which getHistory() merges with featureName history.

import fs from "fs"
import path from "path"

export type Message = {
  role: "user" | "assistant"
  content: string
}

export type PendingEscalation = {
  targetAgent: "pm" | "architect" | "design"
  question: string        // the specific blocking question to hand to the PM, architect, or designer
  designContext: string   // current design draft — gives them instant context
  productSpec?: string    // approved product spec — so PM agent has full context without re-fetching
  engineeringContext?: string  // current engineering spec draft — gives designer/PM context from architect
}

// Escalation notification — set after the PM/Architect/Designer @mention is posted.
// Cleared when they reply in the thread, at which point the originating agent resumes.
// Distinct from PendingEscalation (which gates the user "yes" confirmation).
// recommendations: the full agent response text, stored so the platform
// can write confirmed decisions back to the appropriate spec on human confirmation.
export type EscalationNotification = {
  targetAgent: "pm" | "architect" | "design"
  question: string
  recommendations?: string
  originAgent?: "design" | "architect"  // which agent to resume after reply; defaults to "design" if absent
}

// Pending spec approval — set when the agent detects approval intent.
// The spec content is cached here so we can save it on explicit user confirmation.
// Cleared when the user confirms (spec saved) or sends any non-affirmative message.
export type PendingApproval = {
  specType: "product" | "design" | "engineering"
  specContent: string
  filePath: string
  featureName: string
}

const store = new Map<string, Message[]>()
const confirmedAgents = new Map<string, string>()                       // threadTs → confirmed agent type
const pendingEscalations = new Map<string, PendingEscalation>()         // threadTs → pending escalation
const pendingApprovals = new Map<string, PendingApproval>()             // threadTs → pending spec approval
const escalationNotifications = new Map<string, EscalationNotification>() // featureName → active notification

const CONFIRMED_AGENTS_FILE = path.join(__dirname, "../.confirmed-agents.json")
const CONVERSATION_HISTORY_FILE = path.join(__dirname, "../.conversation-history.json")
const CONVERSATION_STATE_FILE = path.join(__dirname, "../.conversation-state.json")

function loadConfirmedAgents(): void {
  try {
    const raw = fs.readFileSync(CONFIRMED_AGENTS_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, string>
    for (const [threadTs, agent] of Object.entries(parsed)) {
      confirmedAgents.set(threadTs, agent)
    }
  } catch {
    // File doesn't exist yet — start fresh
  }
}

function persistConfirmedAgents(): void {
  if (!_filePersistenceEnabled) return
  try {
    const obj = Object.fromEntries(confirmedAgents)
    fs.writeFileSync(CONFIRMED_AGENTS_FILE, JSON.stringify(obj, null, 2))
  } catch (err) {
    console.log(`[STORE] persistConfirmedAgents: error writing ${CONFIRMED_AGENTS_FILE}: ${err}`)
  }
}

function loadConversationHistory(): void {
  try {
    const raw = fs.readFileSync(CONVERSATION_HISTORY_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, Message[]>
    for (const [key, messages] of Object.entries(parsed)) {
      store.set(key, messages)
    }
  } catch {
    // File doesn't exist yet — start fresh
  }
}

// One-time migration: threadTs-keyed entries (e.g. "1774391965.646909") are pre-migration history.
// We cannot map them to featureNames without Slack channel metadata, so we consolidate them all
// into "_legacy_" and getHistory() merges that with featureName-keyed history.
// SOLO-TEAM SHORTCUT: this merges all legacy into every featureName's history. At scale this must
// use a threadTs→featureName index built from Slack channel metadata. See DECISIONS.md.
function migrateThreadTsKeys(): void {
  const threadTsPattern = /^\d{10,}\.\d+$/
  const legacyMessages: Message[] = []
  const toDelete: string[] = []
  for (const [key, messages] of store.entries()) {
    if (threadTsPattern.test(key)) {
      legacyMessages.push(...messages)
      toDelete.push(key)
    }
  }
  if (legacyMessages.length === 0) return
  const existing = store.get("_legacy_") ?? []
  store.set("_legacy_", [...existing, ...legacyMessages])
  for (const k of toDelete) store.delete(k)
  persistConversationHistory()
}

function persistConversationHistory(): void {
  if (!_filePersistenceEnabled) return
  try {
    const obj = Object.fromEntries(store)
    fs.writeFileSync(CONVERSATION_HISTORY_FILE, JSON.stringify(obj, null, 2))
  } catch (err) {
    console.log(`[STORE] persistConversationHistory: error writing ${CONVERSATION_HISTORY_FILE}: ${err}`)
  }
}

function loadConversationState(): void {
  try {
    const raw = fs.readFileSync(CONVERSATION_STATE_FILE, "utf-8")
    const parsed = JSON.parse(raw) as {
      pendingEscalations?: Record<string, PendingEscalation>
      pendingApprovals?: Record<string, PendingApproval>
      escalationNotifications?: Record<string, EscalationNotification>
    }
    for (const [k, v] of Object.entries(parsed.pendingEscalations ?? {})) pendingEscalations.set(k, v)
    for (const [k, v] of Object.entries(parsed.pendingApprovals ?? {})) pendingApprovals.set(k, v)
    for (const [k, v] of Object.entries(parsed.escalationNotifications ?? {})) escalationNotifications.set(k, v)
  } catch {
    // File doesn't exist yet — start fresh
  }
}

// Disable file persistence for integration tests — prevents test cleanup from wiping production state files.
// Also clears all in-memory state loaded from disk on module import, so tests start with a clean slate
// regardless of what the production state files contain.
// Call once at the top of each integration test file, before any test runs.
let _filePersistenceEnabled = true
export function disableFilePersistence(): void {
  _filePersistenceEnabled = false
  // Wipe all state maps — disk-loaded values from module import must not bleed into tests.
  store.clear()
  confirmedAgents.clear()
  pendingEscalations.clear()
  pendingApprovals.clear()
  escalationNotifications.clear()
}

function persistConversationState(): void {
  if (!_filePersistenceEnabled) return
  try {
    const obj = {
      pendingEscalations: Object.fromEntries(pendingEscalations),
      pendingApprovals: Object.fromEntries(pendingApprovals),
      escalationNotifications: Object.fromEntries(escalationNotifications),
    }
    console.log(`[STORE] persistConversationState: writing escalations=[${[...pendingEscalations.keys()].join(",")}]`)
    fs.writeFileSync(CONVERSATION_STATE_FILE, JSON.stringify(obj, null, 2))
  } catch (err) {
    console.log(`[STORE] persistConversationState: error writing ${CONVERSATION_STATE_FILE}: ${err}`)
  }
}

// Load both from disk on startup, then migrate any old threadTs-keyed entries
loadConfirmedAgents()
loadConversationHistory()
loadConversationState()
migrateThreadTsKeys()

// Clean stale escalation state on restart — pending escalations and notifications from
// a prior session will never resolve (the user confirmation was lost when the bot crashed).
// Clear them so the next message routes normally instead of getting stuck in a hold loop.
if (pendingEscalations.size > 0 || escalationNotifications.size > 0) {
  if (pendingEscalations.size > 0) {
    console.log(`[STORE] startup: clearing ${pendingEscalations.size} stale pending escalation(s): [${[...pendingEscalations.keys()].join(", ")}]`)
    pendingEscalations.clear()
  }
  if (escalationNotifications.size > 0) {
    console.log(`[STORE] startup: clearing ${escalationNotifications.size} stale escalation notification(s): [${[...escalationNotifications.keys()].join(", ")}]`)
    escalationNotifications.clear()
  }
  persistConversationState()
}

export function getHistory(featureName: string): Message[] {
  return store.get(featureName) ?? []
}

// Returns pre-migration legacy messages (threadTs-keyed entries consolidated on startup).
// Used only by identifyUncommittedDecisions so that old conversations surface in the PENDING check.
// SOLO-TEAM SHORTCUT: all legacy goes to every featureName. See DECISIONS.md.
export function getLegacyMessages(): Message[] {
  return store.get("_legacy_") ?? []
}

// Clears legacy messages — used in test teardown to prevent disk-loaded legacy
// from leaking into tests that don't expect it.
export function clearLegacyMessages(): void {
  store.delete("_legacy_")
  persistConversationHistory()
}

export function appendMessage(threadTs: string, message: Message): void {
  const history = store.get(threadTs) ?? []
  history.push(message)
  store.set(threadTs, history)
  persistConversationHistory()
}

export function clearHistory(threadTs: string): void {
  store.delete(threadTs)
  confirmedAgents.delete(threadTs)
  pendingEscalations.delete(threadTs)
  pendingApprovals.delete(threadTs)
  persistConfirmedAgents()
  persistConversationHistory()
  persistConversationState()
}

// Once a user confirms an agent for a thread, store it so we skip confirmation on follow-ups
export function getConfirmedAgent(threadTs: string): string | null {
  return confirmedAgents.get(threadTs) ?? null
}

export function setConfirmedAgent(threadTs: string, agent: string): void {
  const previous = confirmedAgents.get(threadTs)
  // Phase transition: when the confirmed agent CHANGES (not first set), clear conversation
  // history for this feature. The incoming agent has all approved specs from GitHub in its
  // system prompt — raw prior-phase conversation is noise that causes hallucination.
  // Platform-level mechanism: applies to all current and future agents automatically.
  if (previous && previous !== agent) {
    const existingHistory = store.get(threadTs)
    if (existingHistory && existingHistory.length > 0) {
      console.log(`[STORE] phase-transition: ${previous} → ${agent} for feature=${threadTs} — clearing ${existingHistory.length} messages`)
      store.set(threadTs, [])
      persistConversationHistory()
    }
  }
  confirmedAgents.set(threadTs, agent)
  persistConfirmedAgents()
}

export function clearConfirmedAgent(featureName: string): void {
  confirmedAgents.delete(featureName)
}

// Pending escalation — set when an agent offers to pull another agent into the thread.
// Cleared when the user confirms (escalation runs) or declines (normal routing resumes).
export function getPendingEscalation(threadTs: string): PendingEscalation | null {
  return pendingEscalations.get(threadTs) ?? null
}

export function setPendingEscalation(threadTs: string, escalation: PendingEscalation): void {
  // Normalize inline numbered items (e.g. "1. gap one 2. gap two") to newline-separated
  // so Slack renders each gap on its own line instead of running them together
  const normalizedQuestion = escalation.question.replace(/(?<=[^\n])(\s+)(\d+\.\s)/g, "\n$2")
  console.log(`[STORE] setPendingEscalation: feature=${threadTs} targetAgent=${escalation.targetAgent}`)
  pendingEscalations.set(threadTs, { ...escalation, question: normalizedQuestion })
  persistConversationState()
}

export function clearPendingEscalation(threadTs: string): void {
  console.log(`[STORE] clearPendingEscalation: feature=${threadTs}`)
  pendingEscalations.delete(threadTs)
  persistConversationState()
}

export function getPendingApproval(threadTs: string): PendingApproval | null {
  return pendingApprovals.get(threadTs) ?? null
}

export function setPendingApproval(threadTs: string, approval: PendingApproval): void {
  console.log(`[STORE] setPendingApproval: feature=${threadTs} specType=${approval.specType}`)
  pendingApprovals.set(threadTs, approval)
  persistConversationState()
}

export function clearPendingApproval(threadTs: string): void {
  console.log(`[STORE] clearPendingApproval: feature=${threadTs}`)
  pendingApprovals.delete(threadTs)
  persistConversationState()
}

export function getEscalationNotification(featureName: string): EscalationNotification | null {
  return escalationNotifications.get(featureName) ?? null
}

export function setEscalationNotification(featureName: string, notification: EscalationNotification): void {
  console.log(`[STORE] setEscalationNotification: feature=${featureName} targetAgent=${notification.targetAgent}`)
  escalationNotifications.set(featureName, notification)
  persistConversationState()
}

export function clearEscalationNotification(featureName: string): void {
  console.log(`[STORE] clearEscalationNotification: feature=${featureName}`)
  escalationNotifications.delete(featureName)
  persistConversationState()
}
