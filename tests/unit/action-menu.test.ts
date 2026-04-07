import { describe, it, expect, vi } from "vitest"

// buildActionMenu has no Anthropic dependency, but message.ts imports modules that do.
// Mock the heavy dependencies before importing.
vi.mock("../../../runtime/claude-client", () => ({ runAgent: vi.fn() }))
vi.mock("../../../runtime/github-client", () => ({
  readFile: vi.fn(), saveDraftDesignSpec: vi.fn(), saveApprovedDesignSpec: vi.fn(),
  saveDraftHtmlPreview: vi.fn(), getInProgressFeatures: vi.fn(), createSpecPR: vi.fn(),
  saveDraftSpec: vi.fn(), saveApprovedSpec: vi.fn(), saveDraftEngineeringSpec: vi.fn(),
  saveApprovedEngineeringSpec: vi.fn(),
}))
vi.mock("../../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: () => ({ paths: { featuresRoot: "features", productVision: "pv.md", systemArchitecture: "sa.md", brand: null }, targetFormFactors: ["mobile"], githubOwner: "o", githubRepo: "r" }),
}))
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }))

import { buildActionMenu, splitQualityIssue, getChannelState, setChannelState, channelStateStore } from "../../../interfaces/slack/handlers/message"

const item = (issue: string, fix: string) => ({ issue, fix })

describe("buildActionMenu", () => {
  it("returns empty string when all categories have zero issues", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [] },
      { emoji: ":mag:", label: "Quality", issues: [] },
    ])
    expect(result).toBe("")
  })

  it("numbers issues sequentially across all categories", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [item("token-a: spec red", "change to blue"), item("token-b: spec 2s", "change to 4s")] },
      { emoji: ":mag:", label: "Quality", issues: [item("TBD placeholder in copy", "replace with final text")] },
    ])
    expect(result).toContain("1. token-a")
    expect(result).toContain("2. token-b")
    expect(result).toContain("3. TBD placeholder")
    // Numbers must be globally sequential, not per-category
    expect(result).not.toMatch(/^1\. TBD/m)
  })

  it("each item renders issue and Fix label", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [item("glow-duration: spec `2.5s`", "change to `4s`")] },
    ])
    expect(result).toContain("glow-duration: spec `2.5s` — *Fix:* change to `4s`")
  })

  it("includes category header with emoji and issue count", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [item("a", "fix a"), item("b", "fix b")] },
    ])
    expect(result).toContain("*:art: Brand Drift (2):*")
  })

  it("omits categories with zero issues — no empty header", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [] },
      { emoji: ":mag:", label: "Quality", issues: [item("real issue", "do this")] },
    ])
    expect(result).not.toContain("Brand Drift")
    expect(result).toContain("Quality")
  })

  it("includes OPEN ITEMS header and fix CTA", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [item("x", "y")] },
    ])
    expect(result).toContain("*── OPEN ITEMS ──*")
    expect(result).toContain("Say *fix 1 2 3* (or *fix all*)")
  })

  it("starts with separator and newlines", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [item("x", "y")] },
    ])
    expect(result).toMatch(/^\n\n---/)
  })
})

describe("getChannelState / setChannelState", () => {
  it("getChannelState returns default state when channel not set", () => {
    const state = getChannelState("channel-not-set")
    expect(state.productSpecApproved).toBe(false)
    expect(state.engineeringSpecApproved).toBe(false)
    expect(state.pendingAgent).toBeNull()
    expect(state.pendingMessage).toBeNull()
    expect(state.pendingThreadTs).toBeNull()
  })

  it("setChannelState stores state and getChannelState retrieves it", () => {
    const newState = {
      productSpecApproved: true,
      engineeringSpecApproved: false,
      pendingAgent: null,
      pendingMessage: null,
      pendingThreadTs: null,
    }
    setChannelState("feature-test", newState)
    const retrieved = getChannelState("feature-test")
    expect(retrieved.productSpecApproved).toBe(true)
    expect(retrieved.engineeringSpecApproved).toBe(false)
    // cleanup
    channelStateStore.delete("feature-test")
  })
})

describe("splitQualityIssue", () => {
  it("splits on first ' — ' separator", () => {
    const result = splitQualityIssue("Copy literal contains placeholder: \"TBD\" — must be replaced with final text")
    expect(result.issue).toBe("Copy literal contains placeholder: \"TBD\"")
    expect(result.fix).toBe("must be replaced with final text")
  })

  it("uses fallback fix when no separator present", () => {
    const result = splitQualityIssue("some issue with no separator")
    expect(result.issue).toBe("some issue with no separator")
    expect(result.fix).toBe("fix before approval")
  })

  it("splits on first ' — ' only when multiple separators present", () => {
    const result = splitQualityIssue("issue part — fix part — extra info")
    expect(result.issue).toBe("issue part")
    expect(result.fix).toBe("fix part — extra info")
  })
})
