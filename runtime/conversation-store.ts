// Stores conversation history per Slack thread.
// Keyed by thread_ts (Slack's unique thread identifier).
// In production this would be Redis — for now in-memory is sufficient.

export type Message = {
  role: "user" | "assistant"
  content: string
}

const store = new Map<string, Message[]>()
const confirmedAgents = new Map<string, string>() // threadTs → confirmed agent type

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
}

// Once a user confirms an agent for a thread, store it so we skip confirmation on follow-ups
export function getConfirmedAgent(threadTs: string): string | null {
  return confirmedAgents.get(threadTs) ?? null
}

export function setConfirmedAgent(threadTs: string, agent: string): void {
  confirmedAgents.set(threadTs, agent)
}
