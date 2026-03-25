// Posts a "Thinking..." placeholder immediately, then updates it with the real response.
// This gives instant visual feedback while the agent processes.

import { incrementActiveRequests, decrementActiveRequests } from "../../../runtime/request-tracker"

export async function withThinking(params: {
  client: any
  channelId: string
  threadTs: string
  agent?: string
  run: (update: (text: string) => Promise<void>) => Promise<void>
}): Promise<void> {
  const { client, channelId, threadTs, agent, run } = params

  const label = agent ? `_${agent} is thinking..._` : "_Thinking..._"

  // Post placeholder immediately so the user knows we received their message
  const placeholder = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: label,
  })

  const messageTs = placeholder.ts

  // Slack's text limit is 40,000 chars. Truncate long responses at a paragraph
  // boundary rather than letting chat.update fail with msg_too_long.
  const SLACK_MAX_CHARS = 12_000  // Slack's practical limit is lower than the documented 40k in busy threads
  function truncateForSlack(text: string): string {
    if (text.length <= SLACK_MAX_CHARS) return text
    const cutoff = text.lastIndexOf("\n\n", SLACK_MAX_CHARS)
    const end = cutoff > 0 ? cutoff : SLACK_MAX_CHARS
    return text.slice(0, end) + "\n\n_[Response truncated — see the spec link above for full details.]_"
  }

  // update() replaces the placeholder with the real content.
  // Agent label is prepended so the user always knows who is responding.
  // If chat.update rejects with msg_too_long, retry with progressively shorter content.
  const agentPrefix = agent ? `*${agent}*\n\n` : ""
  const update = async (text: string) => {
    let truncated = truncateForSlack(`${agentPrefix}${text}`)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.chat.update({ channel: channelId, ts: messageTs, text: truncated })
        return
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes("msg_too_long")) throw err
        // Halve the limit and retry
        const limit = Math.floor(truncated.length / 2)
        const cutoff = truncated.lastIndexOf("\n\n", limit)
        truncated = truncated.slice(0, cutoff > 0 ? cutoff : limit) + "\n\n_[Response truncated.]_"
      }
    }
    await client.chat.update({ channel: channelId, ts: messageTs, text: truncated })
  }

  incrementActiveRequests()
  try {
    await run(update)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const isOverloaded = errMsg.includes("overloaded")
    const isImageError = errMsg.includes("Could not process image") || errMsg.includes("image.source")
    const isSlackTooLong = errMsg.includes("msg_too_long")
    // Anthropic surfaces context limit errors with several different phrasings depending on
    // the SDK version and error path — check all known variants
    const isContextLimit =
      errMsg.includes("too long") ||
      errMsg.includes("context_length") ||
      errMsg.includes("context length") ||
      errMsg.includes("prompt is too long") ||
      errMsg.includes("Input too long") ||
      errMsg.includes("exceeded") && errMsg.includes("token") ||
      errMsg.includes("token") && errMsg.includes("maximum") ||
      errMsg.includes("maximum context") ||
      errMsg.includes("reduce the length")
    const msg = isSlackTooLong
      ? "The response was too long for Slack. Any draft has been saved to GitHub — check the spec link above. Ask a follow-up question to continue."
      : isOverloaded
      ? "The AI is overloaded right now. Please try again in a moment."
      : isImageError
        ? "I couldn't process the attached image. Try sending it as a PNG screenshot instead of directly from the camera roll."
        : isContextLimit
          ? ":warning: *This thread is too long for the AI to continue.* Your spec is saved on GitHub — nothing is lost.\n\nStart a fresh top-level message (not a reply here) and say: *\"Continuing onboarding design — check the spec on GitHub for current state.\"* The agent will read the spec and pick up exactly where you left off."
          : "Something went wrong. Please try again. If this keeps happening, start a fresh top-level message (not a reply) — the thread may have grown too long."

    // Structured error log — every field needed to diagnose a production failure
    console.error(JSON.stringify({
      level: "error",
      timestamp: new Date().toISOString(),
      agent,
      channel: channelId,
      thread: threadTs,
      errorType: err instanceof Error ? err.constructor.name : "UnknownError",
      errorMessage: errMsg,
      stack: err instanceof Error ? err.stack : undefined,
    }))

    // If update() fails (stale message TS, rate limit), post a new message as fallback
    await update(msg).catch(() => {
      client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: msg }).catch(() => {})
    })
    throw err
  } finally {
    decrementActiveRequests()
  }
}
