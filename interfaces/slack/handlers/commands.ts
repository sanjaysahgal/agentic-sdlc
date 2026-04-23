import type { App } from "@slack/bolt"
import { handleFeatureChannelMessage, getChannelState } from "./message"
import { handleGeneralChannelAgentMessage } from "./general"
import { loadWorkspaceConfig } from "../../../runtime/workspace-config"

const MAX_MESSAGE_CHARS = 2000

const AGENT_MAP: Record<string, "pm" | "ux-design" | "architect"> = {
  "/pm": "pm",
  "/design": "ux-design",
  "/architect": "architect",
}

const AGENT_LABELS: Record<string, string> = {
  "/pm": "PM",
  "/design": "Design",
  "/architect": "Architect",
}

/**
 * Registers /pm, /design, /architect slash commands.
 *
 * Feature channels: reuses @agent: prefix routing in message.ts.
 * General channel: routes to product-level agent conversation.
 */
export function registerSlashCommands(app: App): void {
  for (const command of Object.keys(AGENT_MAP)) {
    app.command(command, async ({ command: cmd, ack, client }) => {
      await ack()

      const text = cmd.text?.trim() ?? ""
      if (!text) {
        await client.chat.postEphemeral({
          channel: cmd.channel_id,
          user: cmd.user_id,
          text: `Usage: \`${cmd.command} <your message>\``,
        })
        return
      }

      if (text.length > MAX_MESSAGE_CHARS) {
        await client.chat.postEphemeral({
          channel: cmd.channel_id,
          user: cmd.user_id,
          text: `:warning: That message is too long (${text.length.toLocaleString()} characters, limit ${MAX_MESSAGE_CHARS.toLocaleString()}). Please summarise in a shorter message.`,
        })
        return
      }

      // Look up channel name
      const channelInfo = await client.conversations.info({ channel: cmd.channel_id })
      const channelName = (channelInfo as any).channel?.name ?? ""

      // Post seed message so the channel sees what triggered the agent
      const label = AGENT_LABELS[cmd.command] ?? "Agent"
      const seed = await client.chat.postMessage({
        channel: cmd.channel_id,
        text: `_<@${cmd.user_id}> → ${label} Agent:_\n> ${text}`,
      })
      const threadTs = seed.ts as string

      const agent = AGENT_MAP[cmd.command]

      if (channelName.startsWith("feature-")) {
        // Feature channel: delegate to existing handler via @agent: prefix
        const channelState = getChannelState(channelName)
        const prefixName = cmd.command.slice(1) // "/pm" → "pm"
        await handleFeatureChannelMessage({
          channelName,
          threadTs,
          userMessage: `@${prefixName}: ${text}`,
          channelId: cmd.channel_id,
          client,
          channelState,
          userId: cmd.user_id,
        })
      } else if (channelName === loadWorkspaceConfig().mainChannel) {
        // General channel: route to agent in product-level mode
        await handleGeneralChannelAgentMessage({
          channelId: cmd.channel_id,
          threadTs,
          userMessage: text,
          client,
          agent,
        })
      } else {
        const { mainChannel } = loadWorkspaceConfig()
        await client.chat.postMessage({
          channel: cmd.channel_id,
          thread_ts: threadTs,
          text: `Slash commands work in feature channels (\`#feature-*\`) and the main channel (\`#${mainChannel}\`).`,
        })
      }
    })
  }
}
