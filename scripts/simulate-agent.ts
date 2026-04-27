#!/usr/bin/env tsx
// Simulate a single agent turn against the live API + real GitHub state.
//
// Dry-run mode (default): reads from GitHub, calls LLM, but writes nothing to GitHub.
// Live mode: requires explicit --live flag. Writes to real GitHub branches.
//
// Usage (dry-run, safe by default):
//   npx tsx scripts/simulate-agent.ts --agent ux-design --feature onboarding --message "what is the next step"
//
// Usage (live write, explicit opt-in):
//   npx tsx scripts/simulate-agent.ts --agent ux-design --feature onboarding --message "fix brand tokens" --live

import "dotenv/config"
import { handleFeatureChannelMessage } from "../interfaces/slack/handlers/message"
import { setConfirmedAgent, clearHistory } from "../runtime/conversation-store"
import { featureKey } from "../runtime/routing/types"

async function main() {
const args = process.argv.slice(2)
const get = (flag: string) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null }

const agent   = get("--agent")
const feature = get("--feature")
const message = get("--message")
const reset   = args.includes("--reset")
const live    = args.includes("--live")
const dryRun  = !live

if (!agent || !feature || !message) {
  console.error("Usage: simulate-agent.ts --agent <type> --feature <name> --message <text> [--live] [--reset]")
  console.error("  --agent    required: agent type (e.g. ux-design, pm, architect)")
  console.error("  --feature  required: feature name (matches channel convention, e.g. onboarding)")
  console.error("  --message  required: user message to simulate")
  console.error("  --live     optional: write to real GitHub (default: dry-run, reads only)")
  console.error("  --reset    optional: clear conversation history before simulating")
  process.exit(1)
}

// Signal dry-run mode to GitHub client — all write operations will log and no-op
process.env.SIMULATE_DRY_RUN = dryRun ? "true" : "false"

if (reset) clearHistory(featureKey(feature))

setConfirmedAgent(featureKey(feature), agent as any)

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
console.log(`Mode:    ${dryRun ? "DRY RUN (no GitHub writes)" : "LIVE (writes to GitHub)"}`)
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
