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

// Anthropic's per-image size limit.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5MB

// Downloads a Slack-hosted file using the bot token (required for private URLs).
// Returns null (and logs) if the format is unsupported or the file exceeds Anthropic's limit.
async function fetchSlackImage(url: string, mimetype: string): Promise<UserImage | null> {
  if (!SUPPORTED_IMAGE_TYPES.has(mimetype)) return null
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    })
    if (!res.ok) {
      console.warn(`[fetchSlackImage] download failed: ${res.status} ${url}`)
      return null
    }
    const responseMimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim()
    const buffer = await res.arrayBuffer()
    // If Slack returns HTML, the bot token is missing the files:read scope
    if (responseMimeType === "text/html") {
      console.error(`[fetchSlackImage] got HTML — bot token missing files:read scope`)
      throw new Error("MISSING_FILES_READ_SCOPE")
    }
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      console.warn(`[fetchSlackImage] image too large (${buffer.byteLength} bytes, limit 5MB)`)
      return null
    }
    // Use the Slack-declared mimetype — it's already validated above
    return { data: Buffer.from(buffer).toString("base64"), mediaType: mimetype }
  } catch (err) {
    console.warn(`[fetchSlackImage] error fetching image:`, err)
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

  // Download supported images for Claude vision. Detect scope errors early.
  let userImages: UserImage[] = []
  try {
    userImages = (
      await Promise.all(rawFiles.map((f) => fetchSlackImage(f.url_private, f.mimetype)))
    ).filter(Boolean) as UserImage[]
  } catch (err) {
    if (err instanceof Error && err.message === "MISSING_FILES_READ_SCOPE") {
      const threadTs = msg.thread_ts ?? msg.ts
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        text: ":warning: *Image sharing requires a Slack permission update.*\n\nThe bot needs the `files:read` scope to download images. To fix this:\n1. Go to *api.slack.com/apps* → your app → *OAuth & Permissions*\n2. Add `files:read` under *Bot Token Scopes*\n3. Click *Reinstall to Workspace*\n\nOnce done, image sharing will work.",
      })
      return
    }
    throw err
  }

  const hasUnsupportedFiles = rawFiles.some((f) => !SUPPORTED_IMAGE_TYPES.has(f.mimetype) && f.mimetype.startsWith("image/"))
  if (!text && userImages.length === 0 && hasUnsupportedFiles) {
    const threadTs = msg.thread_ts ?? msg.ts
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: "That image format isn't supported. Please send as JPEG, PNG, GIF, or WebP — screenshots from Mac work great.",
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
