import Anthropic from "@anthropic-ai/sdk"
import { Message } from "./conversation-store"

// 90 second timeout — long enough for complex spec responses, short enough
// to surface a clean error in Slack rather than hanging indefinitely.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000 })

// Cap history at 40 messages (20 exchanges) to prevent token explosion on long threads.
// The system prompt + context already carries the full spec state — the agent
// doesn't need the full conversation history to stay coherent.
// 40 is enough for a full design conversation; the auto-save draft mechanism
// means agreed decisions are in the spec even if they scroll out of history.
const HISTORY_LIMIT = 40

export async function runAgent(params: {
  systemPrompt: string
  history: Message[]
  userMessage: string
}): Promise<string> {
  const { systemPrompt, history, userMessage } = params

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-HISTORY_LIMIT).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ]

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  })

  const block = response.content[0]
  return block.type === "text" ? block.text : ""
}
