// Posts a "Thinking..." placeholder immediately, then updates it with the real response.
// This gives instant visual feedback while the agent processes.

export async function withThinking(params: {
  client: any
  channelId: string
  threadTs: string
  run: (update: (text: string) => Promise<void>) => Promise<void>
}): Promise<void> {
  const { client, channelId, threadTs, run } = params

  // Post placeholder immediately so the user knows we received their message
  const placeholder = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "_Thinking..._",
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

  await run(update)
}
