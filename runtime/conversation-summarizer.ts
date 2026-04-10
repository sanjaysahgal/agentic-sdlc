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

// 60s timeout, no retries — summaries and checkpoint calls process moderate context
// but must not hang indefinitely. A stall should surface as an error, not a silent wait.
const anthropic = new Anthropic({ timeout: 60_000, maxRetries: 0 })

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
    .map((m) => `${m.role === "user" ? "User" : "Agent"}: ${m.content.slice(0, 2500)}`)
    .join("\n\n")

  const result = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: `You are checking whether anything was AGREED TO in this conversation that has not yet been saved to the spec.

COMMITTED SPEC (what is on GitHub):
---
${committedSpec}
---

CONVERSATION:
---
${formatted}
---

Count something as uncommitted ONLY if:
- The user actively agreed to it ("yes", "go with that", "approved", "let's do option 2", confirmed a specific value, etc.)
- AND it is not already in the committed spec above.

Do NOT count:
- Options the agent proposed but the user has not chosen yet
- Questions the agent asked that the user has not answered
- Clarifying discussions that ended without a decision
- Anything already present in the committed spec
- The user describing a regression, bug report, or past state ("we had fixed", "it used to", "it was working before", "it's back to") — these are complaints about what broke, not new agreements

If nothing was agreed to that is not already in the spec, respond with exactly: none

Otherwise, list each uncommitted agreed decision as a numbered list. For each item include the specific value agreed to: "1. [Decision]: [what was agreed, specific value]"`,
      },
    ],
  })

  const result_text = result.content[0].type === "text" ? result.content[0].text.trim() : ""
  if (cacheKey) summaryCache.set(`uncommitted:${cacheKey}`, result_text)
  return result_text
}

// Generates a structured checkpoint after a spec draft is saved.
// Returns committed decisions (what was just saved) and any uncommitted
// decisions still only in the thread. Both are formatted for Slack display.
//
// Non-fatal — callers .catch(() => null) so a Haiku failure never blocks the save.
export interface SaveCheckpoint {
  committed: string    // bullet list of key decisions now in the spec
  notCommitted: string // what's in thread but not in spec (empty = everything saved)
}

export async function generateSaveCheckpoint(
  savedContent: string,
  recentHistory: Message[],
): Promise<SaveCheckpoint> {
  const specPreview = savedContent.slice(0, 3000)
  const historyText = recentHistory
    .slice(-12)
    .map(m => `${m.role === "user" ? "User" : "Agent"}: ${m.content.slice(0, 400)}`)
    .join("\n\n")

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [{
      role: "user",
      content: `Compare this saved spec against the conversation to produce a save checkpoint.

SAVED SPEC:
---
${specPreview}
---

RECENT CONVERSATION:
---
${historyText}
---

Output EXACTLY this format (no preamble, no extra text):
COMMITTED:
• [decision 1 — be specific: colors, layout choices, interaction patterns, values]
• [decision 2]
• [decision 3, max 5 bullets total]
NOT_COMMITTED:
[Either write exactly "nothing — all discussed decisions are in the spec above" OR write a numbered list of specific things discussed in the conversation that do NOT appear in the saved spec above — e.g. "1. Glow shrinking over conversation (discussed, not in spec)"]`,
    }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  const committedMatch = text.match(/COMMITTED:\s*([\s\S]*?)(?=\nNOT_COMMITTED:|$)/i)
  const notCommittedMatch = text.match(/NOT_COMMITTED:\s*([\s\S]*)$/i)

  const committed = committedMatch?.[1]?.trim() ?? ""
  const raw = notCommittedMatch?.[1]?.trim() ?? ""
  const notCommitted = raw.toLowerCase().includes("nothing") || raw.toLowerCase().includes("all discussed")
    ? ""
    : raw

  return { committed, notCommitted }
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
