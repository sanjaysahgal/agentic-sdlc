import { describe, it, expect, vi, beforeEach } from "vitest"

// context-loader.ts instantiates Anthropic at module load and imports github-client
// (which itself calls loadWorkspaceConfig + new Octokit at load time).
// Use vi.hoisted() for mock functions so they're available when factories run.

const { mockReadFile, mockCreate } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockCreate: vi.fn(),
}))

vi.mock("../../runtime/github-client", () => ({
  readFile: mockReadFile,
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: vi.fn().mockReturnValue({
    paths: {
      productVision: "specs/product/PRODUCT_VISION.md",
      systemArchitecture: "specs/architecture/system-architecture.md",
      featureConventions: "specs/features/CLAUDE.md",
      featuresRoot: "specs/features",
    },
  }),
}))

import { loadAgentContext, loadAgentContextForQuery } from "../../runtime/context-loader"

describe("context-loader", () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockCreate.mockReset()
  })

  // ─── loadAgentContext ────────────────────────────────────────────────────

  describe("loadAgentContext", () => {
    it("returns productVision and systemArchitecture from readFile", async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("PRODUCT_VISION")) return Promise.resolve("# Vision")
        if (path.includes("system-architecture")) return Promise.resolve("# Architecture")
        return Promise.resolve("")
      })

      const result = await loadAgentContext()
      expect(result.productVision).toBe("# Vision")
      expect(result.systemArchitecture).toBe("# Architecture")
    })

    it("returns empty strings for docs when readFile returns empty", async () => {
      mockReadFile.mockResolvedValue("")

      const result = await loadAgentContext()
      expect(result.productVision).toBe("")
      expect(result.systemArchitecture).toBe("")
      expect(result.currentDraft).toBe("")
    })

    it("loads current draft from feature branch when featureName is provided", async () => {
      mockReadFile.mockImplementation((_path: string, ref?: string) => {
        if (ref === "spec/onboarding-product") return Promise.resolve("# Draft Spec")
        return Promise.resolve("")
      })

      const result = await loadAgentContext("onboarding")
      expect(result.currentDraft).toBe("# Draft Spec")
    })

    it("sets currentDraft to empty string when no featureName provided", async () => {
      mockReadFile.mockResolvedValue("")

      const result = await loadAgentContext()
      expect(result.currentDraft).toBe("")
    })

    it("reads draft from correct path: {featuresRoot}/{name}/{name}.product.md on spec branch", async () => {
      mockReadFile.mockResolvedValue("")

      await loadAgentContext("onboarding")

      expect(mockReadFile).toHaveBeenCalledWith(
        "specs/features/onboarding/onboarding.product.md",
        "spec/onboarding-product"
      )
    })
  })

  // ─── loadAgentContextForQuery ────────────────────────────────────────────

  describe("loadAgentContextForQuery", () => {
    it("returns Haiku-filtered content for a query", async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("PRODUCT_VISION")) return Promise.resolve("Full vision document")
        return Promise.resolve("")
      })
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "Relevant excerpt from vision" }],
      })

      const result = await loadAgentContextForQuery("What is the target user?")
      expect(result.productVision).toBe("Relevant excerpt from vision")
    })

    it("sets currentDraft and featureConventions to empty string", async () => {
      mockReadFile.mockResolvedValue("Some doc content")
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "Filtered content" }],
      })

      const result = await loadAgentContextForQuery("What is the architecture?")
      expect(result.currentDraft).toBe("")
      expect(result.featureConventions).toBe("")
    })
  })

  // ─── summarizeForContext (via loadAgentContextForQuery) ──────────────────

  describe("summarizeForContext (via loadAgentContextForQuery)", () => {
    it("skips Haiku call and returns empty string when doc is empty", async () => {
      mockReadFile.mockResolvedValue("")

      const result = await loadAgentContextForQuery("What is the target user?")

      expect(mockCreate).not.toHaveBeenCalled()
      expect(result.productVision).toBe("")
      expect(result.systemArchitecture).toBe("")
    })

    it("uses claude-haiku-4-5-20251001 model for summarization", async () => {
      mockReadFile.mockResolvedValue("Some non-empty document content")
      mockCreate.mockResolvedValue({
        content: [{ type: "text", text: "excerpt" }],
      })

      await loadAgentContextForQuery("What tech stack do we use?")

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
      )
    })
  })
})
