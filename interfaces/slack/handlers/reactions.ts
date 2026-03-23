// Listens for 👍/👎 reactions on bot messages and saves them to the feedback log.
// This creates a lightweight production signal for measuring response quality over time.
// The saved records are the raw material for improving agent prompts and golden eval scenarios.

import { saveUserFeedback } from "../../../runtime/github-client"

export function registerReactionHandlers(app: any): void {
  app.event("reaction_added", async ({ event, client }: { event: any; client: any }) => {
    // Only track thumbs up/down
    if (!["thumbsup", "thumbsdown"].includes(event.reaction)) return
    if (event.item.type !== "message") return

    try {
      // Fetch the message that was reacted to plus the one before it (for user message context).
      // conversations.history returns most-recent first — inclusive: true includes the target message.
      const result = await client.conversations.history({
        channel: event.item.channel,
        latest: event.item.ts,
        limit: 3,
        inclusive: true,
      })

      const messages: any[] = result.messages ?? []
      const reactedMsg = messages.find((m: any) => m.ts === event.item.ts)

      // Only record reactions on bot messages — ignore human-to-human reactions
      if (!reactedMsg?.bot_id) return

      // Best-effort: the preceding non-bot message is likely what triggered the response
      const userMsg = messages.find((m: any) => m.ts !== event.item.ts && !m.bot_id)

      await saveUserFeedback({
        timestamp:     new Date().toISOString(),
        channel:       event.item.channel,
        messageTs:     event.item.ts,
        rating:        event.reaction === "thumbsup" ? "positive" : "negative",
        agentResponse: reactedMsg.text ?? "",
        userMessage:   userMsg?.text ?? "",
        reactingUser:  event.user,
      })
    } catch {
      // Non-fatal — reaction tracking must never interrupt the conversation
    }
  })
}
