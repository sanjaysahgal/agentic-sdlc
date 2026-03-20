import { getInProgressFeatures } from "../../../runtime/github-client"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage } from "../../../runtime/conversation-store"
import { buildConciergeSystemPrompt } from "../../../agents/concierge"
import { withThinking } from "./thinking"

// Handles messages in non-feature channels (e.g. #all-health360).
// Acts as the front door — explains the system, identifies the person's role,
// and tells them exactly what they can act on right now.

export async function handleGeneralChannelMessage(params: {
  channelId: string
  threadTs: string
  userMessage: string
  client: any
}): Promise<void> {
  const { channelId, threadTs, userMessage, client } = params

  await withThinking({ client, channelId, threadTs, run: async (update) => {
    const [features, history] = await Promise.all([
      getInProgressFeatures(),
      Promise.resolve(getHistory(threadTs)),
    ])

    const systemPrompt = buildConciergeSystemPrompt(features)
    const response = await runAgent({ systemPrompt, history, userMessage })

    appendMessage(threadTs, { role: "user", content: userMessage })
    appendMessage(threadTs, { role: "assistant", content: response })

    await update(response)
  }})
}
