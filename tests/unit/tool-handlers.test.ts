import { describe, it, expect, vi } from "vitest"
import {
  handlePmTool,
  handleSaveProductSpecDraft,
  handleApplyProductSpecPatch,
  handlePmPhaseCompletionAudit,
  handleFinalizeProductSpec,
  handleArchitectTool,
  handleSaveEngineeringSpecDraft,
  handleApplyEngineeringSpecPatch,
  handleReadApprovedSpecs,
  handleFinalizeEngineeringSpec,
  handleOfferUpstreamRevision,
  ToolHandlerContext,
  PmToolDeps,
  ArchitectToolDeps,
} from "../../runtime/tool-handlers"

// ────────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────────

function buildMockCtx(overrides?: Partial<ToolHandlerContext>): ToolHandlerContext {
  return {
    featureName: "onboarding",
    specFilePath: "specs/features/onboarding/onboarding.product.md",
    specBranchName: "spec/onboarding-product",
    context: { productVision: "Build a health app", systemArchitecture: "React + Node", currentDraft: "", featureConventions: "" },
    update: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
    getHistory: () => [],
    loadWorkspaceConfig: () => ({ githubOwner: "org", githubRepo: "repo", paths: { featuresRoot: "specs/features" } }),
    ...overrides,
  }
}

function buildPmDeps(overrides?: Partial<PmToolDeps>): PmToolDeps {
  return {
    sanitizePmSpecDraft: vi.fn((c: string) => ({ content: c, wasModified: false, strippedSections: [], strippedOpenQuestions: [] })),
    auditSpecDraft: vi.fn().mockResolvedValue({ status: "ok" }),
    saveDraftSpec: vi.fn().mockResolvedValue(undefined),
    saveApprovedSpec: vi.fn().mockResolvedValue(undefined),
    applySpecPatch: vi.fn((_existing: string, patch: string) => patch),
    extractAllOpenQuestions: vi.fn().mockReturnValue([]),
    extractHandoffSection: vi.fn().mockReturnValue(""),
    auditPhaseCompletion: vi.fn().mockResolvedValue({ ready: true, findings: [] }),
    auditDownstreamReadiness: vi.fn().mockResolvedValue({ findings: [] }),
    auditSpecDecisions: vi.fn().mockResolvedValue({ status: "ok" }),
    applyDecisionCorrections: vi.fn((_c, _corr) => ({ corrected: _c })),
    PM_RUBRIC: "test rubric",
    PM_DESIGN_READINESS_RUBRIC: "test design readiness rubric",
    ...overrides,
  }
}

function buildArchDeps(overrides?: Partial<ArchitectToolDeps>): ArchitectToolDeps {
  return {
    auditSpecDraft: vi.fn().mockResolvedValue({ status: "ok" }),
    saveDraftEngineeringSpec: vi.fn().mockResolvedValue(undefined),
    saveApprovedEngineeringSpec: vi.fn().mockResolvedValue(undefined),
    applySpecPatch: vi.fn((_existing: string, patch: string) => patch),
    extractAllOpenQuestions: vi.fn().mockReturnValue([]),
    extractHandoffSection: vi.fn().mockReturnValue(""),
    auditSpecDecisions: vi.fn().mockResolvedValue({ status: "ok" }),
    applyDecisionCorrections: vi.fn((_c, _corr) => ({ corrected: _c })),
    auditDownstreamReadiness: vi.fn().mockResolvedValue({ findings: [] }),
    auditSpecStructure: vi.fn().mockReturnValue([]),
    clearHandoffSection: vi.fn().mockResolvedValue(undefined),
    setPendingEscalation: vi.fn(),
    readFile: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// PM Tool Handler
// ────────────────────────────────────────────────────────────────────────────────
describe("handlePmTool", () => {
  describe("dispatch", () => {
    it("returns error for unknown tool", async () => {
      const result = await handlePmTool("unknown_tool", {}, buildMockCtx(), buildPmDeps())
      expect(result.error).toContain("Unknown tool")
    })

    it("routes offer_architect_escalation to static response", async () => {
      const result = await handlePmTool("offer_architect_escalation", {}, buildMockCtx(), buildPmDeps())
      expect(result.result).toContain("Architecture gap registered")
    })
  })

  describe("save_product_spec_draft", () => {
    it("sanitizes, audits, and saves draft", async () => {
      const deps = buildPmDeps()
      const ctx = buildMockCtx()
      const result = await handleSaveProductSpecDraft({ content: "# Spec\nContent" }, ctx, deps)
      expect(deps.sanitizePmSpecDraft).toHaveBeenCalledWith("# Spec\nContent")
      expect(deps.auditSpecDraft).toHaveBeenCalled()
      expect(deps.saveDraftSpec).toHaveBeenCalled()
      expect((result.result as any).url).toContain("github.com")
      expect((result.result as any).audit.status).toBe("ok")
    })

    it("blocks on audit conflict", async () => {
      const deps = buildPmDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "conflict", message: "Contradicts vision" }),
      })
      const result = await handleSaveProductSpecDraft({ content: "bad content" }, buildMockCtx(), deps)
      expect(result.error).toContain("Conflict detected")
      expect(deps.saveDraftSpec).not.toHaveBeenCalled()
    })

    it("includes sanitize note when content was modified", async () => {
      const deps = buildPmDeps({
        sanitizePmSpecDraft: vi.fn(() => ({
          content: "cleaned",
          wasModified: true,
          strippedSections: ["## Design Tokens"],
          strippedOpenQuestions: ["What color?"],
        })),
      })
      const result = await handleSaveProductSpecDraft({ content: "raw" }, buildMockCtx(), deps)
      expect((result.result as any).sanitized.strippedSections).toContain("## Design Tokens")
    })

    it("returns gap status when audit finds gaps", async () => {
      const deps = buildPmDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "gap", message: "Missing auth flow" }),
      })
      const result = await handleSaveProductSpecDraft({ content: "spec" }, buildMockCtx(), deps)
      expect((result.result as any).audit.status).toBe("gap")
      expect((result.result as any).audit.message).toBe("Missing auth flow")
      // Should still save (gap is a warning, not a block)
      expect(deps.saveDraftSpec).toHaveBeenCalled()
    })
  })

  describe("apply_product_spec_patch", () => {
    it("reads existing, patches, sanitizes, audits, saves", async () => {
      const deps = buildPmDeps()
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Existing Spec"),
      })
      const result = await handleApplyProductSpecPatch({ patch: "## New Section\nContent" }, ctx, deps)
      expect(deps.applySpecPatch).toHaveBeenCalledWith("# Existing Spec", "## New Section\nContent")
      expect(deps.saveDraftSpec).toHaveBeenCalled()
      expect(result.error).toBeUndefined()
    })

    it("blocks on audit conflict", async () => {
      const deps = buildPmDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "conflict", message: "Bad patch" }),
      })
      const result = await handleApplyProductSpecPatch({ patch: "bad" }, buildMockCtx(), deps)
      expect(result.error).toContain("Conflict detected")
    })
  })

  describe("run_phase_completion_audit", () => {
    it("returns findings when draft exists", async () => {
      const deps = buildPmDeps({
        auditPhaseCompletion: vi.fn().mockResolvedValue({
          ready: false,
          findings: [{ issue: "Missing AC", recommendation: "Add acceptance criteria" }],
        }),
      })
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Draft Spec"),
      })
      const result = await handlePmPhaseCompletionAudit(ctx, deps)
      expect((result.result as any).ready).toBe(false)
      expect((result.result as any).findings).toHaveLength(1)
    })

    it("returns 'no draft' finding when no draft exists", async () => {
      const result = await handlePmPhaseCompletionAudit(buildMockCtx(), buildPmDeps())
      expect((result.result as any).ready).toBe(false)
      expect((result.result as any).findings[0].issue).toContain("No spec draft found")
    })
  })

  describe("finalize_product_spec", () => {
    it("saves to main on success", async () => {
      const deps = buildPmDeps()
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Finalized Spec\n\nClean content."),
      })
      const result = await handleFinalizeProductSpec(ctx, deps)
      expect(deps.saveApprovedSpec).toHaveBeenCalled()
      expect((result.result as any).nextPhase).toBe("design")
    })

    it("blocks when open questions exist", async () => {
      const deps = buildPmDeps({
        extractAllOpenQuestions: vi.fn().mockReturnValue(["What about caching?"]),
      })
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Spec with questions"),
      })
      const result = await handleFinalizeProductSpec(ctx, deps)
      expect(result.error).toContain("Approval blocked")
      expect(result.error).toContain("open question")
    })

    it("blocks when Design Notes non-empty", async () => {
      const deps = buildPmDeps({
        extractHandoffSection: vi.fn().mockReturnValue("- Note 1: consider mobile layout"),
      })
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Spec"),
      })
      const result = await handleFinalizeProductSpec(ctx, deps)
      expect(result.error).toContain("Design Notes must be empty")
    })

    it("blocks when design readiness audit fails", async () => {
      const deps = buildPmDeps({
        auditPhaseCompletion: vi.fn().mockResolvedValue({
          ready: false,
          findings: [{ issue: "Missing form factor", recommendation: "Specify mobile layout" }],
        }),
      })
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Spec"),
      })
      const result = await handleFinalizeProductSpec(ctx, deps)
      expect(result.error).toContain("not design-ready")
    })

    it("blocks when adversarial downstream readiness fails", async () => {
      const deps = buildPmDeps({
        auditDownstreamReadiness: vi.fn().mockResolvedValue({
          findings: [{ issue: "No error states defined", recommendation: "Add error handling" }],
        }),
      })
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Spec"),
      })
      const result = await handleFinalizeProductSpec(ctx, deps)
      expect(result.error).toContain("not design-ready")
    })

    it("applies decision corrections before saving", async () => {
      const deps = buildPmDeps({
        auditSpecDecisions: vi.fn().mockResolvedValue({
          status: "corrections",
          corrections: [{ original: "old text", corrected: "new text" }],
        }),
        applyDecisionCorrections: vi.fn().mockReturnValue({ corrected: "# Corrected Spec" }),
      })
      const ctx = buildMockCtx({
        readFile: vi.fn().mockResolvedValue("# Spec"),
      })
      await handleFinalizeProductSpec(ctx, deps)
      expect(deps.applyDecisionCorrections).toHaveBeenCalled()
      expect(deps.saveApprovedSpec).toHaveBeenCalledWith(
        expect.objectContaining({ content: "# Corrected Spec" })
      )
    })

    it("returns error when no draft exists", async () => {
      const result = await handleFinalizeProductSpec(buildMockCtx(), buildPmDeps())
      expect(result.error).toContain("No draft saved yet")
    })
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Architect Tool Handler
// ────────────────────────────────────────────────────────────────────────────────
describe("handleArchitectTool", () => {
  const archCtx = () => buildMockCtx({
    specFilePath: "specs/features/onboarding/onboarding.engineering.md",
    specBranchName: "spec/onboarding-engineering",
  })

  describe("dispatch", () => {
    it("returns error for unknown tool", async () => {
      const result = await handleArchitectTool("unknown_tool", {}, archCtx(), buildArchDeps())
      expect(result.error).toContain("Unknown tool")
    })
  })

  describe("save_engineering_spec_draft", () => {
    it("audits and saves draft", async () => {
      const deps = buildArchDeps()
      const result = await handleSaveEngineeringSpecDraft({ content: "# Eng Spec" }, archCtx(), deps)
      expect(deps.auditSpecDraft).toHaveBeenCalled()
      expect(deps.saveDraftEngineeringSpec).toHaveBeenCalled()
      expect((result.result as any).url).toContain("github.com")
    })

    it("blocks on audit conflict", async () => {
      const deps = buildArchDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "conflict", message: "Bad spec" }),
      })
      const result = await handleSaveEngineeringSpecDraft({ content: "bad" }, archCtx(), deps)
      expect(result.error).toContain("Conflict detected")
      expect(deps.saveDraftEngineeringSpec).not.toHaveBeenCalled()
    })
  })

  describe("apply_engineering_spec_patch", () => {
    it("reads, patches, audits, saves", async () => {
      const deps = buildArchDeps()
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Existing Eng Spec")
      const result = await handleApplyEngineeringSpecPatch({ patch: "## New Section" }, ctx, deps)
      expect(deps.applySpecPatch).toHaveBeenCalledWith("# Existing Eng Spec", "## New Section")
      expect(deps.saveDraftEngineeringSpec).toHaveBeenCalled()
      expect(result.error).toBeUndefined()
    })
  })

  describe("read_approved_specs", () => {
    it("returns note for empty feature names", async () => {
      const result = await handleReadApprovedSpecs({ featureNames: [] }, archCtx(), buildArchDeps())
      expect((result.result as any).note).toContain("already loaded")
    })

    it("reads specs for requested features", async () => {
      const deps = buildArchDeps({
        readFile: vi.fn().mockResolvedValue("# Approved Engineering Spec"),
      })
      const result = await handleReadApprovedSpecs({ featureNames: ["auth"] }, archCtx(), deps)
      expect((result.result as any).specs.auth).toBe("# Approved Engineering Spec")
    })

    it("skips features with no approved spec", async () => {
      const deps = buildArchDeps({
        readFile: vi.fn().mockResolvedValue(null),
      })
      const result = await handleReadApprovedSpecs({ featureNames: ["missing"] }, archCtx(), deps)
      expect((result.result as any).specs).toEqual({})
    })
  })

  describe("finalize_engineering_spec", () => {
    it("saves to main on success", async () => {
      const deps = buildArchDeps()
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Eng Spec\n\nClean content.")
      const result = await handleFinalizeEngineeringSpec(ctx, deps)
      expect(deps.saveApprovedEngineeringSpec).toHaveBeenCalled()
      expect((result.result as any).nextPhase).toBe("build")
    })

    it("blocks when no draft exists", async () => {
      const result = await handleFinalizeEngineeringSpec(archCtx(), buildArchDeps())
      expect(result.error).toContain("No draft saved yet")
    })

    it("blocks when open questions exist", async () => {
      const deps = buildArchDeps({
        extractAllOpenQuestions: vi.fn().mockReturnValue(["What DB?", "Which cache?"]),
      })
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec with questions")
      const result = await handleFinalizeEngineeringSpec(ctx, deps)
      expect(result.error).toContain("2 open questions")
    })

    it("blocks when unconfirmed design assumptions exist", async () => {
      const deps = buildArchDeps({
        extractHandoffSection: vi.fn().mockReturnValue("- Assumption: bottom sheet is 90vh"),
      })
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec")
      const result = await handleFinalizeEngineeringSpec(ctx, deps)
      expect(result.error).toContain("Design Assumptions To Validate")
    })

    it("blocks when engineer readiness audit fails", async () => {
      const deps = buildArchDeps({
        auditDownstreamReadiness: vi.fn().mockResolvedValue({
          findings: [{ issue: "No API contracts", recommendation: "Define REST endpoints" }],
        }),
      })
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec")
      const result = await handleFinalizeEngineeringSpec(ctx, deps)
      expect(result.error).toContain("not engineer-ready")
    })

    it("applies decision corrections before saving", async () => {
      const deps = buildArchDeps({
        auditSpecDecisions: vi.fn().mockResolvedValue({
          status: "corrections",
          corrections: [{ original: "old", corrected: "new" }],
        }),
        applyDecisionCorrections: vi.fn().mockReturnValue({ corrected: "# Corrected Eng" }),
      })
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec")
      await handleFinalizeEngineeringSpec(ctx, deps)
      expect(deps.saveApprovedEngineeringSpec).toHaveBeenCalledWith(
        expect.objectContaining({ content: "# Corrected Eng" })
      )
    })

    it("clears design assumptions on success", async () => {
      const deps = buildArchDeps()
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec")
      await handleFinalizeEngineeringSpec(ctx, deps)
      expect(deps.clearHandoffSection).toHaveBeenCalledWith(
        expect.objectContaining({ sectionHeading: "## Design Assumptions" })
      )
    })
  })

  describe("offer_upstream_revision", () => {
    it("stores escalation with PM target", async () => {
      const deps = buildArchDeps()
      const result = await handleOfferUpstreamRevision(
        { targetAgent: "pm", question: "AC doesn't cover edge case X" },
        archCtx(),
        deps,
      )
      expect(deps.setPendingEscalation).toHaveBeenCalledWith("onboarding", expect.objectContaining({
        targetAgent: "pm",
        question: "AC doesn't cover edge case X",
      }))
      expect((result.result as string)).toContain("PM")
    })

    it("stores escalation with design target", async () => {
      const deps = buildArchDeps()
      const result = await handleOfferUpstreamRevision(
        { targetAgent: "design", question: "Button layout conflicts with auth sheet" },
        archCtx(),
        deps,
      )
      expect(deps.setPendingEscalation).toHaveBeenCalledWith("onboarding", expect.objectContaining({
        targetAgent: "design",
      }))
      expect((result.result as string)).toContain("Designer")
    })
  })
})
