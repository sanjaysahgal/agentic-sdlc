import "dotenv/config"
import { App } from "@slack/bolt"
import {
  handleFeatureChannelMessage,
  handleAgentConfirmation,
  getChannelState,
} from "./handlers/message"
import { AgentType } from "../../runtime/agent-router"

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
    text: `👋 Hi — I'm your agent for *${channelName.replace("feature-", "")}*. Tell me what you're thinking and we'll shape this into a spec together.`,
  })
})

// Handle messages in feature- channels
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
  if (!channelName.startsWith("feature-")) return

  const text = msg.text?.trim()
  if (!text) return

  const threadTs = msg.thread_ts ?? msg.ts
  const channelState = getChannelState(channelName)

  await handleFeatureChannelMessage({
    channelName,
    threadTs,
    userMessage: text,
    channelId: msg.channel,
    client,
    channelState,
  })
})

// Handle agent confirmation button clicks
const agentTypes: Array<AgentType | "other"> = ["pm", "architect", "backend", "frontend", "qa", "pgm", "spec-validator", "eng-mgr", "infra", "data", "other"]

agentTypes.forEach((agent) => {
  app.action(`confirm_agent_${agent}`, async ({ body, client, ack }) => {
    await ack()

    const channelId = body.channel?.id ?? ""
    const channelInfo = await client.conversations.info({ channel: channelId })
    const channelName = channelInfo.channel?.name ?? ""
    const channelState = getChannelState(channelName)

    await handleAgentConfirmation({
      channelName,
      channelId,
      selectedAgent: agent,
      client,
      channelState,
    })
  })
})

export default app
