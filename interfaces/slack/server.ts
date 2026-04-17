import "dotenv/config"
import fs from "fs"
import path from "path"
import app from "./app"
import { waitForDrain, getActiveRequestCount } from "../../runtime/request-tracker"
import logger from "../../runtime/logger"

const PID_FILE = path.join(process.cwd(), ".bot.pid")

// Route all console output through winston so every log line is timestamped,
// level-tagged, written to stdout, and persisted to rotating daily log files
// under logs/ with 14-day retention and 20MB per-file cap.
console.log = (...args) => logger.info(args.join(" "))
console.error = (...args) => logger.error(args.join(" "))
console.warn = (...args) => logger.warn(args.join(" "))

// Prevent multiple instances — a second startup kills the file's recorded process
// and waits for it to exit before connecting to Slack.
// Critical: both sending SIGTERM and immediately calling app.start() causes a window
// where two instances are simultaneously connected to the Slack socket, producing
// duplicate message processing and conversation state race conditions.
async function acquirePidLock(): Promise<void> {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10)
    if (!isNaN(existingPid) && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0) // 0 = check if process exists without signalling
        console.log(`Existing bot process (PID ${existingPid}) found — sending SIGTERM and waiting for exit.`)
        process.kill(existingPid, "SIGTERM")
        // Poll until the old process is gone (max 30s). If it doesn't die, SIGKILL.
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 200))
          try { process.kill(existingPid, 0) } catch { break } // gone
        }
        try {
          process.kill(existingPid, 0)
          // Still alive after 30s — force kill
          console.log(`PID ${existingPid} did not exit after 30s — sending SIGKILL.`)
          process.kill(existingPid, "SIGKILL")
          await new Promise(r => setTimeout(r, 500))
        } catch { /* already gone */ }
        console.log(`PID ${existingPid} exited — starting.`)
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

;(async () => {
  await acquirePidLock()
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
