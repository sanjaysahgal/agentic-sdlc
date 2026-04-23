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
  handleDesignTool,
  handleSaveDesignDraft,
  handleApplyDesignSpecPatch,
  handleRewriteDesignSpec,
  handleGenerateDesignPreview,
  handleOfferPmEscalation,
  handleOfferArchitectEscalation,
  handleFetchUrl,
  handleDesignPhaseCompletionAudit,
  handleFinalizeDesignSpec,
  detectResolvedQuestions,
  ToolHandlerContext,
  PmToolDeps,
  ArchitectToolDeps,
  ArchitectToolState,
  DesignToolDeps,
  DesignToolCtx,
  DesignToolState,
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

    it("passes approvedProductSpec to auditSpecDraft when available (Call-Site Context Rule)", async () => {
      const deps = buildPmDeps()
      const ctx = buildMockCtx({
        context: { productVision: "Build a health app", systemArchitecture: "React + Node", currentDraft: "", featureConventions: "", approvedProductSpec: "## User Stories\n- US-1: sign up" },
      })
      await handleSaveProductSpecDraft({ content: "# Spec" }, ctx, deps)
      const auditCall = (deps.auditSpecDraft as any).mock.calls[0][0]
      expect(auditCall.productSpec).toBe("## User Stories\n- US-1: sign up")
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
  const freshState = (): ArchitectToolState => ({ escalationFired: false, pendingDecisionReview: null })

  describe("dispatch", () => {
    it("returns error for unknown tool", async () => {
      const result = await handleArchitectTool("unknown_tool", {}, archCtx(), buildArchDeps(), freshState())
      expect(result.error).toContain("Unknown tool")
    })
  })

  describe("save_engineering_spec_draft", () => {
    it("audits and saves draft when no decisions resolved", async () => {
      const deps = buildArchDeps()
      const result = await handleSaveEngineeringSpecDraft({ content: "# Eng Spec" }, archCtx(), deps, freshState())
      expect(deps.auditSpecDraft).toHaveBeenCalled()
      expect(deps.saveDraftEngineeringSpec).toHaveBeenCalled()
      expect((result.result as any).url).toContain("github.com")
    })

    it("blocks on audit conflict", async () => {
      const deps = buildArchDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "conflict", message: "Bad spec" }),
      })
      const result = await handleSaveEngineeringSpecDraft({ content: "bad" }, archCtx(), deps, freshState())
      expect(result.error).toContain("Conflict detected")
      expect(deps.saveDraftEngineeringSpec).not.toHaveBeenCalled()
    })

    it("passes approvedProductSpec to auditSpecDraft when available", async () => {
      const deps = buildArchDeps()
      const ctx = archCtx()
      ctx.context = { ...ctx.context, approvedProductSpec: "# Approved PM Spec" }
      await handleSaveEngineeringSpecDraft({ content: "# Eng" }, ctx, deps, freshState())
      expect(deps.auditSpecDraft).toHaveBeenCalledWith(
        expect.objectContaining({ productSpec: "# Approved PM Spec" })
      )
    })

    it("holds content for review when open questions are resolved (Fix B)", async () => {
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec\n## Open Questions\n- What DB? [blocking: yes]")
      const deps = buildArchDeps({
        extractAllOpenQuestions: vi.fn()
          .mockReturnValueOnce(["What DB? [blocking: yes]"])  // old draft
          .mockReturnValueOnce([]),                            // new content — question resolved
      })
      const state = freshState()
      const result = await handleSaveEngineeringSpecDraft({ content: "# Spec\n## Open Questions\n(none)" }, ctx, deps, state)
      // Should NOT save
      expect(deps.saveDraftEngineeringSpec).not.toHaveBeenCalled()
      // Should set pending decision review
      expect(state.pendingDecisionReview).not.toBeNull()
      expect(state.pendingDecisionReview!.resolvedQuestions).toContain("What DB? [blocking: yes]")
      expect((result.result as any).status).toBe("pending_review")
    })

    it("saves normally on first save (no existing draft)", async () => {
      const deps = buildArchDeps()
      const state = freshState()
      const result = await handleSaveEngineeringSpecDraft({ content: "# New Spec" }, archCtx(), deps, state)
      expect(deps.saveDraftEngineeringSpec).toHaveBeenCalled()
      expect(state.pendingDecisionReview).toBeNull()
    })
  })

  describe("apply_engineering_spec_patch", () => {
    it("reads, patches, audits, saves when no decisions resolved", async () => {
      const deps = buildArchDeps()
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Existing Eng Spec")
      const result = await handleApplyEngineeringSpecPatch({ patch: "## New Section" }, ctx, deps, freshState())
      expect(deps.applySpecPatch).toHaveBeenCalledWith("# Existing Eng Spec", "## New Section")
      expect(deps.saveDraftEngineeringSpec).toHaveBeenCalled()
      expect(result.error).toBeUndefined()
    })

    it("holds content for review when patch resolves open questions (Fix B)", async () => {
      const ctx = archCtx()
      ctx.readFile = vi.fn().mockResolvedValue("# Spec\n## Open Questions\n- Which cache? [blocking: yes]")
      const deps = buildArchDeps({
        applySpecPatch: vi.fn().mockReturnValue("# Spec\n## Open Questions\n(empty)"),
        extractAllOpenQuestions: vi.fn()
          .mockReturnValueOnce(["Which cache? [blocking: yes]"])  // existing
          .mockReturnValueOnce([]),                                // merged — resolved
      })
      const state = freshState()
      const result = await handleApplyEngineeringSpecPatch({ patch: "resolve cache question" }, ctx, deps, state)
      expect(deps.saveDraftEngineeringSpec).not.toHaveBeenCalled()
      expect(state.pendingDecisionReview).not.toBeNull()
      expect((result.result as any).status).toBe("pending_review")
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

  // ─── Fix A: Escalation stops the turn ──────────────────────────────────────
  describe("escalation stops the turn (Fix A)", () => {
    it("blocks save_engineering_spec_draft after escalation fires", async () => {
      const state = freshState()
      const deps = buildArchDeps()
      // Simulate escalation already fired
      state.escalationFired = true
      const result = await handleArchitectTool("save_engineering_spec_draft", { content: "# Spec" }, archCtx(), deps, state)
      expect(result.error).toContain("Blocked")
      expect(result.error).toContain("offer_upstream_revision")
      expect(deps.saveDraftEngineeringSpec).not.toHaveBeenCalled()
    })

    it("blocks apply_engineering_spec_patch after escalation fires", async () => {
      const state = freshState()
      state.escalationFired = true
      const deps = buildArchDeps()
      const result = await handleArchitectTool("apply_engineering_spec_patch", { patch: "## Patch" }, archCtx(), deps, state)
      expect(result.error).toContain("Blocked")
      expect(deps.saveDraftEngineeringSpec).not.toHaveBeenCalled()
    })

    it("blocks finalize_engineering_spec after escalation fires", async () => {
      const state = freshState()
      state.escalationFired = true
      const result = await handleArchitectTool("finalize_engineering_spec", {}, archCtx(), buildArchDeps(), state)
      expect(result.error).toContain("Blocked")
    })

    it("sets escalationFired when offer_upstream_revision is dispatched", async () => {
      const state = freshState()
      expect(state.escalationFired).toBe(false)
      await handleArchitectTool("offer_upstream_revision", { targetAgent: "pm", question: "Q" }, archCtx(), buildArchDeps(), state)
      expect(state.escalationFired).toBe(true)
    })

    it("does not block read_approved_specs after escalation", async () => {
      const state = freshState()
      state.escalationFired = true
      const result = await handleArchitectTool("read_approved_specs", { featureNames: [] }, archCtx(), buildArchDeps(), state)
      expect(result.error).toBeUndefined()
    })
  })

  // ─── detectResolvedQuestions unit tests ─────────────────────────────────────
  describe("detectResolvedQuestions", () => {
    const extractor = (content: string) =>
      content.split("\n").filter(l => l.includes("[blocking:")).map(l => l.replace(/^[-*]\s*/, "").trim())

    it("returns empty when no existing draft", () => {
      expect(detectResolvedQuestions(null, "# Spec", extractor)).toEqual([])
    })

    it("returns empty when same questions in both", () => {
      const old = "- Q1 [blocking: yes]\n- Q2 [blocking: no]"
      const newC = "- Q1 [blocking: yes]\n- Q2 [blocking: no]"
      expect(detectResolvedQuestions(old, newC, extractor)).toEqual([])
    })

    it("detects resolved questions", () => {
      const old = "- Q1 [blocking: yes]\n- Q2 [blocking: no]"
      const newC = "- Q2 [blocking: no]"
      expect(detectResolvedQuestions(old, newC, extractor)).toEqual(["Q1 [blocking: yes]"])
    })

    it("detects all questions resolved", () => {
      const old = "- Q1 [blocking: yes]\n- Q2 [blocking: no]"
      const newC = "No questions"
      expect(detectResolvedQuestions(old, newC, extractor)).toEqual(["Q1 [blocking: yes]", "Q2 [blocking: no]"])
    })
  })
})

// ────────────────────────────────────────────────────────────────────────────────
// Design Tool Handler
// ────────────────────────────────────────────────────────────────────────────────

function buildDesignCtx(overrides?: Partial<DesignToolCtx>): DesignToolCtx {
  return {
    featureName: "onboarding",
    specFilePath: "specs/features/onboarding/onboarding.design.md",
    specBranchName: "spec/onboarding-design",
    context: { productVision: "Build a health app", systemArchitecture: "React + Node", currentDraft: "# Design Spec", featureConventions: "", approvedProductSpec: "# PM Spec" },
    update: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
    getHistory: () => [],
    loadWorkspaceConfig: () => ({ githubOwner: "org", githubRepo: "repo", paths: { featuresRoot: "specs/features" } }),
    auditProductSpec: "PM spec content",
    brand: "## Colors\n--primary: #00F",
    targetFormFactors: ["mobile"],
    channelId: "C123",
    threadTs: "1234.5678",
    isFixAll: false,
    ...overrides,
  }
}

function buildDesignDeps(overrides?: Partial<DesignToolDeps>): DesignToolDeps {
  return {
    auditSpecDraft: vi.fn().mockResolvedValue({ status: "ok" }),
    saveDraftDesignSpec: vi.fn().mockResolvedValue(undefined),
    saveApprovedDesignSpec: vi.fn().mockResolvedValue(undefined),
    applySpecPatch: vi.fn((_existing: string, patch: string) => patch),
    extractAllOpenQuestions: vi.fn().mockReturnValue([]),
    auditPhaseCompletion: vi.fn().mockResolvedValue({ ready: true, findings: [] }),
    auditDownstreamReadiness: vi.fn().mockResolvedValue({ findings: [] }),
    auditSpecDecisions: vi.fn().mockResolvedValue({ status: "ok" }),
    applyDecisionCorrections: vi.fn((_c) => ({ corrected: _c })),
    auditSpecStructure: vi.fn().mockReturnValue([]),
    auditBrandTokens: vi.fn().mockReturnValue([]),
    auditAnimationTokens: vi.fn().mockReturnValue([]),
    extractDesignAssumptions: vi.fn().mockReturnValue(""),
    seedHandoffSection: vi.fn().mockResolvedValue(undefined),
    classifyForPmGaps: vi.fn().mockResolvedValue({ gaps: ["What session TTL?"], architectItems: [], designItems: [] }),
    classifyForArchGap: vi.fn().mockResolvedValue("ARCHITECTURE-GAP"),
    preseedEngineeringSpec: vi.fn().mockResolvedValue(undefined),
    setPendingEscalation: vi.fn(),
    generateDesignPreview: vi.fn().mockResolvedValue({ html: "<html>preview</html>", warnings: [] }),
    saveDraftHtmlPreview: vi.fn().mockResolvedValue(undefined),
    filterDesignContent: vi.fn().mockResolvedValue("filtered content"),
    buildDesignRubric: vi.fn().mockReturnValue("test rubric"),
    uploadFileToSlack: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

function buildDesignState(overrides?: Partial<DesignToolState>): DesignToolState {
  return { patchAppliedThisTurn: false, lastGeneratedPreviewHtml: null, ...overrides }
}

describe("handleDesignTool", () => {
  describe("dispatch", () => {
    it("returns error for unknown tool", async () => {
      const result = await handleDesignTool("unknown_tool", {}, buildDesignCtx(), buildDesignDeps(), buildDesignState())
      expect(result.error).toContain("Unknown tool")
    })

    it("blocks escalation during fix-all", async () => {
      const ctx = buildDesignCtx({ isFixAll: true })
      const result = await handleDesignTool("offer_pm_escalation", { question: "Q" }, ctx, buildDesignDeps(), buildDesignState())
      expect((result.result as string)).toContain("Fix-all mode")
    })

    it("blocks architect escalation during fix-all", async () => {
      const ctx = buildDesignCtx({ isFixAll: true })
      const result = await handleDesignTool("offer_architect_escalation", { question: "Q" }, ctx, buildDesignDeps(), buildDesignState())
      expect((result.result as string)).toContain("Fix-all mode")
    })
  })

  describe("save_design_spec_draft", () => {
    it("audits, saves, generates preview, uploads to Slack", async () => {
      const deps = buildDesignDeps()
      const state = buildDesignState()
      const result = await handleSaveDesignDraft({ content: "# Design Spec" }, buildDesignCtx(), deps, state)
      expect(deps.auditSpecDraft).toHaveBeenCalled()
      expect(deps.saveDraftDesignSpec).toHaveBeenCalled()
      expect(deps.generateDesignPreview).toHaveBeenCalled()
      expect(deps.uploadFileToSlack).toHaveBeenCalled()
      expect((result.result as any).specUrl).toContain("github.com")
      expect((result.result as any).previewUrl).toBe("uploaded_to_slack")
    })

    it("blocks on audit conflict", async () => {
      const deps = buildDesignDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "conflict", message: "Contradicts vision" }),
      })
      const result = await handleSaveDesignDraft({ content: "bad" }, buildDesignCtx(), deps, buildDesignState())
      expect(result.error).toContain("Conflict detected")
      expect(deps.saveDraftDesignSpec).not.toHaveBeenCalled()
    })

    it("blocks when structural findings increase (health gate)", async () => {
      const ctx = buildDesignCtx({
        readFile: vi.fn().mockResolvedValue("# Existing spec"),
      })
      const deps = buildDesignDeps({
        auditSpecStructure: vi.fn()
          .mockReturnValueOnce([]) // pre-save: 0 findings
          .mockReturnValueOnce([{ issue: "Duplicate heading", recommendation: "Remove" }]), // post-save: 1 finding
      })
      const result = await handleSaveDesignDraft({ content: "# Bad spec" }, ctx, deps, buildDesignState())
      expect(result.error).toContain("Save blocked")
      expect(deps.saveDraftDesignSpec).not.toHaveBeenCalled()
    })

    it("returns brand drifts when present", async () => {
      const deps = buildDesignDeps({
        auditBrandTokens: vi.fn().mockReturnValue([{ token: "--primary", specValue: "#F00", brandValue: "#00F" }]),
      })
      const result = await handleSaveDesignDraft({ content: "# Spec" }, buildDesignCtx(), deps, buildDesignState())
      expect((result.result as any).brandDrifts).toHaveLength(1)
    })

    it("returns gap status when audit finds gaps", async () => {
      const deps = buildDesignDeps({
        auditSpecDraft: vi.fn().mockResolvedValue({ status: "gap", message: "Missing screen" }),
      })
      const result = await handleSaveDesignDraft({ content: "# Spec" }, buildDesignCtx(), deps, buildDesignState())
      expect((result.result as any).specGap).toBe("Missing screen")
      expect(deps.saveDraftDesignSpec).toHaveBeenCalled()
    })

    it("handles preview generation failure gracefully", async () => {
      const deps = buildDesignDeps({
        generateDesignPreview: vi.fn().mockRejectedValue(new Error("render boom")),
      })
      const result = await handleSaveDesignDraft({ content: "# Spec" }, buildDesignCtx(), deps, buildDesignState())
      expect(result.error).toBeUndefined()
      expect((result.result as any).previewUrl).toBe("none")
    })
  })

  describe("apply_design_spec_patch", () => {
    it("reads existing, patches, saves (skipSlackUpload=true)", async () => {
      const deps = buildDesignDeps()
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Existing Design") })
      const state = buildDesignState()
      const result = await handleApplyDesignSpecPatch({ patch: "## New Section" }, ctx, deps, state)
      expect(deps.applySpecPatch).toHaveBeenCalledWith("# Existing Design", "## New Section")
      expect(deps.saveDraftDesignSpec).toHaveBeenCalled()
      expect(state.patchAppliedThisTurn).toBe(true)
      // skipSlackUpload=true → no Slack upload
      expect(deps.uploadFileToSlack).not.toHaveBeenCalled()
      expect(result.error).toBeUndefined()
    })
  })

  describe("rewrite_design_spec", () => {
    it("saves full rewrite (skipSlackUpload=true), sets patchAppliedThisTurn", async () => {
      const deps = buildDesignDeps()
      const state = buildDesignState()
      const result = await handleRewriteDesignSpec({ content: "# Full Rewrite" }, buildDesignCtx(), deps, state)
      expect(deps.saveDraftDesignSpec).toHaveBeenCalled()
      expect(state.patchAppliedThisTurn).toBe(true)
      expect(deps.uploadFileToSlack).not.toHaveBeenCalled()
      expect(result.error).toBeUndefined()
    })
  })

  describe("generate_design_preview", () => {
    it("uploads cached HTML when it exists", async () => {
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("<html>cached</html>") })
      const deps = buildDesignDeps()
      const result = await handleGenerateDesignPreview(ctx, deps)
      expect(deps.uploadFileToSlack).toHaveBeenCalledWith(expect.objectContaining({ content: "<html>cached</html>" }))
      expect(deps.generateDesignPreview).not.toHaveBeenCalled()
      expect((result.result as any).previewUrl).toBe("uploaded_to_slack")
    })

    it("generates and uploads when no cache exists", async () => {
      const deps = buildDesignDeps()
      const result = await handleGenerateDesignPreview(buildDesignCtx(), deps)
      expect(deps.generateDesignPreview).toHaveBeenCalled()
      expect(deps.saveDraftHtmlPreview).toHaveBeenCalled()
      expect(deps.uploadFileToSlack).toHaveBeenCalled()
      expect((result.result as any).previewUrl).toBe("uploaded_to_slack")
    })

    it("returns error on preview failure", async () => {
      const deps = buildDesignDeps({
        generateDesignPreview: vi.fn().mockRejectedValue(new Error("render failed")),
      })
      const result = await handleGenerateDesignPreview(buildDesignCtx(), deps)
      expect(result.error).toContain("Preview failed")
    })
  })

  describe("offer_pm_escalation", () => {
    it("stores escalation when PM gaps found", async () => {
      const deps = buildDesignDeps()
      const result = await handleOfferPmEscalation({ question: "What session TTL?" }, buildDesignCtx(), deps)
      expect(deps.setPendingEscalation).toHaveBeenCalledWith("onboarding", expect.objectContaining({
        targetAgent: "pm",
        question: "What session TTL?",
      }))
      expect((result.result as string)).toContain("Escalation offer stored")
    })

    it("rejects when no PM gaps — returns design items", async () => {
      const deps = buildDesignDeps({
        classifyForPmGaps: vi.fn().mockResolvedValue({ gaps: [], architectItems: [], designItems: ["Pick button color"] }),
      })
      const result = await handleOfferPmEscalation({ question: "Pick button color" }, buildDesignCtx(), deps)
      expect((result.result as string)).toContain("REJECTED")
      expect((result.result as string)).toContain("Pick button color")
      expect(deps.setPendingEscalation).not.toHaveBeenCalled()
    })

    it("rejects with generic message when no PM gaps and no design items", async () => {
      const deps = buildDesignDeps({
        classifyForPmGaps: vi.fn().mockResolvedValue({ gaps: [], architectItems: [], designItems: [] }),
      })
      const result = await handleOfferPmEscalation({ question: "hex values" }, buildDesignCtx(), deps)
      expect((result.result as string)).toContain("REJECTED")
      expect((result.result as string)).toContain("BRAND.md")
    })

    it("pre-seeds architect items when filtered from PM escalation", async () => {
      const deps = buildDesignDeps({
        classifyForPmGaps: vi.fn().mockResolvedValue({ gaps: ["TTL?"], architectItems: ["DB schema?"], designItems: [] }),
      })
      await handleOfferPmEscalation({ question: "TTL? DB schema?" }, buildDesignCtx(), deps)
      expect(deps.preseedEngineeringSpec).toHaveBeenCalledWith(expect.objectContaining({
        architectItems: ["DB schema?"],
      }))
    })
  })

  describe("offer_architect_escalation", () => {
    it("stores escalation for architecture gap", async () => {
      const deps = buildDesignDeps()
      const result = await handleOfferArchitectEscalation({ question: "What DB?" }, buildDesignCtx(), deps)
      expect(deps.setPendingEscalation).toHaveBeenCalledWith("onboarding", expect.objectContaining({
        targetAgent: "architect",
        question: "What DB?",
      }))
      expect((result.result as string)).toContain("Architect")
    })

    it("rejects design-assumption questions", async () => {
      const deps = buildDesignDeps({
        classifyForArchGap: vi.fn().mockResolvedValue("DESIGN-ASSUMPTION"),
      })
      const result = await handleOfferArchitectEscalation({ question: "How is data stored?" }, buildDesignCtx(), deps)
      expect((result.result as string)).toContain("PLATFORM REJECTION")
      expect(deps.setPendingEscalation).not.toHaveBeenCalled()
    })
  })

  describe("fetch_url", () => {
    it("fetches and filters content", async () => {
      const deps = buildDesignDeps()
      const mockResponse = { ok: true, text: vi.fn().mockResolvedValue("<html>raw</html>") }
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any)
      const result = await handleFetchUrl({ url: "https://example.com" }, deps)
      expect(deps.filterDesignContent).toHaveBeenCalledWith("<html>raw</html>")
      expect((result.result as any).content).toBe("filtered content")
      vi.restoreAllMocks()
    })

    it("returns error on HTTP failure", async () => {
      const mockResponse = { ok: false, status: 404, statusText: "Not Found" }
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse as any)
      const result = await handleFetchUrl({ url: "https://bad.com" }, buildDesignDeps())
      expect(result.error).toContain("HTTP 404")
      vi.restoreAllMocks()
    })

    it("returns error on network failure", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("timeout"))
      const result = await handleFetchUrl({ url: "https://slow.com" }, buildDesignDeps())
      expect(result.error).toContain("Fetch failed")
      vi.restoreAllMocks()
    })
  })

  describe("run_phase_completion_audit", () => {
    it("returns findings when draft exists", async () => {
      const deps = buildDesignDeps({
        auditPhaseCompletion: vi.fn().mockResolvedValue({
          ready: false,
          findings: [{ issue: "Missing error state", recommendation: "Add error" }],
        }),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Design Draft") })
      const result = await handleDesignPhaseCompletionAudit(ctx, deps)
      expect((result.result as any).ready).toBe(false)
      expect((result.result as any).findings).toHaveLength(1)
      expect(deps.buildDesignRubric).toHaveBeenCalledWith(["mobile"])
    })

    it("returns 'no draft' when no draft exists", async () => {
      const result = await handleDesignPhaseCompletionAudit(buildDesignCtx(), buildDesignDeps())
      expect((result.result as any).ready).toBe(false)
      expect((result.result as any).findings[0].issue).toContain("No design spec draft found")
    })
  })

  describe("finalize_design_spec", () => {
    it("saves to main on success", async () => {
      const deps = buildDesignDeps()
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Clean Design Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(deps.saveApprovedDesignSpec).toHaveBeenCalled()
      expect((result.result as any).nextPhase).toBe("engineering")
    })

    it("blocks when no draft exists", async () => {
      const result = await handleFinalizeDesignSpec(buildDesignCtx(), buildDesignDeps())
      expect(result.error).toContain("No draft saved yet")
    })

    it("blocks when open questions exist", async () => {
      const deps = buildDesignDeps({
        extractAllOpenQuestions: vi.fn().mockReturnValue(["What color?", "What font?"]),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(result.error).toContain("2 open questions")
    })

    it("blocks when structural conflicts exist", async () => {
      const deps = buildDesignDeps({
        auditSpecStructure: vi.fn().mockReturnValue([{ issue: "Duplicate heading", recommendation: "Remove" }]),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(result.error).toContain("structural conflict")
    })

    it("blocks when architect readiness fails", async () => {
      const deps = buildDesignDeps({
        auditDownstreamReadiness: vi.fn().mockResolvedValue({
          findings: [{ issue: "No responsive spec", recommendation: "Add breakpoints" }],
        }),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(result.error).toContain("not architect-ready")
    })

    it("blocks when brand token drift detected", async () => {
      const deps = buildDesignDeps({
        auditBrandTokens: vi.fn().mockReturnValue([{ token: "--primary", specValue: "#F00", brandValue: "#00F" }]),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(result.error).toContain("brand token drift")
    })

    it("blocks when animation token drift detected", async () => {
      const deps = buildDesignDeps({
        auditAnimationTokens: vi.fn().mockReturnValue([{ param: "duration", specValue: "200ms", brandValue: "300ms" }]),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(result.error).toContain("brand token drift")
    })

    it("applies decision corrections before saving", async () => {
      const deps = buildDesignDeps({
        auditSpecDecisions: vi.fn().mockResolvedValue({
          status: "corrections",
          corrections: [{ description: "Glow opacity", found: "0.1", correct: "0.2" }],
        }),
        applyDecisionCorrections: vi.fn().mockReturnValue({ corrected: "# Corrected Design" }),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      await handleFinalizeDesignSpec(ctx, deps)
      expect(deps.applyDecisionCorrections).toHaveBeenCalled()
      expect(deps.saveApprovedDesignSpec).toHaveBeenCalledWith(
        expect.objectContaining({ content: "# Corrected Design" })
      )
    })

    it("seeds design assumptions to engineering branch", async () => {
      const deps = buildDesignDeps({
        extractDesignAssumptions: vi.fn().mockReturnValue("- Bottom sheet is 90vh"),
      })
      const ctx = buildDesignCtx({ readFile: vi.fn().mockResolvedValue("# Spec") })
      await handleFinalizeDesignSpec(ctx, deps)
      expect(deps.seedHandoffSection).toHaveBeenCalledWith(expect.objectContaining({
        targetSectionHeading: "## Design Assumptions To Validate",
        content: "- Bottom sheet is 90vh",
      }))
    })

    it("skips brand drift check when no brand context", async () => {
      const deps = buildDesignDeps({
        auditBrandTokens: vi.fn().mockReturnValue([{ token: "--primary", specValue: "#F00", brandValue: "#00F" }]),
      })
      const ctx = buildDesignCtx({ brand: undefined, readFile: vi.fn().mockResolvedValue("# Spec") })
      const result = await handleFinalizeDesignSpec(ctx, deps)
      expect(deps.auditBrandTokens).not.toHaveBeenCalled()
      expect((result.result as any).nextPhase).toBe("engineering")
    })
  })
})
