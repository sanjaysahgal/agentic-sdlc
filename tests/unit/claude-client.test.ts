import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { runAgent } from "../../runtime/claude-client"
import type { Message } from "../../runtime/conversation-store"

beforeEach(() => {
  mockCreate.mockReset()
})

describe("runAgent", () => {
  it("returns text from first content block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "Here is the spec." }] })

    const result = await runAgent({
      systemPrompt: "You are a PM.",
      history: [],
      userMessage: "Let's build a login feature.",
    })

    expect(result).toBe("Here is the spec.")
  })

  it("returns empty string when first content block is not text", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] })

    const result = await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Hello",
    })

    expect(result).toBe("")
  })

  it("passes systemPrompt as cached system block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    await runAgent({ systemPrompt: "You are a PM.", history: [], userMessage: "Hi" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toEqual([
      expect.objectContaining({ type: "text", text: "You are a PM.", cache_control: { type: "ephemeral" } }),
    ])
  })

  it("appends userMessage as final user turn after history", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    const history: Message[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]
    await runAgent({ systemPrompt: "System", history, userMessage: "second question" })

    const call = mockCreate.mock.calls[0][0]
    const messages = call.messages
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "second question" })
    expect(messages[messages.length - 2]).toEqual({ role: "assistant", content: "first answer" })
  })

  it("strips leading assistant messages from history to satisfy Anthropic API constraint", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    // History starts with an assistant message — Anthropic requires user first
    const history: Message[] = [
      { role: "assistant", content: "stale assistant message" },
      { role: "user", content: "user reply" },
    ]
    await runAgent({ systemPrompt: "System", history, userMessage: "new message" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].role).toBe("user")
  })

  it("collapses consecutive same-role messages — keeps the later one", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    const history: Message[] = [
      { role: "user", content: "first user" },
      { role: "user", content: "second user (overrides first)" },
      { role: "assistant", content: "assistant reply" },
    ]
    await runAgent({ systemPrompt: "System", history, userMessage: "new user" })

    const call = mockCreate.mock.calls[0][0]
    // The two consecutive user messages should collapse to just the second one
    const roles = call.messages.map((m: { role: string }) => m.role)
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i]).not.toBe(roles[i - 1])
    }
  })

  it("includes image blocks before text when userImages are provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "I see the image." }] })

    await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "What do you see?",
      userImages: [{ data: "base64data", mediaType: "image/png" }],
    })

    const call = mockCreate.mock.calls[0][0]
    const lastMessage = call.messages[call.messages.length - 1]
    expect(Array.isArray(lastMessage.content)).toBe(true)
    const blocks = lastMessage.content as Array<{ type: string }>
    expect(blocks[0].type).toBe("image")
    expect(blocks[blocks.length - 1].type).toBe("text")
  })

  it("truncates history to last 40 messages before the new user turn", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    // Build 60 alternating messages
    const history: Message[] = []
    for (let i = 0; i < 60; i++) {
      history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    await runAgent({ systemPrompt: "System", history, userMessage: "final" })

    const call = mockCreate.mock.calls[0][0]
    // After slicing to last 40 + adding 1 new user message, max is 41
    expect(call.messages.length).toBeLessThanOrEqual(41)
  })

  it("respects historyLimit parameter — design agent passes 20 to cap payload for large-context agents", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    // Build 60 alternating messages
    const history: Message[] = []
    for (let i = 0; i < 60; i++) {
      history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    await runAgent({ systemPrompt: "System", history, userMessage: "final", historyLimit: 20 })

    const call = mockCreate.mock.calls[0][0]
    // After slicing to last 20 + adding 1 new user message, max is 21
    expect(call.messages.length).toBeLessThanOrEqual(21)
  })

  it("historyLimit: 20 sends last 20 messages — earlier messages are dropped", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })

    const history: Message[] = []
    for (let i = 0; i < 40; i++) {
      history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` })
    }

    await runAgent({ systemPrompt: "System", history, userMessage: "latest", historyLimit: 20 })

    const call = mockCreate.mock.calls[0][0]
    const contents = call.messages.map((m: { content: string }) => m.content)
    // msg 0 through msg 19 should be dropped; only msgs 20–39 + "latest" should be present
    expect(contents).not.toContain("msg 0")
    expect(contents).not.toContain("msg 19")
    expect(contents).toContain("msg 20")
    expect(contents).toContain("latest")
  })
})
