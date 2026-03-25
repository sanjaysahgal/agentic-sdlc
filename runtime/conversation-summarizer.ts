// Summarizes the overflow portion of a conversation (messages beyond the history limit)
// so the agent can pick up in-progress discussion without needing the full token payload.
//
// Only fires when history.length > historyLimit. The summary is injected into the user
// message as prior context — the agent sees it as conversation state, not raw history.
//
// Cache: keyed by (threadTs, olderMessageCount). Older messages never change (new ones
// are always appended), so the cache is valid as long as the overflow count hasn't grown.

import Anthropic from "@anthropic-ai/sdk"
import type { Message } from "./conversation-store"

const anthropic = new Anthropic()

// Cache key: `${threadTs}:${olderMessageCount}`
const summaryCache = new Map<string, string>()

export function clearSummaryCache(threadTs: string): void {
  for (const key of summaryCache.keys()) {
    if (key.startsWith(`${threadTs}:`) || key.startsWith(`uncommitted:${threadTs}:`)) summaryCache.delete(key)
  }
}

export async function summarizeUnlockedDiscussion(
  olderMessages: Message[],
  cacheKey?: string,
): Promise<string> {
  if (olderMessages.length === 0) return ""

  if (cacheKey) {
    const cached = summaryCache.get(cacheKey)
    if (cached !== undefined) return cached
  }

  const formatted = olderMessages
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content.slice(0, 800)}`)
    .join("\n\n")

  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `The following is an older portion of an ongoing conversation between a user and an AI agent (PM, designer, or architect). Summarize what was being discussed that has NOT been formally locked or approved yet — in-progress ideas, open questions, directions being iterated on, and context that would help the agent pick up where the conversation left off.

Be concise (3-6 bullet points). Focus on UNLOCKED content only — skip anything explicitly approved, locked, or already committed to the spec.

---
${formatted}
---

Summary of in-progress discussion (unlocked only):`,
      },
    ],
  })

  const summary = result.content[0].type === "text" ? result.content[0].text.trim() : ""
  if (cacheKey) summaryCache.set(cacheKey, summary)
  return summary
}

export function buildEnrichedMessage(params: {
  userMessage: string
  lockedDecisions: string
  priorContext: string
}): string {
  const { userMessage, lockedDecisions, priorContext } = params
  const parts: string[] = []

  if (priorContext) {
    parts.push(`[Background from earlier in this thread — these topics were discussed but NEVER COMMITTED to GitHub. Do not rebuild the spec or treat these as locked decisions. Use this only to understand where the conversation left off. Confirm with the user before acting:\n${priorContext}]`)
  }
  if (lockedDecisions) {
    parts.push(`[Decisions locked in this conversation:\n${lockedDecisions}]`)
  }
  parts.push(userMessage)

  return parts.join("\n\n")
}

// Compares conversation history against a committed spec and returns bullet points
// of decisions discussed in the thread that are NOT yet reflected in the spec.
// Used on the state query path so users can see exactly what was lost.
export async function identifyUncommittedDecisions(
  history: Message[],
  committedSpec: string,
  cacheKey?: string,
): Promise<string> {
  if (history.length === 0) return ""

  if (cacheKey) {
    const cached = summaryCache.get(`uncommitted:${cacheKey}`)
    if (cached !== undefined) return cached
  }

  const formatted = history
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content.slice(0, 600)}`)
    .join("\n\n")

  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `You are comparing a conversation to a committed spec to find what was discussed but never saved.

COMMITTED SPEC (what is on GitHub):
---
${committedSpec.slice(0, 3000)}
---

CONVERSATION HISTORY:
---
${formatted}
---

List decisions or directions that were DISCUSSED in the conversation but are NOT reflected in the committed spec above. Be specific — name the actual decision (e.g. "Dark mode as default — Archon palette #0A0A0F background", not just "dark mode").

Format: numbered list (1. 2. 3.), 3-6 items. For each item, include a concrete recommendation from the agent: "1. [Decision]: I recommend [X] — [brief reason from the thread]"

If everything discussed is already in the spec, respond with exactly: "All discussed decisions appear to be in the committed spec."`,
      },
    ],
  })

  const result_text = result.content[0].type === "text" ? result.content[0].text.trim() : ""
  if (cacheKey) summaryCache.set(`uncommitted:${cacheKey}`, result_text)
  return result_text
}

// Helper used by each agent handler — encapsulates the limit check, cache key, and call.
export async function getPriorContext(
  threadTs: string,
  history: Message[],
  historyLimit: number,
): Promise<string> {
  if (history.length <= historyLimit) return ""
  const olderMessages = history.slice(0, -historyLimit)
  const cacheKey = `${threadTs}:${olderMessages.length}`
  return summarizeUnlockedDiscussion(olderMessages, cacheKey).catch(() => "")
}
