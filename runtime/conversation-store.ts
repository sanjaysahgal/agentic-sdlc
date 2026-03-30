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
  targetAgent: "pm"
  question: string    // the specific blocking question to hand to the PM
  designContext: string // current design draft — gives PM instant context
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
const confirmedAgents = new Map<string, string>()         // threadTs → confirmed agent type
const pendingEscalations = new Map<string, PendingEscalation>() // threadTs → pending escalation
const pendingApprovals = new Map<string, PendingApproval>()     // threadTs → pending spec approval

const CONFIRMED_AGENTS_FILE = path.join(__dirname, "../.confirmed-agents.json")
const CONVERSATION_HISTORY_FILE = path.join(__dirname, "../.conversation-history.json")

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
  const obj = Object.fromEntries(confirmedAgents)
  fs.writeFileSync(CONFIRMED_AGENTS_FILE, JSON.stringify(obj, null, 2))
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
  const obj = Object.fromEntries(store)
  fs.writeFileSync(CONVERSATION_HISTORY_FILE, JSON.stringify(obj, null, 2))
}

// Load both from disk on startup, then migrate any old threadTs-keyed entries
loadConfirmedAgents()
loadConversationHistory()
migrateThreadTsKeys()

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
}

// Once a user confirms an agent for a thread, store it so we skip confirmation on follow-ups
export function getConfirmedAgent(threadTs: string): string | null {
  return confirmedAgents.get(threadTs) ?? null
}

export function setConfirmedAgent(threadTs: string, agent: string): void {
  confirmedAgents.set(threadTs, agent)
  persistConfirmedAgents()
}

// Pending escalation — set when an agent offers to pull another agent into the thread.
// Cleared when the user confirms (escalation runs) or declines (normal routing resumes).
export function getPendingEscalation(threadTs: string): PendingEscalation | null {
  return pendingEscalations.get(threadTs) ?? null
}

export function setPendingEscalation(threadTs: string, escalation: PendingEscalation): void {
  pendingEscalations.set(threadTs, escalation)
}

export function clearPendingEscalation(threadTs: string): void {
  pendingEscalations.delete(threadTs)
}

export function getPendingApproval(threadTs: string): PendingApproval | null {
  return pendingApprovals.get(threadTs) ?? null
}

export function setPendingApproval(threadTs: string, approval: PendingApproval): void {
  pendingApprovals.set(threadTs, approval)
}

export function clearPendingApproval(threadTs: string): void {
  pendingApprovals.delete(threadTs)
}
