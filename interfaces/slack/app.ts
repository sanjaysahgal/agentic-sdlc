import "dotenv/config"
import { App } from "@slack/bolt"
import { handleFeatureChannelMessage, getChannelState } from "./handlers/message"
import { handleGeneralChannelMessage } from "./handlers/general"
import { UserImage } from "../../runtime/claude-client"

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
    text: `Hi — I'm the AI Product Manager for *${channelName.replace("feature-", "")}*. Tell me what you're thinking and we'll shape this into a spec together.`,
  })
})

// Downloads a Slack-hosted file using the bot token (required for private URLs).
async function fetchSlackImage(url: string): Promise<UserImage | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    })
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    const mediaType = (res.headers.get("content-type") ?? "image/png").split(";")[0]
    return { data: Buffer.from(buffer).toString("base64"), mediaType }
  } catch {
    return null
  }
}

// Route all messages — feature channels to their agent, everything else to concierge
app.message(async ({ message, client }) => {
  const msg = message as {
    channel: string
    text?: string
    thread_ts?: string
    ts: string
    bot_id?: string
    files?: Array<{ url_private: string; mimetype: string }>
  }

  if (msg.bot_id) return

  const channelInfo = await client.conversations.info({ channel: msg.channel })
  const channelName = channelInfo.channel?.name ?? ""
  const text = msg.text?.trim() ?? ""
  const rawFiles = msg.files ?? []
  if (!text && rawFiles.length === 0) return

  // Download any attached images so they can be passed to Claude as vision content
  const imageFiles = rawFiles.filter((f) => f.mimetype.startsWith("image/"))
  const userImages = (
    await Promise.all(imageFiles.map((f) => fetchSlackImage(f.url_private)))
  ).filter(Boolean) as UserImage[]

  const threadTs = msg.thread_ts ?? msg.ts

  if (channelName.startsWith("feature-")) {
    const channelState = getChannelState(channelName)
    await handleFeatureChannelMessage({
      channelName,
      threadTs,
      userMessage: text,
      userImages,
      channelId: msg.channel,
      client,
      channelState,
    })
  } else {
    await handleGeneralChannelMessage({
      channelId: msg.channel,
      threadTs,
      userMessage: text,
      userImages,
      client,
    })
  }
})

export default app
