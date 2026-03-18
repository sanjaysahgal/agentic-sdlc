import { app } from "./app.js"

const port = parseInt(process.env.PORT ?? "3001")

;(async () => {
  await app.start(port)
  console.log(`⚡ agentic-sdlc Slack bot running on port ${port}`)
})()
