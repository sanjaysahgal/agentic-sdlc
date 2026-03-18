/**
 * Slack bot — delivery interface for SDLC agents.
 *
 * Listens for messages in feature channels (e.g. #feature-onboarding).
 * Routes them to the appropriate agent based on channel name and context.
 * Posts agent responses back into the thread.
 *
 * This file has no product logic — it is purely the Slack delivery layer.
 */

import { App } from "@slack/bolt"
import { PM_SYSTEM_PROMPT } from "../../agents/pm.js"
import { loadPMContext } from "../../runtime/context-loader.js"
import { chat, type Message } from "../../runtime/claude-client.js"
import { commitFile, createBranch, openPR } from "../../tools/github.js"

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

// In-memory conversation history per Slack thread.
// In production this would be persisted (Redis or DB).
const threadHistory = new Map<string, Message[]>()

const REPO_CONFIG = {
  owner: process.env.GITHUB_OWNER ?? "sanjaysahgal",
  repo: process.env.GITHUB_REPO ?? "agentic-health360",
}

// Listen to all messages in feature channels
app.message(async ({ message, say }) => {
  if (message.subtype) return // ignore system messages
  if (!("text" in message) || !message.text) return
  if (!("channel" in message) || !("ts" in message)) return

  const channelName = await getChannelName(message.channel as string)

  // Only respond in feature channels (feat-*)
  if (!channelName?.startsWith("feat-")) return

  const threadTs = ("thread_ts" in message ? message.thread_ts : message.ts) as string
  const historyKey = `${message.channel}:${threadTs}`

  const history = threadHistory.get(historyKey) ?? []
  const userMessage = message.text.trim()

  // Check if PM is asking to create the spec
  const isCreateRequest = /looks good|create the spec|create spec|ship it|go ahead/i.test(userMessage)

  try {
    // Load fresh context from the repo on every turn
    const context = await loadPMContext(REPO_CONFIG)

    const response = await chat(PM_SYSTEM_PROMPT, context, history, userMessage)

    // Update history
    history.push({ role: "user", content: userMessage })
    history.push({ role: "assistant", content: response })
    threadHistory.set(historyKey, history)

    await say({ text: response, thread_ts: threadTs })

    // If PM approved, create the spec and open the PR
    if (isCreateRequest) {
      const featureName = channelName.replace("feat-", "")
      await createSpecAndPR(featureName, response, threadTs, say)
    }
  } catch (error) {
    console.error("Agent error:", error)
    await say({
      text: "Something went wrong on my end. Please try again.",
      thread_ts: threadTs,
    })
  }
})

async function createSpecAndPR(
  featureName: string,
  specContent: string,
  threadTs: string,
  say: Function
): Promise<void> {
  const branch = `spec/${featureName}-product`
  const filePath = `specs/features/${featureName}/${featureName}.product.md`

  try {
    await createBranch(REPO_CONFIG.owner, REPO_CONFIG.repo, branch)
    await commitFile(
      REPO_CONFIG.owner,
      REPO_CONFIG.repo,
      filePath,
      specContent,
      `[SPEC] ${featureName} · product — draft by pm agent`,
      branch
    )

    const prUrl = await openPR(
      REPO_CONFIG.owner,
      REPO_CONFIG.repo,
      `[SPEC] ${featureName} · product`,
      `Product spec for \`${featureName}\` drafted by pm agent.\n\nReview the spec file and approve this PR to trigger the architect agent.`,
      branch
    )

    await say({
      text: `Spec committed and PR opened: ${prUrl}\n\nReview it on GitHub and approve when ready. I'll be here if you want to iterate before approving.`,
      thread_ts: threadTs,
    })
  } catch (error) {
    console.error("Failed to create spec:", error)
    await say({
      text: "I shaped the spec but hit an error committing it to GitHub. Please check my permissions.",
      thread_ts: threadTs,
    })
  }
}

async function getChannelName(channelId: string): Promise<string | undefined> {
  try {
    const { WebClient } = await import("@slack/web-api")
    const client = new WebClient(process.env.SLACK_BOT_TOKEN)
    const info = await client.conversations.info({ channel: channelId })
    return (info.channel as { name?: string })?.name
  } catch {
    return undefined
  }
}

export { app }
