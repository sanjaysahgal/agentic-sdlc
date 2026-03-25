// Summarizes the overflow portion of a conversation (messages beyond the history limit)
// so the agent can pick up in-progress discussion without needing the full token payload.
//
// Only fires when history.length > historyLimit. The summary is injected into the user
// message as prior context — the agent sees it as conversation state, not raw history.

import Anthropic from "@anthropic-ai/sdk"
import type { Message } from "./conversation-store"

const anthropic = new Anthropic()

export async function summarizeUnlockedDiscussion(olderMessages: Message[]): Promise<string> {
  if (olderMessages.length === 0) return ""

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

  return result.content[0].type === "text" ? result.content[0].text.trim() : ""
}

export function buildEnrichedMessage(params: {
  userMessage: string
  lockedDecisions: string
  priorContext: string
}): string {
  const { userMessage, lockedDecisions, priorContext } = params
  const parts: string[] = []

  if (priorContext) {
    parts.push(`[Prior conversation context — in progress, not yet locked:\n${priorContext}]`)
  }
  if (lockedDecisions) {
    parts.push(`[Decisions locked in this conversation:\n${lockedDecisions}]`)
  }
  parts.push(userMessage)

  return parts.join("\n\n")
}
