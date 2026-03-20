import "dotenv/config"
import app from "./app"

;(async () => {
  await app.start()
  console.log("⚡ agentic-sdlc Slack bot running in Socket Mode")
})()
