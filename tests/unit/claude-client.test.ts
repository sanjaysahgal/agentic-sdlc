import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import Anthropic from "@anthropic-ai/sdk"
import { runAgent, splitSystemPrompt } from "../../runtime/claude-client"
import type { Message } from "../../runtime/conversation-store"

beforeEach(() => {
  mockCreate.mockReset()
})

describe("Anthropic client config", () => {
  it("sets maxRetries: 0 — a timed-out agent call won't succeed on retry, fail fast instead", () => {
    expect(Anthropic).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
  })
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

// ─── splitSystemPrompt ─────────────────────────────────────────────────────────

describe("splitSystemPrompt", () => {
  it("splits at marker — stable block gets cache_control, dynamic block does not", () => {
    const prompt = "You are an agent.\n\n## Current draft spec\nDraft content here."
    const blocks = splitSystemPrompt(prompt, "\n\n## Current draft spec")

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: "text",
      text: "You are an agent.",
      cache_control: { type: "ephemeral" },
    })
    expect(blocks[1]).toEqual({
      type: "text",
      text: "\n\n## Current draft spec\nDraft content here.",
    })
    expect(blocks[1]).not.toHaveProperty("cache_control")
  })

  it("falls back to single cached block when marker is not found", () => {
    const prompt = "You are an agent. No dynamic section here."
    const blocks = splitSystemPrompt(prompt, "\n\n## Current draft spec")

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({
      type: "text",
      text: prompt,
      cache_control: { type: "ephemeral" },
    })
  })

  it("stable block contains text before marker, dynamic block contains text from marker onward", () => {
    const stable = "Stable persona and tools section."
    const dynamic = "\n## Current approved spec chain\nApproved product spec goes here."
    const blocks = splitSystemPrompt(stable + dynamic, "\n## Current approved spec chain")

    expect(blocks[0].text).toBe(stable)
    expect(blocks[1].text).toBe(dynamic)
  })
})

// ─── runAgent tool-use loop ────────────────────────────────────────────────────

describe("runAgent — tool-use loop", () => {
  it("calls tool handler and loops when stop_reason is tool_use", async () => {
    const toolUseResponse = {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "call_1", name: "my_tool", input: { key: "value" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const finalResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Tool result processed" }],
      usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    mockCreate
      .mockResolvedValueOnce(toolUseResponse)
      .mockResolvedValueOnce(finalResponse)

    const toolHandler = vi.fn().mockResolvedValue({ result: { success: true } })

    const result = await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Call the tool",
      tools: [{ name: "my_tool", description: "A test tool", input_schema: { type: "object" as const, properties: {} } }],
      toolHandler,
    })

    expect(toolHandler).toHaveBeenCalledWith("my_tool", { key: "value" })
    expect(result).toBe("Tool result processed")
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it("records tool calls in toolCallsOut when provided", async () => {
    const toolUseResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "save_spec", input: { content: "spec content" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const finalResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done" }],
      usage: { input_tokens: 20, output_tokens: 10 },
    }
    mockCreate
      .mockResolvedValueOnce(toolUseResponse)
      .mockResolvedValueOnce(finalResponse)

    const toolHandler = vi.fn().mockResolvedValue({ result: {} })
    const toolCallsOut: Array<{ name: string; input: Record<string, unknown> }> = []

    await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Save the spec",
      tools: [{ name: "save_spec", description: "Saves spec", input_schema: { type: "object" as const, properties: {} } }],
      toolHandler,
      toolCallsOut,
    })

    expect(toolCallsOut).toHaveLength(1)
    expect(toolCallsOut[0].name).toBe("save_spec")
    expect(toolCallsOut[0].input).toEqual({ content: "spec content" })
  })

  it("returns error result when no toolHandler provided but agent calls a tool", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const toolUseResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "my_tool", input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const finalResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Completed" }],
      usage: { input_tokens: 20, output_tokens: 10 },
    }
    mockCreate
      .mockResolvedValueOnce(toolUseResponse)
      .mockResolvedValueOnce(finalResponse)

    // No toolHandler provided
    const result = await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Call the tool",
      tools: [{ name: "my_tool", description: "A test tool", input_schema: { type: "object" as const, properties: {} } }],
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No toolHandler provided"))
    expect(result).toBe("Completed")
    errorSpy.mockRestore()
  })

  it("handles tool handler throwing — returns error content and continues loop", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const toolUseResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "bad_tool", input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const finalResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Handled error" }],
      usage: { input_tokens: 20, output_tokens: 10 },
    }
    mockCreate
      .mockResolvedValueOnce(toolUseResponse)
      .mockResolvedValueOnce(finalResponse)

    const toolHandler = vi.fn().mockRejectedValue(new Error("Tool exploded"))

    const result = await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Run bad tool",
      tools: [{ name: "bad_tool", description: "Throws", input_schema: { type: "object" as const, properties: {} } }],
      toolHandler,
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bad_tool"))
    expect(result).toBe("Handled error")
    errorSpy.mockRestore()
  })

  it("returns empty string when tool_use response has no tool_use blocks (stop_reason mismatch)", async () => {
    const weirdResponse = {
      stop_reason: "tool_use",
      content: [{ type: "text", text: "Weird response" }], // no tool_use blocks
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    mockCreate.mockResolvedValueOnce(weirdResponse)

    const result = await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Test",
      tools: [{ name: "my_tool", description: "Tool", input_schema: { type: "object" as const, properties: {} } }],
    })

    expect(result).toBe("Weird response")
  })

  it("tool handler returning error object surfaces error message in tool result content", async () => {
    const toolUseResponse = {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "save_spec", input: { content: "bad spec" } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const finalResponse = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Error surfaced to agent" }],
      usage: { input_tokens: 20, output_tokens: 10 },
    }
    mockCreate
      .mockResolvedValueOnce(toolUseResponse)
      .mockResolvedValueOnce(finalResponse)

    const toolHandler = vi.fn().mockResolvedValue({ error: "Conflict detected — spec not saved" })

    await runAgent({
      systemPrompt: "System",
      history: [],
      userMessage: "Save spec",
      tools: [{ name: "save_spec", description: "Save spec", input_schema: { type: "object" as const, properties: {} } }],
      toolHandler,
    })

    // Verify the second API call — the messages array should contain a user message with tool_result content
    // Structure: [user(original), assistant(tool_use response), user(tool_results)]
    const secondCall = mockCreate.mock.calls[1][0]
    // The last user message is the tool results
    const userMessages = secondCall.messages.filter((m: { role: string }) => m.role === "user")
    const lastUserMsg = userMessages[userMessages.length - 1]
    const toolResults = Array.isArray(lastUserMsg?.content) ? lastUserMsg.content : []
    const errorResult = toolResults.find((r: { is_error?: boolean }) => r.is_error === true)
    expect(errorResult).toBeDefined()
  })
})
