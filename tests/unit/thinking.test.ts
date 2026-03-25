import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { mockIncrementActiveRequests, mockDecrementActiveRequests } = vi.hoisted(() => ({
  mockIncrementActiveRequests: vi.fn(),
  mockDecrementActiveRequests: vi.fn(),
}))

vi.mock("../../runtime/request-tracker", () => ({
  incrementActiveRequests: mockIncrementActiveRequests,
  decrementActiveRequests: mockDecrementActiveRequests,
}))

import { withThinking } from "../../interfaces/slack/handlers/thinking"

function makeClient(postTs = "1234.5678") {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: postTs }),
      update: vi.fn().mockResolvedValue({}),
    },
  }
}

describe("withThinking", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("posts placeholder immediately then updates with response", async () => {
    const client = makeClient()
    await withThinking({
      client, channelId: "C123", threadTs: "1000.0", agent: "PM",
      run: async (update) => { await update("Response text") },
    })
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "_PM is thinking..._" }))
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: "*PM*\n\nResponse text" }))
  })

  it("on error: logs structured JSON with all required fields", async () => {
    const client = makeClient()
    const err = new Error("API connection timeout")

    await expect(withThinking({
      client, channelId: "C456", threadTs: "2000.0", agent: "UX Designer",
      run: async () => { throw err },
    })).rejects.toThrow()

    expect(console.error).toHaveBeenCalledTimes(1)
    const logged = JSON.parse((console.error as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(logged.level).toBe("error")
    expect(logged.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(logged.agent).toBe("UX Designer")
    expect(logged.channel).toBe("C456")
    expect(logged.thread).toBe("2000.0")
    expect(logged.errorType).toBe("Error")
    expect(logged.errorMessage).toBe("API connection timeout")
    expect(logged.stack).toContain("Error")
  })

  it("on error: updates placeholder with user-facing error message", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("something broke") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong. Please try again.") })
    )
  })

  it("on context-limit error: shows actionable thread-restart message not generic", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("prompt is too long: 150000 tokens > 100000 maximum") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("too long") })
    )
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("fresh top-level message") })
    )
  })

  it("on context-limit error 'Input too long': shows thread-restart message not generic", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("Input too long: request exceeds context window") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("fresh top-level message") })
    )
    expect(client.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") })
    )
  })

  it("on context-limit error 'exceeded' + 'token': shows thread-restart message not generic", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("Request exceeded the maximum token count") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("fresh top-level message") })
    )
    expect(client.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") })
    )
  })

  it("on context-limit error 'reduce the length': shows thread-restart message not generic", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("Please reduce the length of the messages or completion") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("fresh top-level message") })
    )
    expect(client.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") })
    )
  })

  it("on overloaded error: shows overloaded message not generic", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("The API is overloaded") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("overloaded") })
    )
  })

  it("on image error: shows image-specific message", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("Could not process image") },
    })).rejects.toThrow()

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("PNG screenshot") })
    )
  })

  it("truncates responses over 39000 chars at paragraph boundary", async () => {
    const client = makeClient()
    const longText = "A".repeat(38_000) + "\n\n" + "B".repeat(2000)

    await withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async (update) => { await update(longText) },
    })

    const updated = (client.chat.update as ReturnType<typeof vi.fn>).mock.calls[0][0].text
    expect(updated.length).toBeLessThan(40_000)
    expect(updated).toContain("[Response truncated")
  })

  it("always calls decrementActiveRequests in finally — even on error", async () => {
    const client = makeClient()
    await expect(withThinking({
      client, channelId: "C123", threadTs: "1000.0",
      run: async () => { throw new Error("fail") },
    })).rejects.toThrow()

    expect(mockDecrementActiveRequests).toHaveBeenCalledTimes(1)
  })
})
