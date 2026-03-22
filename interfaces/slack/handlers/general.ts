import { getInProgressFeatures, saveAgentFeedback } from "../../../runtime/github-client"
import { runAgent } from "../../../runtime/claude-client"
import { getHistory, appendMessage } from "../../../runtime/conversation-store"
import { buildConciergeSystemPrompt } from "../../../agents/concierge"
import { loadAgentContextForQuery } from "../../../runtime/context-loader"
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

  await withThinking({ client, channelId, threadTs, agent: "Concierge", run: async (update) => {
    const [features, context, history] = await Promise.all([
      getInProgressFeatures(),
      loadAgentContextForQuery(userMessage),
      Promise.resolve(getHistory(threadTs)),
    ])

    const systemPrompt = buildConciergeSystemPrompt(features, context)
    const response = await runAgent({ systemPrompt, history, userMessage })

    appendMessage(threadTs, { role: "user", content: userMessage })
    appendMessage(threadTs, { role: "assistant", content: response })

    // Extract and log any agent feedback the concierge detected
    const feedbackMatch = response.match(/\nAGENT_FEEDBACK: (.+)$/s)
    if (feedbackMatch) {
      const feedbackText = feedbackMatch[1].trim()
      await saveAgentFeedback({ feedback: feedbackText })
    }
    const cleanResponse = response.replace(/\nAGENT_FEEDBACK: .+$/s, "").trim()

    await update(cleanResponse)
  }})
}
