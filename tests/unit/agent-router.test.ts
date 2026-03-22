import { describe, it, expect, vi, beforeEach } from "vitest"

// agent-router.ts calls `new Anthropic()` at module load — mock before the static import.
// vi.mock() with vi.fn() inside the factory is fine here because the factory
// references mockCreate via vi.hoisted() (available at factory execution time).
const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import {
  detectPhase,
  classifyIntent,
  classifyMessageScope,
  classifyApprovedPhaseIntent,
} from "../../runtime/agent-router"

// ─── detectPhase — pure logic, no mocks needed ────────────────────────────

describe("detectPhase", () => {
  it("returns briefing when product spec is not approved", () => {
    expect(detectPhase({ productSpecApproved: false, engineeringSpecApproved: false })).toBe("briefing")
  })

  it("returns engineering when product spec is approved but engineering spec is not", () => {
    expect(detectPhase({ productSpecApproved: true, engineeringSpecApproved: false })).toBe("engineering")
  })

  it("returns implementation when both specs are approved", () => {
    expect(detectPhase({ productSpecApproved: true, engineeringSpecApproved: true })).toBe("implementation")
  })

  it("ignores engineeringSpecApproved when productSpecApproved is false", () => {
    // Engineering cannot be approved without product being approved first — briefing takes precedence
    expect(detectPhase({ productSpecApproved: false, engineeringSpecApproved: true })).toBe("briefing")
  })
})

// ─── classifyIntent, classifyMessageScope, classifyApprovedPhaseIntent ─────
// All call Claude API — tested with the Anthropic client mocked via mockCreate.
// These tests verify the routing contract (valid response → correct type, invalid → safe default)
// without making real API calls.

describe("classifyIntent", () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it("returns valid agent type when Claude responds with known agent name", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "pm" }] })
    const result = await classifyIntent({ message: "I want to add a new feature", history: [], phase: "briefing" })
    expect(result).toBe("pm")
  })

  it("falls back to pm when Claude returns an unknown agent name", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "unknown-agent" }] })
    const result = await classifyIntent({ message: "something unclear", history: [], phase: "briefing" })
    expect(result).toBe("pm")
  })
})

describe("classifyApprovedPhaseIntent", () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it("returns start-design when Claude responds with start-design", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "start-design" }] })
    const result = await classifyApprovedPhaseIntent("ok let's kick off the design phase")
    expect(result).toBe("start-design")
  })

  it("returns spec-query when Claude responds with spec-query", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "spec-query" }] })
    const result = await classifyApprovedPhaseIntent("what are the open questions in the spec?")
    expect(result).toBe("spec-query")
  })

  it("returns proposal when Claude responds with proposal", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "proposal" }] })
    const result = await classifyApprovedPhaseIntent("thinking of adding multi-language support")
    expect(result).toBe("proposal")
  })

  it("returns status when Claude responds with status", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "status" }] })
    const result = await classifyApprovedPhaseIntent("where are we with this feature?")
    expect(result).toBe("status")
  })

  it("falls back to status on unexpected Claude response", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "unknown-intent" }] })
    const result = await classifyApprovedPhaseIntent("??")
    expect(result).toBe("status")
  })
})

describe("classifyMessageScope", () => {
  beforeEach(() => {
    mockCreate.mockReset()
  })

  it("returns product-context when Claude classifies as product-level", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "product-context" }] })
    const result = await classifyMessageScope("What is the product vision?")
    expect(result).toBe("product-context")
  })

  it("returns feature-specific when Claude classifies as feature-level", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "feature-specific" }] })
    const result = await classifyMessageScope("What are the open questions for onboarding?")
    expect(result).toBe("feature-specific")
  })

  it("falls back to feature-specific on unexpected Claude response", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "something-unexpected" }] })
    const result = await classifyMessageScope("??")
    expect(result).toBe("feature-specific")
  })
})
