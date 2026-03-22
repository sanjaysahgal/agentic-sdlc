// Tracks in-flight agent requests so the process can shut down gracefully.
// withThinking increments on entry and decrements on exit.
// The SIGTERM handler waits for the count to reach zero before exiting.

let activeRequests = 0
const DRAIN_POLL_MS = 200
const DRAIN_TIMEOUT_MS = 120_000 // 2 minutes max wait

export function incrementActiveRequests(): void {
  activeRequests++
}

export function decrementActiveRequests(): void {
  activeRequests = Math.max(0, activeRequests - 1)
}

export function getActiveRequestCount(): number {
  return activeRequests
}

// Resolves when all in-flight requests complete, or after the timeout.
export function waitForDrain(): Promise<void> {
  if (activeRequests === 0) return Promise.resolve()

  console.log(`Waiting for ${activeRequests} in-flight request(s) to complete before shutting down...`)

  return new Promise((resolve) => {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS

    const poll = setInterval(() => {
      if (activeRequests === 0 || Date.now() >= deadline) {
        clearInterval(poll)
        if (activeRequests > 0) {
          console.log(`Shutdown timeout reached with ${activeRequests} request(s) still active — exiting anyway`)
        } else {
          console.log("All requests completed — shutting down cleanly")
        }
        resolve()
      }
    }, DRAIN_POLL_MS)
  })
}
