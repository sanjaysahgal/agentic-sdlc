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
import {
  type FeatureKey,
  type ThreadKey,
  featureKeyToString,
  threadKeyToString,
} from "./routing/types"

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
  timestamp?: number      // when this escalation was set (for TTL cleanup)
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
  timestamp?: number      // when this approval was offered (for TTL cleanup)
}

// Pending decision review — set when the architect resolves open questions in a spec save.
// The spec content is held until the human confirms the decisions. If confirmed, the draft is saved.
// If rejected, the content is discarded and the architect continues.
export type PendingDecisionReview = {
  specContent: string
  filePath: string
  featureName: string
  resolvedQuestions: string[]
  timestamp?: number      // when this review was offered (for TTL cleanup)
}

const store = new Map<string, Message[]>()
const confirmedAgents = new Map<string, string>()                       // threadTs → confirmed agent type
const pendingEscalations = new Map<string, PendingEscalation>()         // threadTs → pending escalation
const pendingApprovals = new Map<string, PendingApproval>()             // threadTs → pending spec approval
const pendingDecisionReviews = new Map<string, PendingDecisionReview>() // threadTs → pending decision review
const escalationNotifications = new Map<string, EscalationNotification>() // featureName → active notification
const threadAgents = new Map<string, string>()                           // general channel threadTs → agent type (persisted)
const orientedUsers = new Set<string>()                                  // featureName:userId → oriented (persisted)

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

// Block D2 — exported for state-corruption recovery testing.
// Pure parse/populate function (no file I/O); takes a raw JSON string,
// returns a typed result. Malformed JSON, partial writes, and unknown
// fields are all handled forward-compatibly: unknown fields are silently
// ignored, parse errors return an empty result. The file-IO wrapper
// `loadConversationState()` calls this with the contents of the on-disk
// state file at startup. State-corruption recovery contract is asserted
// in `tests/integration/state-corruption.test.ts`.
export type ConversationStateLoadResult = {
  readonly pendingEscalations:      ReadonlyArray<readonly [string, PendingEscalation]>
  readonly pendingApprovals:        ReadonlyArray<readonly [string, PendingApproval]>
  readonly pendingDecisionReviews:  ReadonlyArray<readonly [string, PendingDecisionReview]>
  readonly escalationNotifications: ReadonlyArray<readonly [string, EscalationNotification]>
  readonly threadAgents:            ReadonlyArray<readonly [string, string]>
  readonly orientedUsers:           ReadonlyArray<string>
  readonly parseError?:             string  // present when JSON.parse threw; empty result returned
}

const EMPTY_LOAD_RESULT: ConversationStateLoadResult = {
  pendingEscalations:      [],
  pendingApprovals:        [],
  pendingDecisionReviews:  [],
  escalationNotifications: [],
  threadAgents:            [],
  orientedUsers:           [],
}

export function parseConversationState(raw: string): ConversationStateLoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // Partial write recovery: a SIGTERM mid-write can leave a half-written
    // JSON file. Return empty so the bot starts fresh rather than crashing
    // in a loop. The on-disk file gets overwritten on the next persist.
    return { ...EMPTY_LOAD_RESULT, parseError: String(e) }
  }

  // Defensive: if the parsed value is not an object, treat as empty.
  // Forward-compat: unknown top-level fields are silently ignored
  // (we read only the fields we know about).
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_LOAD_RESULT
  }
  const obj = parsed as {
    pendingEscalations?:      Record<string, PendingEscalation>
    pendingApprovals?:        Record<string, PendingApproval>
    pendingDecisionReviews?:  Record<string, PendingDecisionReview>
    escalationNotifications?: Record<string, EscalationNotification>
    threadAgents?:            Record<string, string>
    orientedUsers?:           string[]
  }

  // Defensive coercion: each section is treated as empty if absent or
  // malformed (e.g. someone hand-edited the file). Keeps load()
  // monotonic — partial corruption of one section doesn't drop others.
  const safeEntries = <T>(v: unknown): Array<[string, T]> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return []
    return Object.entries(v as Record<string, T>)
  }
  const safeArray = <T>(v: unknown): T[] => Array.isArray(v) ? v as T[] : []

  return {
    pendingEscalations:      safeEntries<PendingEscalation>(obj.pendingEscalations),
    pendingApprovals:        safeEntries<PendingApproval>(obj.pendingApprovals),
    pendingDecisionReviews:  safeEntries<PendingDecisionReview>(obj.pendingDecisionReviews),
    escalationNotifications: safeEntries<EscalationNotification>(obj.escalationNotifications),
    threadAgents:            safeEntries<string>(obj.threadAgents),
    orientedUsers:           safeArray<string>(obj.orientedUsers),
  }
}

function loadConversationState(): void {
  let raw: string
  try {
    raw = fs.readFileSync(CONVERSATION_STATE_FILE, "utf-8")
  } catch {
    // File doesn't exist yet — start fresh
    return
  }
  const result = parseConversationState(raw)
  if (result.parseError) {
    console.log(`[STORE] loadConversationState: parse error — starting fresh: ${result.parseError.slice(0, 200)}`)
  }
  for (const [k, v] of result.pendingEscalations)      pendingEscalations.set(k, v)
  for (const [k, v] of result.pendingApprovals)        pendingApprovals.set(k, v)
  for (const [k, v] of result.pendingDecisionReviews)  pendingDecisionReviews.set(k, v)
  for (const [k, v] of result.escalationNotifications) escalationNotifications.set(k, v)
  for (const [k, v] of result.threadAgents)            threadAgents.set(k, v)
  for (const key of result.orientedUsers)              orientedUsers.add(key)
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
  pendingDecisionReviews.clear()
  escalationNotifications.clear()
  threadAgents.clear()
  orientedUsers.clear()
}

function persistConversationState(): void {
  if (!_filePersistenceEnabled) return
  try {
    const obj = {
      pendingEscalations: Object.fromEntries(pendingEscalations),
      pendingApprovals: Object.fromEntries(pendingApprovals),
      pendingDecisionReviews: Object.fromEntries(pendingDecisionReviews),
      escalationNotifications: Object.fromEntries(escalationNotifications),
      threadAgents: Object.fromEntries(threadAgents),
      orientedUsers: [...orientedUsers],
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

// Escalation state is persisted to disk and survives restarts intentionally.
// The user's pending "yes" confirmation should still work after a bot restart.
// However, state older than 24h is stale — the user's context is lost and holding
// the feature in a dead loop is worse than a clean slate.
const PENDING_STATE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const startupNow = Date.now()

function clearStaleEntries<T extends { timestamp?: number }>(map: Map<string, T>, label: string): void {
  for (const [key, value] of map.entries()) {
    if (!value.timestamp || (startupNow - value.timestamp > PENDING_STATE_TTL_MS)) {
      const ageMinutes = value.timestamp ? Math.round((startupNow - value.timestamp) / 1000 / 60) : "unknown"
      console.log(`[STORE] startup: clearing stale ${label} for ${key} (age: ${ageMinutes} min)`)
      map.delete(key)
    }
  }
}

clearStaleEntries(pendingEscalations, "pendingEscalation")
clearStaleEntries(pendingApprovals, "pendingApproval")
clearStaleEntries(pendingDecisionReviews, "pendingDecisionReview")
// escalationNotifications don't have timestamps — clear all on restart
// (the agent response was captured but the human may not remember the context)
if (escalationNotifications.size > 0) {
  console.log(`[STORE] startup: clearing ${escalationNotifications.size} stale escalation notification(s)`)
  escalationNotifications.clear()
}
if (pendingEscalations.size > 0 || pendingApprovals.size > 0 || pendingDecisionReviews.size > 0) {
  persistConversationState()
}

if (pendingEscalations.size > 0) {
  console.log(`[STORE] startup: restored ${pendingEscalations.size} pending escalation(s): [${[...pendingEscalations.keys()].join(", ")}]`)
}
if (escalationNotifications.size > 0) {
  console.log(`[STORE] startup: restored ${escalationNotifications.size} escalation notification(s): [${[...escalationNotifications.keys()].join(", ")}]`)
}

export function getHistory(key: FeatureKey): Message[] {
  return store.get(featureKeyToString(key)) ?? []
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

export function appendMessage(key: FeatureKey, message: Message): void {
  const flat = featureKeyToString(key)
  const history = store.get(flat) ?? []
  history.push(message)
  store.set(flat, history)
  persistConversationHistory()
}

export function clearHistory(key: FeatureKey): void {
  const flat = featureKeyToString(key)
  store.delete(flat)
  confirmedAgents.delete(flat)
  pendingEscalations.delete(flat)
  pendingApprovals.delete(flat)
  pendingDecisionReviews.delete(flat)
  persistConfirmedAgents()
  persistConversationHistory()
  persistConversationState()
}

// Once a user confirms an agent for a thread, store it so we skip confirmation on follow-ups
export function getConfirmedAgent(key: FeatureKey): string | null {
  return confirmedAgents.get(featureKeyToString(key)) ?? null
}

export function setConfirmedAgent(key: FeatureKey, agent: string): void {
  const flat = featureKeyToString(key)
  const previous = confirmedAgents.get(flat)
  // Phase transition: when the confirmed agent CHANGES (not first set), clear conversation
  // history for this feature. The incoming agent has all approved specs from GitHub in its
  // system prompt — raw prior-phase conversation is noise that causes hallucination.
  // Platform-level mechanism: applies to all current and future agents automatically.
  if (previous && previous !== agent) {
    const existingHistory = store.get(flat)
    if (existingHistory && existingHistory.length > 0) {
      console.log(`[STORE] phase-transition: ${previous} → ${agent} for feature=${flat} — clearing ${existingHistory.length} messages`)
      store.set(flat, [])
      persistConversationHistory()
    }
  }
  confirmedAgents.set(flat, agent)
  persistConfirmedAgents()
}

export function clearConfirmedAgent(key: FeatureKey): void {
  confirmedAgents.delete(featureKeyToString(key))
}

// Thread agent — tracks which agent owns a general channel thread (persisted across restarts).
// Set when a slash command starts a thread; used by app.ts to route follow-up messages.
export function getThreadAgent(key: ThreadKey): string | null {
  return threadAgents.get(threadKeyToString(key)) ?? null
}

export function setThreadAgent(key: ThreadKey, agent: string): void {
  const flat = threadKeyToString(key)
  threadAgents.set(flat, agent)
  persistConversationState()
  console.log(`[STORE] setThreadAgent: ${agent} for general:${flat}`)
}

// Oriented users — tracks which users have been oriented in each feature (persisted across restarts).
// Prevents re-orientation after bot restart, which was causing returning users to see welcome messages.
// TRIGGER-JUSTIFIED: isUserOriented is a persistence accessor (reads from persisted Set), not a classifier.
// It runs on every message to check orientation state — not trigger-dependent.
export function isUserOriented(key: FeatureKey, userId: string): boolean {
  return orientedUsers.has(`${featureKeyToString(key)}:${userId}`)
}

export function markUserOriented(key: FeatureKey, userId: string): void {
  const flatKey = `${featureKeyToString(key)}:${userId}`
  if (!orientedUsers.has(flatKey)) {
    orientedUsers.add(flatKey)
    persistConversationState()
    console.log(`[STORE] markUserOriented: ${flatKey}`)
  }
}

// Pending escalation — set when an agent offers to pull another agent into the thread.
// Cleared when the user confirms (escalation runs) or declines (normal routing resumes).
export function getPendingEscalation(key: FeatureKey): PendingEscalation | null {
  return pendingEscalations.get(featureKeyToString(key)) ?? null
}

export function setPendingEscalation(key: FeatureKey, escalation: PendingEscalation): void {
  // Normalize inline numbered items (e.g. "1. gap one 2. gap two") to newline-separated
  // so Slack renders each gap on its own line instead of running them together
  const normalizedQuestion = escalation.question.replace(/(?<=[^\n])(\s+)(\d+\.\s)/g, "\n$2")
  const flat = featureKeyToString(key)
  console.log(`[STORE] setPendingEscalation: feature=${flat} targetAgent=${escalation.targetAgent}`)
  pendingEscalations.set(flat, { ...escalation, question: normalizedQuestion, timestamp: Date.now() })
  persistConversationState()
}

export function clearPendingEscalation(key: FeatureKey): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] clearPendingEscalation: feature=${flat}`)
  pendingEscalations.delete(flat)
  persistConversationState()
}

export function getPendingApproval(key: FeatureKey): PendingApproval | null {
  return pendingApprovals.get(featureKeyToString(key)) ?? null
}

export function setPendingApproval(key: FeatureKey, approval: PendingApproval): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] setPendingApproval: feature=${flat} specType=${approval.specType}`)
  pendingApprovals.set(flat, { ...approval, timestamp: Date.now() })
  persistConversationState()
}

export function clearPendingApproval(key: FeatureKey): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] clearPendingApproval: feature=${flat}`)
  pendingApprovals.delete(flat)
  persistConversationState()
}

export function getPendingDecisionReview(key: FeatureKey): PendingDecisionReview | null {
  return pendingDecisionReviews.get(featureKeyToString(key)) ?? null
}

export function setPendingDecisionReview(key: FeatureKey, review: PendingDecisionReview): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] setPendingDecisionReview: feature=${flat} resolvedQuestions=${review.resolvedQuestions.length}`)
  pendingDecisionReviews.set(flat, { ...review, timestamp: Date.now() })
  persistConversationState()
}

export function clearPendingDecisionReview(key: FeatureKey): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] clearPendingDecisionReview: feature=${flat}`)
  pendingDecisionReviews.delete(flat)
  persistConversationState()
}

export function getEscalationNotification(key: FeatureKey): EscalationNotification | null {
  return escalationNotifications.get(featureKeyToString(key)) ?? null
}

export function setEscalationNotification(key: FeatureKey, notification: EscalationNotification): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] setEscalationNotification: feature=${flat} targetAgent=${notification.targetAgent}`)
  escalationNotifications.set(flat, notification)
  persistConversationState()
}

export function clearEscalationNotification(key: FeatureKey): void {
  const flat = featureKeyToString(key)
  console.log(`[STORE] clearEscalationNotification: feature=${flat}`)
  escalationNotifications.delete(flat)
  persistConversationState()
}
