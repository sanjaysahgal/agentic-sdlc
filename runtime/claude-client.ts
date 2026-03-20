import Anthropic from "@anthropic-ai/sdk"
import { Message } from "./conversation-store"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function runAgent(params: {
  systemPrompt: string
  history: Message[]
  userMessage: string
}): Promise<string> {
  const { systemPrompt, history, userMessage } = params

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({
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
