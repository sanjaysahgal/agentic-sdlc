import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock dependencies before importing
vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: () => ({
    mainChannel: "all-acme",
    productName: "Acme",
    paths: { featuresRoot: "specs/features" },
    githubOwner: "org",
    githubRepo: "repo",
  }),
}))

vi.mock("../../interfaces/slack/handlers/message", () => ({
  handleFeatureChannelMessage: vi.fn().mockResolvedValue(undefined),
  getChannelState: vi.fn(() => ({
    productSpecApproved: false,
    engineeringSpecApproved: false,
    pendingAgent: null,
    pendingMessage: null,
    pendingThreadTs: null,
  })),
}))

vi.mock("../../interfaces/slack/handlers/general", () => ({
  handleGeneralChannelAgentMessage: vi.fn().mockResolvedValue(undefined),
}))

import { registerSlashCommands } from "../../interfaces/slack/handlers/commands"
import { handleFeatureChannelMessage } from "../../interfaces/slack/handlers/message"
import { handleGeneralChannelAgentMessage } from "../../interfaces/slack/handlers/general"

function buildMockApp() {
  const handlers = new Map<string, Function>()
  return {
    command: vi.fn((name: string, handler: Function) => {
      handlers.set(name, handler)
    }),
    _handlers: handlers,
  }
}

function buildMockCommand(overrides?: Partial<{ command: string; text: string; channel_id: string; user_id: string }>) {
  return {
    command: overrides?.command ?? "/pm",
    text: overrides?.text ?? "how does the error path work?",
    channel_id: overrides?.channel_id ?? "C123",
    user_id: overrides?.user_id ?? "U456",
  }
}

function buildMockClient(channelName = "feature-onboarding") {
  return {
    conversations: {
      info: vi.fn().mockResolvedValue({ channel: { name: channelName } }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "seed-ts" }),
      postEphemeral: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe("registerSlashCommands", () => {
  it("registers /pm, /design, and /architect commands", () => {
    const app = buildMockApp()
    registerSlashCommands(app as any)
    expect(app.command).toHaveBeenCalledTimes(3)
    expect(app._handlers.has("/pm")).toBe(true)
    expect(app._handlers.has("/design")).toBe(true)
    expect(app._handlers.has("/architect")).toBe(true)
  })
})

describe("/pm command handler", () => {
  let app: ReturnType<typeof buildMockApp>

  beforeEach(() => {
    app = buildMockApp()
    registerSlashCommands(app as any)
    vi.clearAllMocks()
  })

  async function invoke(cmd: ReturnType<typeof buildMockCommand>, client: ReturnType<typeof buildMockClient>) {
    const handler = app._handlers.get(cmd.command)!
    const ack = vi.fn()
    await handler({ command: cmd, ack, client })
    return ack
  }

  it("acks immediately", async () => {
    const client = buildMockClient()
    const ack = await invoke(buildMockCommand(), client)
    expect(ack).toHaveBeenCalledTimes(1)
  })

  it("rejects empty text with ephemeral message", async () => {
    const client = buildMockClient()
    await invoke(buildMockCommand({ text: "" }), client)
    expect(client.chat.postEphemeral).toHaveBeenCalled()
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain("Usage:")
  })

  it("rejects overlong text", async () => {
    const client = buildMockClient()
    await invoke(buildMockCommand({ text: "x".repeat(2001) }), client)
    expect(client.chat.postEphemeral).toHaveBeenCalled()
    expect(client.chat.postEphemeral.mock.calls[0][0].text).toContain("too long")
  })

  it("posts seed message in channel", async () => {
    const client = buildMockClient()
    await invoke(buildMockCommand(), client)
    expect(client.chat.postMessage).toHaveBeenCalled()
    const seedCall = client.chat.postMessage.mock.calls[0][0]
    expect(seedCall.text).toContain("PM Agent")
    expect(seedCall.text).toContain("how does the error path work?")
  })

  it("routes to handleFeatureChannelMessage in feature channels with @pm: prefix", async () => {
    const client = buildMockClient("feature-onboarding")
    await invoke(buildMockCommand(), client)
    expect(handleFeatureChannelMessage).toHaveBeenCalledTimes(1)
    const call = (handleFeatureChannelMessage as any).mock.calls[0][0]
    expect(call.userMessage).toBe("@pm: how does the error path work?")
    expect(call.channelName).toBe("feature-onboarding")
    expect(call.threadTs).toBe("seed-ts")
  })

  it("routes to handleGeneralChannelAgentMessage in general channel", async () => {
    const client = buildMockClient("all-acme")
    await invoke(buildMockCommand(), client)
    expect(handleGeneralChannelAgentMessage).toHaveBeenCalledTimes(1)
    const call = (handleGeneralChannelAgentMessage as any).mock.calls[0][0]
    expect(call.agent).toBe("pm")
    expect(call.userMessage).toBe("how does the error path work?")
    expect(call.threadTs).toBe("seed-ts")
  })

  it("posts error in unsupported channels", async () => {
    const client = buildMockClient("random-channel")
    await invoke(buildMockCommand(), client)
    expect(handleFeatureChannelMessage).not.toHaveBeenCalled()
    expect(handleGeneralChannelAgentMessage).not.toHaveBeenCalled()
    // Seed + error = 2 postMessage calls
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2)
    expect(client.chat.postMessage.mock.calls[1][0].text).toContain("feature channels")
  })

  it("/design routes to ux-design agent in general channel", async () => {
    const client = buildMockClient("all-acme")
    await invoke(buildMockCommand({ command: "/design", text: "show me the brand" }), client)
    const call = (handleGeneralChannelAgentMessage as any).mock.calls[0][0]
    expect(call.agent).toBe("ux-design")
  })

  it("/architect routes to architect agent in general channel", async () => {
    const client = buildMockClient("all-acme")
    await invoke(buildMockCommand({ command: "/architect", text: "what is the tech stack?" }), client)
    const call = (handleGeneralChannelAgentMessage as any).mock.calls[0][0]
    expect(call.agent).toBe("architect")
  })
})
