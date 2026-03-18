/**
 * Claude API client wrapper.
 * Handles conversation history and context injection for all agents.
 */

import Anthropic from "@anthropic-ai/sdk"

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface Message {
  role: "user" | "assistant"
  content: string
}

export async function chat(
  systemPrompt: string,
  context: string,
  history: Message[],
  userMessage: string
): Promise<string> {
  const messages: Message[] = [
    ...history,
    { role: "user", content: userMessage },
  ]

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: `${systemPrompt}\n\n${context}`,
    messages,
  })

  const content = response.content[0]
  if (content.type !== "text") throw new Error("Unexpected response type")
  return content.text
}
