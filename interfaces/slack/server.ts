import "dotenv/config"
import fs from "fs"
import path from "path"
import app from "./app"
import { waitForDrain, getActiveRequestCount } from "../../runtime/request-tracker"

const PID_FILE = path.join(process.cwd(), ".bot.pid")

// Prevent multiple instances — a second startup kills the file's recorded process.
// Eliminates duplicate Slack responses and file-write races on disk persistence.
function acquirePidLock(): void {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10)
    if (!isNaN(existingPid) && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0) // 0 = check if process exists without signalling
        console.log(`Existing bot process (PID ${existingPid}) found — killing it before starting.`)
        process.kill(existingPid, "SIGTERM")
      } catch {
        // Process is already gone — stale PID file
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid))
}

function releasePidLock(): void {
  try { fs.unlinkSync(PID_FILE) } catch { /* already gone */ }
}

acquirePidLock()

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
process.on("exit",    () => releasePidLock())
