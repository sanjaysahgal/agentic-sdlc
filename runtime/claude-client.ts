import Anthropic from "@anthropic-ai/sdk"
import { Message } from "./conversation-store"

// 5 minute timeout — design and PM agents generate full spec drafts that can take
// several minutes. 90s was too short and caused spurious timeouts on complex responses.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000 })

// In dev mode, use Haiku for all agent calls — 5x cheaper, safe for testing routing/formatting/structure.
const AGENT_MODEL = process.env.SDLC_DEV_MODE === "true"
  ? "claude-haiku-4-5-20251001"
  : "claude-sonnet-4-6"

// Cap history at 40 messages (20 exchanges) to prevent token explosion on long threads.
// The system prompt + context already carries the full spec state — the agent
// doesn't need the full conversation history to stay coherent.
// 40 is enough for a full design conversation; the auto-save draft mechanism
// means agreed decisions are in the spec even if they scroll out of history.
const HISTORY_LIMIT = 40

export type UserImage = { data: string; mediaType: string }

export async function runAgent(params: {
  systemPrompt: string
  history: Message[]
  userMessage: string
  userImages?: UserImage[]
  historyLimit?: number
}): Promise<string> {
  const { systemPrompt, history, userMessage, userImages, historyLimit = HISTORY_LIMIT } = params

  const userContent: Anthropic.ContentBlockParam[] | string =
    userImages && userImages.length > 0
      ? [
          ...userImages.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.data,
            },
          })),
          { type: "text" as const, text: userMessage || "Please look at the attached image." },
        ]
      : userMessage

  const raw: Anthropic.MessageParam[] = [
    ...history.slice(-historyLimit).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user", content: userContent },
  ]

  // Sanitize: Anthropic requires messages to start with "user" and strictly alternate roles.
  // Corrupted history (e.g. leading assistant messages from a fast-path bug, consecutive
  // same-role entries from failed retries) would cause a 400 and show "Something went wrong".
  // Strip leading assistant messages, then collapse consecutive same-role entries (keep last).
  const messages: Anthropic.MessageParam[] = []
  for (const msg of raw) {
    if (messages.length === 0) {
      if (msg.role === "user") messages.push(msg)
      // skip any leading assistant messages
    } else if (msg.role !== messages[messages.length - 1].role) {
      messages.push(msg)
    } else {
      // consecutive same role — replace with the more recent one
      messages[messages.length - 1] = msg
    }
  }

  const response = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 64000, // Sonnet 4.6 ceiling — never an arbitrary limit we manage
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages,
  })

  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = response.usage
  console.log(`[tokens] model=${AGENT_MODEL} in=${input_tokens} out=${output_tokens} cache_hit=${cache_read_input_tokens ?? 0} cache_write=${cache_creation_input_tokens ?? 0} history_msgs=${messages.length - 1}`)

  const block = response.content[0]
  return block.type === "text" ? block.text : ""
}
