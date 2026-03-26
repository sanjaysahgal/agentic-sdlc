import { describe, it, expect, vi, beforeEach } from "vitest"

// context-loader.ts instantiates Anthropic at module load and imports github-client
// (which itself calls loadWorkspaceConfig + new Octokit at load time).
// Use vi.hoisted() for mock functions so they're available when factories run.

const { mockReadFile, mockListSubdirectories, mockCreate } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockListSubdirectories: vi.fn(),
  mockCreate: vi.fn(),
}))

vi.mock("../../runtime/github-client", () => ({
  readFile: mockReadFile,
  listSubdirectories: mockListSubdirectories,
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

vi.mock("../../runtime/workspace-config", () => ({
  loadWorkspaceConfig: vi.fn().mockReturnValue({
    roles: { pmUser: "", designerUser: "", architectUser: "" },
    paths: {
      productVision: "specs/product/PRODUCT_VISION.md",
      systemArchitecture: "specs/architecture/system-architecture.md",
      designSystem: "specs/design/DESIGN_SYSTEM.md",
      brand: "specs/brand/BRAND.md",
      featureConventions: "specs/features/CLAUDE.md",
      featuresRoot: "specs/features",
    },
  }),
}))

import {
  loadAgentContext,
  loadAgentContextForQuery,
  loadDesignAgentContext,
  loadArchitectAgentContext,
} from "../../runtime/context-loader"

describe("context-loader", () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockListSubdirectories.mockReset()
    mockCreate.mockReset()
    // Default: no other feature directories (no cross-feature specs to load)
    mockListSubdirectories.mockResolvedValue([])
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

    it("loads approved product specs from other features for cross-feature coherence", async () => {
      mockListSubdirectories.mockResolvedValue(["dashboard", "onboarding"])
      mockReadFile.mockImplementation((path: string, ref?: string) => {
        if (path.includes("dashboard") && path.endsWith(".product.md") && !ref) return Promise.resolve("# Dashboard spec")
        return Promise.resolve("")
      })

      // Loading context for "onboarding" — should load "dashboard" spec but not "onboarding"
      const result = await loadAgentContext("onboarding")
      expect(result.approvedFeatureSpecs).toContain("# Dashboard spec")
      expect(result.approvedFeatureSpecs).not.toContain("onboarding")
    })

    it("returns empty approvedFeatureSpecs when no other features exist", async () => {
      mockListSubdirectories.mockResolvedValue([])
      mockReadFile.mockResolvedValue("")

      const result = await loadAgentContext("onboarding")
      expect(result.approvedFeatureSpecs).toBe("")
    })

    it("returns empty approvedFeatureSpecs and does not hang when listSubdirectories never resolves", async () => {
      // Simulate a GitHub API hang — listSubdirectories never resolves
      mockListSubdirectories.mockReturnValue(new Promise(() => {}))
      mockReadFile.mockResolvedValue("")

      // Should resolve within the 10s timeout (we use vi fake timers to avoid actually waiting)
      const { vi: viLocal } = await import("vitest")
      viLocal.useFakeTimers()

      const resultPromise = loadAgentContext("onboarding")
      viLocal.advanceTimersByTime(10_001)
      const result = await resultPromise

      expect(result.approvedFeatureSpecs).toBe("")

      viLocal.useRealTimers()
    })
  })

  // ─── loadDesignAgentContext ──────────────────────────────────────────────

  describe("loadDesignAgentContext", () => {
    it("loads design system doc into designSystem field", async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("DESIGN_SYSTEM")) return Promise.resolve("# Design System")
        return Promise.resolve("")
      })

      const result = await loadDesignAgentContext("onboarding")
      expect(result.designSystem).toBe("# Design System")
    })

    it("sets designSystem to empty string when no DESIGN_SYSTEM.md exists", async () => {
      mockReadFile.mockResolvedValue("")

      const result = await loadDesignAgentContext("onboarding")
      expect(result.designSystem).toBe("")
    })

    it("combines approved product spec and design draft into currentDraft", async () => {
      mockReadFile.mockImplementation((path: string, ref?: string) => {
        if (path.endsWith(".product.md") && !ref) return Promise.resolve("# Product Spec")
        if (path.endsWith(".design.md") && ref === "spec/onboarding-design") return Promise.resolve("# Design Draft")
        return Promise.resolve("")
      })

      const result = await loadDesignAgentContext("onboarding")
      expect(result.currentDraft).toContain("## Approved Product Spec")
      expect(result.currentDraft).toContain("# Product Spec")
      expect(result.currentDraft).toContain("## Current Design Draft")
      expect(result.currentDraft).toContain("# Design Draft")
    })

    it("reads design draft from spec branch", async () => {
      mockReadFile.mockResolvedValue("")

      await loadDesignAgentContext("onboarding")

      expect(mockReadFile).toHaveBeenCalledWith(
        "specs/features/onboarding/onboarding.design.md",
        "spec/onboarding-design"
      )
    })

    it("loads approved design specs from other features for cross-feature coherence", async () => {
      mockListSubdirectories.mockResolvedValue(["dashboard", "onboarding"])
      mockReadFile.mockImplementation((path: string, ref?: string) => {
        if (path.includes("dashboard") && path.endsWith(".design.md") && !ref) return Promise.resolve("# Dashboard design")
        return Promise.resolve("")
      })

      const result = await loadDesignAgentContext("onboarding")
      expect(result.approvedFeatureSpecs).toContain("# Dashboard design")
    })

    it("loads brand tokens into brand field", async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("BRAND")) return Promise.resolve("# Brand Tokens\n--bg: #0A0A0F")
        return Promise.resolve("")
      })

      const result = await loadDesignAgentContext("onboarding")
      expect(result.brand).toBe("# Brand Tokens\n--bg: #0A0A0F")
    })

    it("sets brand to empty string when no BRAND.md exists", async () => {
      mockReadFile.mockResolvedValue("")

      const result = await loadDesignAgentContext("onboarding")
      expect(result.brand).toBe("")
    })

    it("reads brand from configured brand path", async () => {
      mockReadFile.mockResolvedValue("")

      await loadDesignAgentContext("onboarding")

      expect(mockReadFile).toHaveBeenCalledWith("specs/brand/BRAND.md")
    })
  })

  // ─── loadArchitectAgentContext ───────────────────────────────────────────

  describe("loadArchitectAgentContext", () => {
    it("combines product spec, design spec, and engineering draft into currentDraft", async () => {
      mockReadFile.mockImplementation((path: string, ref?: string) => {
        if (path.endsWith(".product.md") && !ref) return Promise.resolve("# Product Spec")
        if (path.endsWith(".design.md") && !ref) return Promise.resolve("# Design Spec")
        if (path.endsWith(".engineering.md") && ref === "spec/onboarding-engineering") return Promise.resolve("# Engineering Draft")
        return Promise.resolve("")
      })

      const result = await loadArchitectAgentContext("onboarding")
      expect(result.currentDraft).toContain("## Approved Product Spec")
      expect(result.currentDraft).toContain("## Approved Design Spec")
      expect(result.currentDraft).toContain("## Current Engineering Draft")
    })

    it("reads engineering draft from spec branch", async () => {
      mockReadFile.mockResolvedValue("")

      await loadArchitectAgentContext("onboarding")

      expect(mockReadFile).toHaveBeenCalledWith(
        "specs/features/onboarding/onboarding.engineering.md",
        "spec/onboarding-engineering"
      )
    })

    it("loads approved engineering specs from other features for cross-feature coherence", async () => {
      mockListSubdirectories.mockResolvedValue(["dashboard", "onboarding"])
      mockReadFile.mockImplementation((path: string, ref?: string) => {
        if (path.includes("dashboard") && path.endsWith(".engineering.md") && !ref) return Promise.resolve("# Dashboard engineering")
        return Promise.resolve("")
      })

      const result = await loadArchitectAgentContext("onboarding")
      expect(result.approvedFeatureSpecs).toContain("# Dashboard engineering")
    })

    it("sets featureConventions to empty string (architect doesn't use conventions doc)", async () => {
      mockReadFile.mockResolvedValue("")

      const result = await loadArchitectAgentContext("onboarding")
      expect(result.featureConventions).toBe("")
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
