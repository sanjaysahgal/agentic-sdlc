import "dotenv/config"
import app from "./app"
import { waitForDrain, getActiveRequestCount } from "../../runtime/request-tracker"

;(async () => {
  await app.start()
  console.log("⚡ agentic-sdlc Slack bot running in Socket Mode")
})()

// Graceful shutdown — wait for in-flight requests before exiting.
// tsx watch sends SIGTERM when files change; without this the agent response
// is abandoned mid-flight and the Slack placeholder stays stuck as "thinking...".
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received — beginning graceful shutdown`)
  if (getActiveRequestCount() > 0) {
    await waitForDrain()
  }
  await app.stop()
  process.exit(0)
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT",  () => shutdown("SIGINT"))
