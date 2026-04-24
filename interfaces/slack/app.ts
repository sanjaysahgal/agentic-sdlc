import "dotenv/config"
import { App } from "@slack/bolt"
import { handleFeatureChannelMessage, getChannelState } from "./handlers/message"
import { handleGeneralChannelMessage, handleGeneralChannelAgentMessage } from "./handlers/general"
import { getThreadAgent } from "../../runtime/conversation-store"
import { registerReactionHandlers } from "./handlers/reactions"
import { registerSlashCommands } from "./handlers/commands"
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

// Dedup store for Slack at-least-once delivery. Slack can deliver the same event_id
// multiple times (retries on timeout, network hiccups). Without this, the same message
// triggers two parallel agent runs — duplicate saves, duplicate Slack replies.
const seenEvents = new Map<string, number>()
const EVENT_TTL_MS = 5 * 60 * 1000

// Route all messages — feature channels to their agent, everything else to concierge
app.message(async ({ message, client, body }) => {
  // Deduplicate by event_id. Purge entries older than TTL on each check.
  const eventId: string | null = (body as any).event_id ?? null
  if (eventId) {
    const now = Date.now()
    for (const [id, ts] of seenEvents) {
      if (now - ts > EVENT_TTL_MS) seenEvents.delete(id)
    }
    if (seenEvents.has(eventId)) return
    seenEvents.set(eventId, now)
  }
  const msg = message as {
    channel: string
    text?: string
    thread_ts?: string
    ts: string
    bot_id?: string
    files?: Array<{ url_private: string; mimetype: string; name?: string }>
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

  const hasUnsupportedImages = rawFiles.some((f) => !SUPPORTED_IMAGE_TYPES.has(f.mimetype) && f.mimetype.startsWith("image/"))
  if (!text && userImages.length === 0 && hasUnsupportedImages) {
    const threadTs = msg.thread_ts ?? msg.ts
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: "That image format isn't supported. Please send as JPEG, PNG, GIF, or WebP — screenshots from Mac work great.",
    })
    return
  }

  // Reject non-image file uploads (HTML, PDF, code files, etc.).
  // These can't be processed as vision and their content should not enter the conversation.
  // If you're sharing a design file, share a screenshot instead.
  const hasNonImageFiles = rawFiles.some((f) => !f.mimetype.startsWith("image/"))
  if (hasNonImageFiles) {
    const threadTs = msg.thread_ts ?? msg.ts
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: ":warning: Only images can be shared here (JPEG, PNG, GIF, WebP). For HTML previews — they're already saved to GitHub automatically after every draft save. For anything else, paste the relevant text as a message instead.",
    })
    return
  }

  const threadTs = msg.thread_ts ?? msg.ts

  // Reject messages that would poison the conversation history.
  // A message this long combined with history + system prompt hits token limits and causes
  // silent failures on every subsequent turn in the thread.
  const MAX_MESSAGE_CHARS = 2000
  if ((text ?? "").length > MAX_MESSAGE_CHARS) {
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: `:warning: That message is too long (${text.length.toLocaleString()} characters, limit ${MAX_MESSAGE_CHARS.toLocaleString()}). Please summarise the key decisions in a shorter message — a few sentences is enough for the agent to work from.`,
    })
    return
  }

  // Images are passed to Claude for the current turn but are NOT stored in conversation history
  // (only text is persisted). Prepend a note so history and extractLockedDecisions can see that
  // a visual reference was shared — otherwise the agent loses the context after one turn.
  const imageNote = userImages.length > 0
    ? `[User shared ${userImages.length} image${userImages.length > 1 ? "s" : ""}: ${
        rawFiles
          .filter((f) => SUPPORTED_IMAGE_TYPES.has(f.mimetype))
          .map((f) => f.name ?? "image")
          .join(", ")
      }]`
    : ""
  const userMessage = imageNote && text ? `${imageNote}\n\n${text}` : imageNote || text

  if (channelName.startsWith("feature-")) {
    const channelState = getChannelState(channelName)
    const userId = (body as any).event?.user ?? ""
    await handleFeatureChannelMessage({
      channelName,
      threadTs,
      userMessage,
      userImages,
      channelId: msg.channel,
      client,
      channelState,
      userId,
    })
  } else {
    // General channel: check if this thread already has an agent (from a slash command).
    // If so, route to that agent. Otherwise, route to concierge.
    // A thread belongs to the agent that started it — no switching mid-thread.
    // To talk to a different agent, start a new thread with a new slash command.
    const threadAgent = getThreadAgent(threadTs)

    if (threadAgent) {
      console.log(`[ROUTER] general-channel thread: routing to ${threadAgent} (thread continuity)`)
      await handleGeneralChannelAgentMessage({
        channelId: msg.channel,
        threadTs,
        userMessage,
        userImages,
        client,
        agent: threadAgent,
      })
    } else {
      await handleGeneralChannelMessage({
        channelId: msg.channel,
        threadTs,
        userMessage,
        userImages,
        client,
      })
    }
  }
})

registerReactionHandlers(app)
registerSlashCommands(app)

export default app
