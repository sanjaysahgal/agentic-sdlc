// Stores conversation history per Slack thread.
// Keyed by thread_ts (Slack's unique thread identifier).
// In production this would be Redis — for now in-memory + file persistence is sufficient.

import fs from "fs"
import path from "path"

export type Message = {
  role: "user" | "assistant"
  content: string
}

const store = new Map<string, Message[]>()
const confirmedAgents = new Map<string, string>() // threadTs → confirmed agent type

const CONFIRMED_AGENTS_FILE = path.join(__dirname, "../.confirmed-agents.json")

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

// Load from disk on startup
loadConfirmedAgents()

export function getHistory(threadTs: string): Message[] {
  return store.get(threadTs) ?? []
}

export function appendMessage(threadTs: string, message: Message): void {
  const history = store.get(threadTs) ?? []
  history.push(message)
  store.set(threadTs, history)
}

export function clearHistory(threadTs: string): void {
  store.delete(threadTs)
  confirmedAgents.delete(threadTs)
  persistConfirmedAgents()
}

// Once a user confirms an agent for a thread, store it so we skip confirmation on follow-ups
export function getConfirmedAgent(threadTs: string): string | null {
  return confirmedAgents.get(threadTs) ?? null
}

export function setConfirmedAgent(threadTs: string, agent: string): void {
  confirmedAgents.set(threadTs, agent)
  persistConfirmedAgents()
}
