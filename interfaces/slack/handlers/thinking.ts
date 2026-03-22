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

  // update() replaces the placeholder with the real content
  const update = async (text: string) => {
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
    })
  }

  incrementActiveRequests()
  try {
    await run(update)
  } catch (err: unknown) {
    const isOverloaded = err instanceof Error && err.message.includes("overloaded")
    const msg = isOverloaded
      ? "The AI is overloaded right now. Please try again in a moment."
      : "Something went wrong. Please try again."
    console.error("[withThinking] agent error:", err)
    await update(msg).catch(() => {})
    throw err
  } finally {
    decrementActiveRequests()
  }
}
