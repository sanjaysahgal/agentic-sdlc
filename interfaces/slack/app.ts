import "dotenv/config"
import { App } from "@slack/bolt"
import { handleFeatureChannelMessage, getChannelState } from "./handlers/message"
import { handleGeneralChannelMessage } from "./handlers/general"

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

// Welcome message when a feature- channel is created
app.event("channel_created", async ({ event, client }) => {
  const channelName = event.channel.name
  if (!channelName.startsWith("feature-")) return

  await client.chat.postMessage({
    channel: event.channel.id,
    text: `Hi — I'm the product specialist for *${channelName.replace("feature-", "")}*. Tell me what you're thinking and we'll shape this into a spec together.`,
  })
})

// Route all messages — feature channels to their agent, everything else to concierge
app.message(async ({ message, client }) => {
  const msg = message as {
    channel: string
    text?: string
    thread_ts?: string
    ts: string
    bot_id?: string
  }

  if (msg.bot_id) return

  const channelInfo = await client.conversations.info({ channel: msg.channel })
  const channelName = channelInfo.channel?.name ?? ""
  const text = msg.text?.trim()
  if (!text) return

  const threadTs = msg.thread_ts ?? msg.ts

  if (channelName.startsWith("feature-")) {
    const channelState = getChannelState(channelName)
    await handleFeatureChannelMessage({
      channelName,
      threadTs,
      userMessage: text,
      channelId: msg.channel,
      client,
      channelState,
    })
  } else {
    await handleGeneralChannelMessage({
      channelId: msg.channel,
      threadTs,
      userMessage: text,
      client,
    })
  }
})

export default app
