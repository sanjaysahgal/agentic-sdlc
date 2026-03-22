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

// Anthropic vision only supports these formats.
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

// Downloads a Slack-hosted file using the bot token (required for private URLs).
async function fetchSlackImage(url: string, mimetype: string): Promise<UserImage | null> {
  if (!SUPPORTED_IMAGE_TYPES.has(mimetype)) return null
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    })
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    // Use the Slack-declared mimetype — it's already validated above
    return { data: Buffer.from(buffer).toString("base64"), mediaType: mimetype }
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

  // Download supported images for Claude vision. Unsupported formats (e.g. HEIC from iPhone)
  // are skipped — if no supported images remain and there's no text, tell the user.
  const userImages = (
    await Promise.all(rawFiles.map((f) => fetchSlackImage(f.url_private, f.mimetype)))
  ).filter(Boolean) as UserImage[]

  const hasUnsupportedFiles = rawFiles.some((f) => !SUPPORTED_IMAGE_TYPES.has(f.mimetype) && f.mimetype.startsWith("image/"))
  if (!text && userImages.length === 0 && hasUnsupportedFiles) {
    const threadTs = msg.thread_ts ?? msg.ts
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: "That image format isn't supported. Please send as JPEG, PNG, GIF, or WebP — screenshots from Mac work great. On iPhone, try taking a screenshot instead of sharing directly from the camera roll.",
    })
    return
  }

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
