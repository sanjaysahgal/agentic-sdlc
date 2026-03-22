import { describe, it, expect, vi, beforeEach } from "vitest"

// auditSpecDraft calls `new Anthropic()` at module load — mock before any import.
// Use vi.hoisted() so mockCreate is available when the factory runs (factories are hoisted
// above module-level code, so plain `const mockCreate = vi.fn()` would be undefined there).
const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

describe("auditSpecDraft", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns ok immediately when both productVision and systemArchitecture are empty — no API call", async () => {
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "",
      systemArchitecture: "",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("returns ok when Claude responds OK", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "We build a web app for teams.",
      systemArchitecture: "tRPC, Prisma, Next.js.",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
  })

  it("returns conflict with stripped message when Claude responds CONFLICT", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "CONFLICT: draft proposes password auth but vision mandates SSO only" }],
    })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Auth spec — add password login",
      productVision: "All auth is SSO only.",
      systemArchitecture: "Next-Auth with SSO provider.",
      featureName: "auth",
    })
    expect(result.status).toBe("conflict")
    if (result.status === "conflict") {
      expect(result.message).toBe("draft proposes password auth but vision mandates SSO only")
      expect(result.message).not.toContain("CONFLICT:")
    }
  })

  it("returns gap with stripped message when Claude responds GAP", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "GAP: draft assumes native mobile app exists but vision only describes web" }],
    })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Notifications — push to iOS and Android",
      productVision: "We build a web app for teams.",
      systemArchitecture: "Next.js only, no mobile.",
      featureName: "notifications",
    })
    expect(result.status).toBe("gap")
    if (result.status === "gap") {
      expect(result.message).toBe("draft assumes native mobile app exists but vision only describes web")
      expect(result.message).not.toContain("GAP:")
    }
  })

  it("returns ok on unexpected Claude response format — does not block save", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot determine if this conflicts." }],
    })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "Vision doc.",
      systemArchitecture: "Arch doc.",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "Vision doc.",
      systemArchitecture: "Arch doc.",
      featureName: "test",
    })
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
    )
  })
})
