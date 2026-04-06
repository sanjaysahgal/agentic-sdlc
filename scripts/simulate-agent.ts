#!/usr/bin/env tsx
// Simulate a single agent turn against the live API + real GitHub state.
//
// Usage:
//   npx tsx scripts/simulate-agent.ts --agent ux-design --feature onboarding --message "what is the next step for this feature"
//   npx tsx scripts/simulate-agent.ts --agent pm --feature onboarding --message "let's keep going"

import "dotenv/config"
import { handleFeatureChannelMessage } from "../interfaces/slack/handlers/message"
import { setConfirmedAgent, clearHistory } from "../runtime/conversation-store"

async function main() {
const args = process.argv.slice(2)
const get = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const agent   = get("--agent")   ?? "ux-design"
const feature = get("--feature") ?? "onboarding"
const message = get("--message") ?? "what is the next step for this feature"
const reset   = args.includes("--reset")

if (reset) clearHistory(feature)

setConfirmedAgent(feature, agent as any)

const updates: string[] = []

const client = {
  chat: {
    postMessage: async (p: any) => { console.log(`\n[post] ${p.text ?? "(no text)"}`); return { ts: "sim-ts" } },
    update:      async (p: any) => {
      const text = p.text ?? "(no text)"
      updates.push(text)
      process.stdout.write(`\r[update ${updates.length}] ${text.slice(0, 80).replace(/\n/g, " ")}...`)
      return {}
    },
  },
  files: { uploadV2: async () => { console.log("\n[file upload skipped in simulation]"); return {} } },
}

console.log(`\n${"─".repeat(60)}`)
console.log(`Agent:   ${agent}`)
console.log(`Feature: ${feature}`)
console.log(`Message: "${message}"`)
console.log(`${"─".repeat(60)}\n`)

try {
  await handleFeatureChannelMessage({
    channelName:  `feature-${feature}`,
    threadTs:     "sim-thread",
    channelId:    "SIM",
    client:       client as any,
    channelState: { productSpecApproved: false, engineeringSpecApproved: false, pendingAgent: null, pendingMessage: null, pendingThreadTs: null },
    userMessage:  message,
  })

  const final = updates.at(-1) ?? "(no response)"
  console.log(`\n\n${"─".repeat(60)}`)
  console.log("FINAL RESPONSE:")
  console.log(`${"─".repeat(60)}`)
  console.log(final)
  console.log(`${"─".repeat(60)}\n`)
} catch (err: any) {
  console.error("\n[error]", err.message)
  process.exit(1)
}
}

main()
