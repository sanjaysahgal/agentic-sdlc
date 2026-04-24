import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock all external dependencies
const mockRunAgent = vi.fn().mockResolvedValue("Here is my expert recommendation on the product vision.")
const mockGetHistory = vi.fn().mockReturnValue([])
const mockAppendMessage = vi.fn()
const mockLoadAgentContextForQuery = vi.fn().mockResolvedValue({
  productVision: "Build a health app for wellness tracking.",
  systemArchitecture: "React Native + Node.js microservices.",
})
const mockLoadWorkspaceConfig = vi.fn().mockReturnValue({
  productName: "Health360",
  mainChannel: "all-health360",
})

vi.mock("../../runtime/claude-client", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
  UserImage: {},
}))
vi.mock("../../runtime/conversation-store", () => ({
  getHistory: (...args: any[]) => mockGetHistory(...args),
  appendMessage: (...args: any[]) => mockAppendMessage(...args),
}))
vi.mock("../../runtime/context-loader", () => ({
  loadAgentContextForQuery: (...args: any[]) => mockLoadAgentContextForQuery(...args),
}))
vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: () => mockLoadWorkspaceConfig(),
}))
vi.mock("../../runtime/github-client", () => ({
  getInProgressFeatures: vi.fn().mockResolvedValue([]),
  saveAgentFeedback: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../agents/concierge", () => ({
  buildConciergeSystemPrompt: vi.fn().mockReturnValue("concierge prompt"),
}))

// Mock withThinking to just call the run function directly
vi.mock("../../interfaces/slack/handlers/thinking", () => ({
  withThinking: vi.fn(async ({ run }: { run: (update: (text: string) => Promise<void>) => Promise<void> }) => {
    const update = vi.fn().mockResolvedValue(undefined)
    await run(update)
  }),
}))

import { handleGeneralChannelAgentMessage } from "../../interfaces/slack/handlers/general"

describe("handleGeneralChannelAgentMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseParams = {
    channelId: "C123",
    threadTs: "thread-123",
    userMessage: "What is the product vision?",
    client: { chat: { postMessage: vi.fn(), update: vi.fn() } },
  }

  it("loads context via loadAgentContextForQuery", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    expect(mockLoadAgentContextForQuery).toHaveBeenCalledWith("What is the product vision?")
  })

  it("keys history by general:threadTs to avoid feature key collision", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    expect(mockGetHistory).toHaveBeenCalledWith("general:thread-123")
    expect(mockAppendMessage).toHaveBeenCalledWith("general:thread-123", expect.objectContaining({ role: "user" }))
    expect(mockAppendMessage).toHaveBeenCalledWith("general:thread-123", expect.objectContaining({ role: "assistant" }))
  })

  it("calls runAgent with product-level system prompt for PM", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    const call = mockRunAgent.mock.calls[0][0]
    expect(call.systemPrompt).toContain("Product Manager")
    expect(call.systemPrompt).toContain("Health360")
    expect(call.systemPrompt).toContain("product vision")
    expect(call.userMessage).toBe("What is the product vision?")
  })

  it("calls runAgent with product-level system prompt for Design", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "ux-design" })
    const call = mockRunAgent.mock.calls[0][0]
    expect(call.systemPrompt).toContain("UX Designer")
    expect(call.systemPrompt).toContain("brand identity")
  })

  it("calls runAgent with product-level system prompt for Architect", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "architect" })
    const call = mockRunAgent.mock.calls[0][0]
    expect(call.systemPrompt).toContain("Architect")
    expect(call.systemPrompt).toContain("system architecture")
  })

  it("PM prompt includes domain boundary — redirects design/arch questions", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    const prompt = mockRunAgent.mock.calls[0][0].systemPrompt
    expect(prompt).toContain("redirect")
    expect(prompt).not.toContain("brand identity")
  })

  it("Design prompt includes domain boundary — redirects PM/arch questions", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "ux-design" })
    const prompt = mockRunAgent.mock.calls[0][0].systemPrompt
    expect(prompt).toContain("redirect")
    expect(prompt).toContain("brand identity")
    expect(prompt).not.toContain("You own the product vision")
  })

  it("injects product vision and system architecture into prompt context", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    const prompt = mockRunAgent.mock.calls[0][0].systemPrompt
    expect(prompt).toContain("Build a health app for wellness tracking.")
    expect(prompt).toContain("React Native + Node.js microservices.")
  })

  it("handles missing product vision gracefully", async () => {
    mockLoadAgentContextForQuery.mockResolvedValueOnce({
      productVision: "",
      systemArchitecture: "Some arch",
    })
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    const prompt = mockRunAgent.mock.calls[0][0].systemPrompt
    expect(prompt).toContain("No product vision document found")
  })

  it("appends user message before agent call and assistant message after", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    expect(mockAppendMessage).toHaveBeenCalledTimes(2)
    const calls = mockAppendMessage.mock.calls
    expect(calls[0][1].role).toBe("user")
    expect(calls[0][1].content).toBe("What is the product vision?")
    expect(calls[1][1].role).toBe("assistant")
    expect(calls[1][1].content).toBe("Here is my expert recommendation on the product vision.")
  })

  it("prompt states no feature specs — product-level only", async () => {
    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "pm" })
    const prompt = mockRunAgent.mock.calls[0][0].systemPrompt
    expect(prompt).toContain("product-level conversation")
    expect(prompt).toContain("no feature specs")
  })

  it("pipeline status is summary count only — no individual feature names", async () => {
    // Mock 3 features in progress
    const { getInProgressFeatures } = await import("../../runtime/github-client")
    ;(getInProgressFeatures as any).mockResolvedValueOnce([
      { featureName: "onboarding", phase: "engineering-in-progress" },
      { featureName: "notifications", phase: "design-in-progress" },
      { featureName: "search", phase: "product-spec-in-progress" },
    ])

    await handleGeneralChannelAgentMessage({ ...baseParams, agent: "architect" })
    const prompt = mockRunAgent.mock.calls[0][0].systemPrompt
    // Should contain count, not individual names
    expect(prompt).toContain("3 features in progress")
    expect(prompt).not.toContain("onboarding")
    expect(prompt).not.toContain("notifications")
    // Should redirect to concierge for details
    expect(prompt).toContain("Concierge")
  })
})
