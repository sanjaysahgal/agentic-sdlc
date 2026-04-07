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

import { buildActionMenu } from "../../../interfaces/slack/handlers/message"

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
      { emoji: ":art:", label: "Brand Drift", issues: ["token-a: spec red → brand blue", "token-b: spec 2s → brand 4s"] },
      { emoji: ":mag:", label: "Quality", issues: ["TBD placeholder in copy"] },
    ])
    expect(result).toContain("1. token-a")
    expect(result).toContain("2. token-b")
    expect(result).toContain("3. TBD placeholder")
    // Numbers must be globally sequential, not per-category
    expect(result).not.toMatch(/^1\. TBD/m)
  })

  it("includes category header with emoji and issue count", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: ["issue one", "issue two"] },
    ])
    expect(result).toContain("*:art: Brand Drift (2):*")
  })

  it("omits categories with zero issues — no empty header", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: [] },
      { emoji: ":mag:", label: "Quality", issues: ["real issue"] },
    ])
    expect(result).not.toContain("Brand Drift")
    expect(result).toContain("Quality")
  })

  it("includes OPEN ITEMS header and fix CTA", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: ["x"] },
    ])
    expect(result).toContain("*── OPEN ITEMS ──*")
    expect(result).toContain("Say *fix 1 2 3* (or *fix all*)")
  })

  it("starts with separator and newlines", () => {
    const result = buildActionMenu([
      { emoji: ":art:", label: "Brand Drift", issues: ["x"] },
    ])
    expect(result).toMatch(/^\n\n---/)
  })
})
