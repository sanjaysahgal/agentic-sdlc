import Anthropic from "@anthropic-ai/sdk"
import { Message } from "./conversation-store"

// 5 minute timeout, no retries — agents generate large drafts that take time, but a
// timed-out request won't succeed on retry; it just multiplies the user's wait.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 0 })

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

export type ToolHandler = (
  name: string,
  input: Record<string, unknown>
) => Promise<{ result?: unknown; error?: string }>

// Tracks which tools were called during a single runAgent() invocation.
// Callers can inspect this after the call to detect unsaved decisions.
export type ToolCallRecord = { name: string; input: Record<string, unknown> }

// Splits a system prompt string at a known stable/dynamic boundary for prompt caching.
// Block 1 (stable, cached): persona, workflow, tools, spec format — never changes for a given workspace.
// Block 2 (dynamic, uncached): currentDraft, approvedSpecs — changes as the spec evolves.
// If marker is not found, falls back to single cached block (safe but not optimal).
export function splitSystemPrompt(prompt: string, dynamicMarker: string): Anthropic.TextBlockParam[] {
  const idx = prompt.indexOf(dynamicMarker)
  if (idx === -1) return [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }]
  return [
    { type: "text", text: prompt.slice(0, idx), cache_control: { type: "ephemeral" } },
    { type: "text", text: prompt.slice(idx) },
  ]
}

export async function runAgent(params: {
  systemPrompt: string | Anthropic.TextBlockParam[]
  history: Message[]
  userMessage: string
  userImages?: UserImage[]
  historyLimit?: number
  tools?: Anthropic.Tool[]
  toolHandler?: ToolHandler
  toolCallsOut?: ToolCallRecord[]  // Optional output — caller passes [] to collect records
  /** When any tool in this list is called, strip tools from the next API call so the model
   *  wraps up its response and the loop exits. Used for escalation-stops-the-turn enforcement. */
  forceStopToolNames?: string[]
}): Promise<string> {
  const { systemPrompt, history, userMessage, userImages, historyLimit = HISTORY_LIMIT, tools, toolHandler, toolCallsOut, forceStopToolNames } = params

  const systemBlocks: Anthropic.TextBlockParam[] = Array.isArray(systemPrompt)
    ? systemPrompt
    : [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]

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

  // Tool-use loop. When no tools are provided, this executes exactly once (single API call,
  // same behaviour as before). When tools are provided, the loop continues until the model
  // stops with "end_turn" (no more tool calls to make).
  let forceStopFired = false  // Set when a force-stop tool is called — next iteration strips tools
  while (true) {
    // When forceStopFired, strip tools so the model must produce end_turn (wraps up its response).
    const effectiveTools = forceStopFired ? undefined : tools
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: AGENT_MODEL,
      max_tokens: 64000,
      system: systemBlocks,
      messages,
      ...(effectiveTools && effectiveTools.length > 0 ? { tools: effectiveTools } : {}),
    }

    const response: Anthropic.Message = await client.messages.create(requestParams)

    if (response.usage) {
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = response.usage
      console.log(`[tokens] model=${AGENT_MODEL} in=${input_tokens} out=${output_tokens} cache_hit=${cache_read_input_tokens ?? 0} cache_write=${cache_creation_input_tokens ?? 0} history_msgs=${messages.length - 1}`)
    }

    // If the model finished with no tool calls, extract and return the final text.
    if (response.stop_reason === "end_turn" || !tools || tools.length === 0) {
      const block = response.content.find(b => b.type === "text")
      const text = block?.type === "text" ? block.text : ""
      console.log(`[AGENT-RESPONSE] ${text.slice(0, 500)}`)
      return text
    }

    // stop_reason === "tool_use" — execute all tool calls and feed results back.
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")

    if (toolUseBlocks.length === 0) {
      // No tool_use blocks despite stop_reason — treat as end_turn
      const block = response.content.find(b => b.type === "text")
      return block?.type === "text" ? block.text : ""
    }

    // Execute all tool calls (in parallel — tools are independent within a single turn).
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        if (toolCallsOut) {
          toolCallsOut.push({ name: toolUse.name, input: toolUse.input as Record<string, unknown> })
        }

        if (!toolHandler) {
          console.error(`[tool] No toolHandler provided but agent called tool: ${toolUse.name}`)
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Error: No tool handler registered for "${toolUse.name}"`,
          }
        }

        try {
          console.log(`[tool] calling ${toolUse.name}`, JSON.stringify(toolUse.input).slice(0, 120))
          const outcome = await toolHandler(toolUse.name, toolUse.input as Record<string, unknown>)
          const content = outcome.error
            ? `Error: ${outcome.error}`
            : JSON.stringify(outcome.result ?? {})
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            is_error: outcome.error !== undefined,
            content,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[tool] ${toolUse.name} threw: ${msg}`)
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            is_error: true,
            content: `Error: ${msg}`,
          }
        }
      })
    )

    // Check if a force-stop tool was called in this batch. If so, set the flag —
    // the next iteration will strip tools, forcing the model to wrap up.
    if (forceStopToolNames && forceStopToolNames.length > 0) {
      const batchNames = toolUseBlocks.map(b => b.name)
      if (forceStopToolNames.some(n => batchNames.includes(n))) {
        console.log(`[FORCE-STOP] Tool ${batchNames.filter(n => forceStopToolNames.includes(n)).join(",")} triggered turn stop — next iteration will strip tools`)
        forceStopFired = true
      }
    }

    // Append the assistant turn (with its tool_use blocks) + the tool results turn,
    // then loop for the next API call.
    messages.push({ role: "assistant", content: response.content })
    messages.push({ role: "user", content: toolResults })
  }
}
