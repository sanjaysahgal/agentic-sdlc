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
  console.log(`[J3-SYNTHETIC] verifying hook fires`)

  const label = agent ? `_${agent} is thinking..._` : "_Thinking..._"

  // Post placeholder immediately so the user knows we received their message
  const placeholder = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: label,
  })

  const messageTs = placeholder.ts

  // Slack's practical text limit per message is ~4,000 chars in busy threads
  // (the documented 40k limit is never reached in practice with mrkdwn formatting).
  // For responses longer than this, post the first part as the main update and
  // overflow as thread replies — no content is ever truncated or lost.
  const SLACK_SAFE_CHARS = 3_800

  function splitForSlack(text: string): string[] {
    if (text.length <= SLACK_SAFE_CHARS) return [text]
    const parts: string[] = []
    let remaining = text
    while (remaining.length > SLACK_SAFE_CHARS) {
      // Prefer splitting at a major section boundary (---), then paragraph, then line
      let cutoff = remaining.lastIndexOf("\n---\n", SLACK_SAFE_CHARS)
      if (cutoff < 100) cutoff = remaining.lastIndexOf("\n\n", SLACK_SAFE_CHARS)
      if (cutoff < 100) cutoff = remaining.lastIndexOf("\n", SLACK_SAFE_CHARS)
      if (cutoff < 100) cutoff = SLACK_SAFE_CHARS
      parts.push(remaining.slice(0, cutoff).trimEnd())
      remaining = remaining.slice(cutoff).trimStart()
    }
    if (remaining) parts.push(remaining)
    return parts
  }

  // update() replaces the placeholder with the first chunk, then posts overflow
  // as thread replies. Agent label prepended to first chunk only.
  const agentPrefix = agent ? `*${agent}*\n\n` : ""

  // Heartbeat: cycle trailing dots on the last status text every 8s so the user
  // can always see that something is happening — even during long silent API calls.
  let lastStatusText = label
  let heartbeatStep = 0
  const heartbeat = setInterval(async () => {
    if (finalResponseSent) return  // Guard: don't overwrite the real response
    heartbeatStep = (heartbeatStep % 3) + 1
    const dots = ".".repeat(heartbeatStep)
    // Strip any trailing dots and the closing italic marker so we can
    // reattach a fresh dot count — avoids ambiguity when the existing
    // dot count equals the new count (would produce an identical string).
    const base = lastStatusText.replace(/\.+_$/, "").replace(/_$/, "")
    const animated = lastStatusText.includes("_")
      ? `${base}${dots}_`
      : `${lastStatusText} ${dots}`
    await client.chat.update({ channel: channelId, ts: messageTs, text: `${agentPrefix}${animated}` }).catch(() => {})
  }, 8_000)

  let finalResponseSent = false
  const update = async (text: string) => {
    lastStatusText = text
    heartbeatStep = 0
    const parts = splitForSlack(`${agentPrefix}${text}`)
    // First chunk replaces the placeholder
    await client.chat.update({ channel: channelId, ts: messageTs, text: parts[0] })
    // Overflow chunks posted as thread replies — nothing is ever lost
    for (const part of parts.slice(1)) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: part }).catch(() => {})
    }
  }

  incrementActiveRequests()
  try {
    await run(update)
    finalResponseSent = true  // Prevent heartbeat from overwriting the final response
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
    clearInterval(heartbeat)
    decrementActiveRequests()
  }
}
