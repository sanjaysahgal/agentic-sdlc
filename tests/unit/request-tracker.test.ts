import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  incrementActiveRequests,
  decrementActiveRequests,
  getActiveRequestCount,
  waitForDrain,
} from "../../runtime/request-tracker"

// Reset the module between tests to restore the `activeRequests` counter.
// request-tracker.ts stores state in a module-level variable, so we need
// vi.resetModules() + dynamic import on every test.

describe("incrementActiveRequests / decrementActiveRequests / getActiveRequestCount", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("starts at 0", async () => {
    const { getActiveRequestCount } = await import("../../runtime/request-tracker")
    // Module is freshly imported — counter must start at 0
    expect(getActiveRequestCount()).toBe(0)
  })

  it("increments by 1 on each call", async () => {
    const { incrementActiveRequests, getActiveRequestCount } = await import("../../runtime/request-tracker")
    incrementActiveRequests()
    expect(getActiveRequestCount()).toBe(1)
    incrementActiveRequests()
    expect(getActiveRequestCount()).toBe(2)
  })

  it("decrements by 1 on each call", async () => {
    const { incrementActiveRequests, decrementActiveRequests, getActiveRequestCount } = await import("../../runtime/request-tracker")
    incrementActiveRequests()
    incrementActiveRequests()
    decrementActiveRequests()
    expect(getActiveRequestCount()).toBe(1)
  })

  it("never goes below 0 — decrementActiveRequests is floor-protected", async () => {
    const { decrementActiveRequests, getActiveRequestCount } = await import("../../runtime/request-tracker")
    // Counter is already 0 after fresh module import
    decrementActiveRequests()
    expect(getActiveRequestCount()).toBe(0)
    decrementActiveRequests()
    expect(getActiveRequestCount()).toBe(0)
  })
})

describe("waitForDrain", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves immediately when no active requests", async () => {
    const { waitForDrain } = await import("../../runtime/request-tracker")
    const drain = waitForDrain()
    // Should resolve without advancing time
    await expect(drain).resolves.toBeUndefined()
  })

  it("waits until active requests drain to zero", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { incrementActiveRequests, decrementActiveRequests, waitForDrain } = await import("../../runtime/request-tracker")

    incrementActiveRequests()
    const drain = waitForDrain()

    let resolved = false
    drain.then(() => { resolved = true })

    // Not resolved yet — active request still in flight
    await vi.advanceTimersByTimeAsync(200)
    expect(resolved).toBe(false)

    // Decrement to zero — drain should now resolve
    decrementActiveRequests()
    await vi.advanceTimersByTimeAsync(200)
    // Allow microtask queue to flush
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
    logSpy.mockRestore()
  })

  it("resolves after timeout even if requests are still active", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { incrementActiveRequests, waitForDrain } = await import("../../runtime/request-tracker")

    incrementActiveRequests() // never decremented

    const drain = waitForDrain()
    let resolved = false
    drain.then(() => { resolved = true })

    // Advance past the 6-minute drain timeout
    await vi.advanceTimersByTimeAsync(360_000 + 200)
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
    logSpy.mockRestore()
  })

  it("logs 'Waiting for N in-flight request(s)' on entry", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { incrementActiveRequests, decrementActiveRequests, waitForDrain } = await import("../../runtime/request-tracker")

    incrementActiveRequests()
    waitForDrain()

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("in-flight request"))
    decrementActiveRequests()
    logSpy.mockRestore()
  })

  it("logs clean shutdown message when all requests complete before timeout", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { incrementActiveRequests, decrementActiveRequests, waitForDrain } = await import("../../runtime/request-tracker")

    incrementActiveRequests()
    const drain = waitForDrain()

    decrementActiveRequests()
    await vi.advanceTimersByTimeAsync(200)
    await drain

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("shutting down cleanly"))
    logSpy.mockRestore()
  })

  it("logs timeout message when drain timeout expires with active requests", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { incrementActiveRequests, waitForDrain } = await import("../../runtime/request-tracker")

    incrementActiveRequests() // never decremented

    const drain = waitForDrain()
    await vi.advanceTimersByTimeAsync(360_000 + 200)
    await drain

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown timeout reached"))
    logSpy.mockRestore()
  })
})
