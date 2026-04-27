/**
 * Extracted tool handlers for PM, Design, and Architect agents.
 *
 * Each handler is a standalone function that takes typed context as input,
 * making it unit-testable without E2E routing ceremony. The context adapters
 * (readFile, update, saveDraft, etc.) are injected so tests can mock them directly.
 *
 * The dispatch functions (handlePmTool, handleDesignTool, handleArchitectTool)
 * are drop-in replacements for the closure-based tool handlers in message.ts.
 */

import { AgentContext } from "./context-loader"
import { Message } from "./conversation-store"
import type { FeatureKey } from "./routing/types"
import { featureKey } from "./routing/types"
import type { DecisionCorrection, DecisionAuditResult } from "./spec-auditor"
import type { DownstreamRole } from "./phase-completion-auditor"

/**
 * Compares open questions between old and new spec drafts. Returns the list of
 * questions that were open in the old draft but are no longer open in the new draft.
 * These represent architectural decisions the architect has made.
 */
export function detectResolvedQuestions(
  existingDraft: string | null,
  newContent: string,
  extractAllOpenQuestions: (content: string) => string[],
): string[] {
  if (!existingDraft) return []  // First save — no prior questions to compare against
  const oldQuestions = extractAllOpenQuestions(existingDraft)
  const newQuestions = new Set(extractAllOpenQuestions(newContent))
  // Questions present in old but absent in new = resolved
  return oldQuestions.filter(q => !newQuestions.has(q))
}

/** Slack file upload adapter — abstracts the Slack client dependency. */
export type SlackFileUploader = (params: { channelId: string; threadTs: string; content: string; filename: string; title: string }) => Promise<void>

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

export type ToolResult = { result?: unknown; error?: string }

/** Adapter for reading files from the target repo. */
export type FileReader = (path: string, branch: string) => Promise<string | null>

/** Adapter for saving draft specs to GitHub. */
export type DraftSaver = (params: { featureName: string; filePath: string; content: string }) => Promise<void>

/** Adapter for saving approved specs to main. */
export type ApprovedSaver = (params: { featureName: string; filePath: string; content: string }) => Promise<unknown>

/** Core context shared by all agent tool handlers. */
export type ToolHandlerContext = {
  featureName: string
  specFilePath: string
  specBranchName: string
  context: AgentContext
  update: (text: string) => Promise<void>
  readFile: FileReader
  getHistory: () => Message[]
  loadWorkspaceConfig: () => { githubOwner: string; githubRepo: string; paths: { featuresRoot: string } }
}

// ────────────────────────────────────────────────────────────────────────────────
// PM Tool Handler
// ────────────────────────────────────────────────────────────────────────────────

export type PmToolDeps = {
  sanitizePmSpecDraft: (content: string) => { content: string; wasModified: boolean; strippedSections: string[]; strippedOpenQuestions: string[] }
  auditSpecDraft: (params: { draft: string; productVision: string; systemArchitecture: string; featureName: string; productSpec?: string }) => Promise<{ status: string; message?: string }>
  saveDraftSpec: DraftSaver
  saveApprovedSpec: ApprovedSaver
  applySpecPatch: (existing: string, patch: string) => string
  extractAllOpenQuestions: (content: string) => string[]
  extractHandoffSection: (content: string, heading: string) => string
  auditPhaseCompletion: (params: { specContent: string; rubric: string; featureName: string; productVision?: string; systemArchitecture?: string }) => Promise<{ ready: boolean; findings: Array<{ issue: string; recommendation: string }> }>
  auditDownstreamReadiness: (params: { specContent: string; downstreamRole: DownstreamRole; featureName: string }) => Promise<{ findings: Array<{ issue: string; recommendation: string }> }>
  auditSpecDecisions: (params: { specContent: string; history: Array<{ role: string; content: string }> }) => Promise<DecisionAuditResult>
  applyDecisionCorrections: (content: string, corrections: DecisionCorrection[]) => { corrected: string }
  PM_RUBRIC: string
  PM_DESIGN_READINESS_RUBRIC: string
}

export async function handlePmTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: PmToolDeps,
): Promise<ToolResult> {
  if (name === "save_product_spec_draft") {
    return handleSaveProductSpecDraft(input, ctx, deps)
  }
  if (name === "apply_product_spec_patch") {
    return handleApplyProductSpecPatch(input, ctx, deps)
  }
  if (name === "run_phase_completion_audit") {
    return handlePmPhaseCompletionAudit(ctx, deps)
  }
  if (name === "finalize_product_spec") {
    return handleFinalizeProductSpec(ctx, deps)
  }
  if (name === "offer_architect_escalation") {
    return { result: "Architecture gap registered. If the user confirms, the architect will be brought in to resolve it before engineering begins." }
  }
  return { error: `Unknown tool: ${name}` }
}

export async function handleSaveProductSpecDraft(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: PmToolDeps,
): Promise<ToolResult> {
  const rawContent = input.content as string
  const sanitized = deps.sanitizePmSpecDraft(rawContent)
  const content = sanitized.content
  await ctx.update("_Auditing spec against product vision and architecture..._")
  const audit = await deps.auditSpecDraft({
    draft: content,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    featureName: ctx.featureName,
    productSpec: ctx.context.approvedProductSpec,
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — spec not saved: ${audit.message}` }
  }
  await ctx.update("_Saving draft to GitHub..._")
  await deps.saveDraftSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content })
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${ctx.specBranchName}/${ctx.specFilePath}`
  const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
  const sanitizeNote = sanitized.wasModified
    ? { strippedSections: sanitized.strippedSections, strippedOpenQuestions: sanitized.strippedOpenQuestions }
    : undefined
  return { result: { url, audit: auditOut, ...(sanitizeNote ? { sanitized: sanitizeNote } : {}) } }
}

export async function handleApplyProductSpecPatch(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: PmToolDeps,
): Promise<ToolResult> {
  const patch = input.patch as string
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  const rawMerged = deps.applySpecPatch(existingDraft ?? "", patch)
  const sanitized = deps.sanitizePmSpecDraft(rawMerged)
  const mergedDraft = sanitized.content
  await ctx.update("_Auditing patch against product vision and architecture..._")
  const audit = await deps.auditSpecDraft({
    draft: mergedDraft,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    featureName: ctx.featureName,
    productSpec: ctx.context.approvedProductSpec,
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — patch not saved: ${audit.message}` }
  }
  await ctx.update("_Saving updated draft to GitHub..._")
  await deps.saveDraftSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content: mergedDraft })
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${ctx.specBranchName}/${ctx.specFilePath}`
  const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
  return { result: { url, audit: auditOut } }
}

export async function handlePmPhaseCompletionAudit(
  ctx: ToolHandlerContext,
  deps: PmToolDeps,
): Promise<ToolResult> {
  await ctx.update("_Running phase completion audit..._")
  const draft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  if (!draft) {
    return { result: { ready: false, findings: [{ issue: "No spec draft found", recommendation: "Save a draft first using save_product_spec_draft before running the audit." }] } }
  }
  const result = await deps.auditPhaseCompletion({
    specContent: draft,
    rubric: deps.PM_RUBRIC,
    featureName: ctx.featureName,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
  })
  return { result }
}

export async function handleFinalizeProductSpec(
  ctx: ToolHandlerContext,
  deps: PmToolDeps,
): Promise<ToolResult> {
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  if (!existingDraft) {
    return { error: "No draft saved yet — save a draft first before finalizing." }
  }
  const allOpenQuestions = deps.extractAllOpenQuestions(existingDraft)
  if (allOpenQuestions.length > 0) {
    return { error: `Approval blocked — ${allOpenQuestions.length} open question${allOpenQuestions.length > 1 ? "s" : ""} must be resolved first (blocking and non-blocking questions both block finalization):\n${allOpenQuestions.map(q => `• ${q}`).join("\n")}` }
  }
  const designNotes = deps.extractHandoffSection(existingDraft, "## Design Notes")
  if (designNotes.trim()) {
    return { error: `Approval blocked — ## Design Notes must be empty before finalization. Address or move each design note before submitting the final spec.` }
  }
  const [designReadiness, adversarialReadiness] = await Promise.all([
    deps.auditPhaseCompletion({ specContent: existingDraft, rubric: deps.PM_DESIGN_READINESS_RUBRIC, featureName: ctx.featureName }),
    deps.auditDownstreamReadiness({ specContent: existingDraft, downstreamRole: "designer", featureName: ctx.featureName }),
  ])
  const allReadinessFindings = [...designReadiness.findings, ...adversarialReadiness.findings]
  if (allReadinessFindings.length > 0) {
    const findingLines = allReadinessFindings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
    return { error: `Approval blocked — spec is not design-ready. A designer receiving this spec would need to invent the following answers:\n${findingLines}\n\nResolve each before finalizing.` }
  }
  let finalContent = existingDraft
  const decisionAudit = await deps.auditSpecDecisions({ specContent: existingDraft, history: ctx.getHistory() })
  if (decisionAudit.status === "corrections") {
    const { corrected } = deps.applyDecisionCorrections(existingDraft, decisionAudit.corrections!)
    finalContent = corrected
  }
  await ctx.update("_Saving final product spec..._")
  await deps.saveApprovedSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content: finalContent })
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${ctx.specFilePath}`
  return { result: { url, nextPhase: "design" } }
}

// ────────────────────────────────────────────────────────────────────────────────
// Architect Tool Handler
// ────────────────────────────────────────────────────────────────────────────────

export type ArchitectToolDeps = {
  auditSpecDraft: PmToolDeps["auditSpecDraft"]
  saveDraftEngineeringSpec: DraftSaver
  saveApprovedEngineeringSpec: ApprovedSaver
  applySpecPatch: (existing: string, patch: string) => string
  extractAllOpenQuestions: (content: string) => string[]
  extractHandoffSection: (content: string, heading: string) => string
  auditSpecDecisions: PmToolDeps["auditSpecDecisions"]
  applyDecisionCorrections: PmToolDeps["applyDecisionCorrections"]
  auditDownstreamReadiness: PmToolDeps["auditDownstreamReadiness"]
  auditSpecStructure: (content: string, specType: "design" | "product" | "engineering") => Array<{ issue: string; recommendation: string }>
  clearHandoffSection: (params: { featureName: string; filePath: string; sectionHeading: string }) => Promise<void>
  setPendingEscalation: (key: FeatureKey, escalation: { targetAgent: "pm" | "architect" | "design"; question: string; designContext: string; engineeringContext?: string }) => void
  readFile: FileReader
}

/** Mutable state passed by reference so the caller can read mutations after runAgent completes. */
export type ArchitectToolState = {
  /** Set when offer_upstream_revision fires — blocks further spec saves in the same turn. */
  escalationFired: boolean
  /** Pending decision review — when spec save contains resolved open questions, the content
   *  is held here instead of saving. The caller surfaces decisions for human confirmation. */
  pendingDecisionReview: {
    content: string
    filePath: string
    resolvedQuestions: string[]
  } | null
}

export async function handleArchitectTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
  state: ArchitectToolState,
): Promise<ToolResult> {
  // Fix A: When escalation fires, block all spec saves in the same turn.
  // The escalation is the output of the turn — the architect should not write spec
  // content based on assumptions about how the upstream agent will resolve the gap.
  if (state.escalationFired && (name === "save_engineering_spec_draft" || name === "apply_engineering_spec_patch" || name === "finalize_engineering_spec")) {
    console.log(`[ESCALATION-STOP] Blocked ${name} — escalation was already fired this turn`)
    return { error: `Blocked: you called offer_upstream_revision earlier in this turn. The escalation is the output of this turn — do not save or patch the spec until the upstream agent resolves the gap. Wrap up your response now.` }
  }
  if (name === "save_engineering_spec_draft") {
    return handleSaveEngineeringSpecDraft(input, ctx, deps, state)
  }
  if (name === "apply_engineering_spec_patch") {
    return handleApplyEngineeringSpecPatch(input, ctx, deps, state)
  }
  if (name === "read_approved_specs") {
    return handleReadApprovedSpecs(input, ctx, deps)
  }
  if (name === "finalize_engineering_spec") {
    return handleFinalizeEngineeringSpec(ctx, deps, state)
  }
  if (name === "offer_upstream_revision") {
    state.escalationFired = true
    return handleOfferUpstreamRevision(input, ctx, deps)
  }
  return { error: `Unknown tool: ${name}` }
}

export async function handleSaveEngineeringSpecDraft(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
  state: ArchitectToolState,
): Promise<ToolResult> {
  const content = input.content as string
  await ctx.update("_Auditing spec against product vision and architecture..._")
  const audit = await deps.auditSpecDraft({
    draft: content,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    featureName: ctx.featureName,
    productSpec: ctx.context.approvedProductSpec,
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — spec not saved: ${audit.message}` }
  }

  // Fix B: Detect resolved open questions — hold content for human review if decisions were made.
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  const resolvedQuestions = detectResolvedQuestions(existingDraft, content, deps.extractAllOpenQuestions)
  if (resolvedQuestions.length > 0) {
    console.log(`[DECISION-REVIEW] save_engineering_spec_draft: ${resolvedQuestions.length} resolved question(s) — holding for human confirmation`)
    state.pendingDecisionReview = { content, filePath: ctx.specFilePath, resolvedQuestions }
    return { result: { status: "pending_review", resolvedQuestions, message: `${resolvedQuestions.length} architectural decision(s) detected. Content held for human review — the user will be asked to confirm before saving.` } }
  }

  await ctx.update("_Saving draft to GitHub..._")
  await deps.saveDraftEngineeringSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content })
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${ctx.specBranchName}/${ctx.specFilePath}`
  const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
  return { result: { url, audit: auditOut } }
}

export async function handleApplyEngineeringSpecPatch(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
  state: ArchitectToolState,
): Promise<ToolResult> {
  const patch = input.patch as string
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  const mergedDraft = deps.applySpecPatch(existingDraft ?? "", patch)
  await ctx.update("_Auditing patch against product vision and architecture..._")
  const audit = await deps.auditSpecDraft({
    draft: mergedDraft,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    featureName: ctx.featureName,
    productSpec: ctx.context.approvedProductSpec,
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — patch not saved: ${audit.message}` }
  }

  // Fix B: Detect resolved open questions — hold content for human review if decisions were made.
  const resolvedQuestions = detectResolvedQuestions(existingDraft, mergedDraft, deps.extractAllOpenQuestions)
  if (resolvedQuestions.length > 0) {
    console.log(`[DECISION-REVIEW] apply_engineering_spec_patch: ${resolvedQuestions.length} resolved question(s) — holding for human confirmation`)
    state.pendingDecisionReview = { content: mergedDraft, filePath: ctx.specFilePath, resolvedQuestions }
    return { result: { status: "pending_review", resolvedQuestions, message: `${resolvedQuestions.length} architectural decision(s) detected. Content held for human review — the user will be asked to confirm before saving.` } }
  }

  await ctx.update("_Saving updated draft to GitHub..._")
  await deps.saveDraftEngineeringSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content: mergedDraft })
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/${ctx.specBranchName}/${ctx.specFilePath}`
  const auditOut = audit.status === "gap" ? { status: audit.status, message: audit.message } : { status: "ok" }
  return { result: { url, audit: auditOut } }
}

export async function handleReadApprovedSpecs(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
): Promise<ToolResult> {
  const featureNames = input.featureNames as string[] | undefined
  if (!featureNames || featureNames.length === 0) {
    return { result: { specs: {}, note: "Approved specs are already loaded in your system prompt context." } }
  }
  const { paths } = ctx.loadWorkspaceConfig()
  const specs: Record<string, string> = {}
  await Promise.all(featureNames.map(async (fn) => {
    const path = `${paths.featuresRoot}/${fn}/${fn}.engineering.md`
    const content = await deps.readFile(path, "main")
    if (content) specs[fn] = content
  }))
  return { result: { specs } }
}

export async function handleFinalizeEngineeringSpec(
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
  state?: ArchitectToolState,
): Promise<ToolResult> {
  // Gate 0: Block if escalation already fired in this turn (Principle 14 — retroactive enforcement)
  if (state?.escalationFired) {
    console.log(`[FINALIZE-GATE] engineering: BLOCKED — escalation fired in this turn`)
    return { error: "Cannot finalize while upstream gaps are pending. Resolve the escalation first." }
  }

  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  if (!existingDraft) {
    return { error: "No draft saved yet — save a draft first before finalizing." }
  }

  // Gate 1: Upstream PM spec deterministic audit (Principle 14 — retroactive enforcement)
  // DESIGN-REVIEWED: Approved specs that fail current deterministic audits block downstream
  // finalization. The spec chain is only as strong as its weakest link. Scales to any number
  // of upstream specs — one auditPmSpec call per finalization, deterministic, <1ms.
  if (ctx.context.approvedProductSpec) {
    const { auditPmSpec } = await import("./deterministic-auditor")
    const pmFindings = auditPmSpec(ctx.context.approvedProductSpec)
    if (!pmFindings.ready) {
      console.log(`[FINALIZE-GATE] engineering: BLOCKED — PM spec has ${pmFindings.findings.length} deterministic finding(s)`)
      const findingLines = pmFindings.findings.map((f, i) => `${i + 1}. [PM SPEC] ${f.issue}`).join("\n")
      return { error: `Approval blocked — the approved PM spec has ${pmFindings.findings.length} deterministic finding(s) that must be resolved before engineering can finalize (Principle 14: deterministic audits are retroactive):\n${findingLines}\n\nUse offer_upstream_revision(pm) to escalate these to the PM for resolution.` }
    }
  }

  // Gate 2: Upstream design spec deterministic audit
  const { paths: wsPaths } = ctx.loadWorkspaceConfig()
  const designSpecPath = `${wsPaths.featuresRoot}/${ctx.featureName}/${ctx.featureName}.design.md`
  const approvedDesignSpec = await deps.readFile(designSpecPath, "main")
  if (approvedDesignSpec) {
    const { auditDesignSpec } = await import("./deterministic-auditor")
    const designFindings = auditDesignSpec(approvedDesignSpec)
    if (!designFindings.ready) {
      console.log(`[FINALIZE-GATE] engineering: BLOCKED — design spec has ${designFindings.findings.length} deterministic finding(s)`)
      const findingLines = designFindings.findings.map((f, i) => `${i + 1}. [DESIGN SPEC] ${f.issue}`).join("\n")
      return { error: `Approval blocked — the approved design spec has ${designFindings.findings.length} deterministic finding(s) that must be resolved before engineering can finalize (Principle 14: deterministic audits are retroactive):\n${findingLines}\n\nUse offer_upstream_revision(design) to escalate these to the designer for resolution.` }
    }
  }

  const allOpenQuestions = deps.extractAllOpenQuestions(existingDraft)
  if (allOpenQuestions.length > 0) {
    return { error: `Approval blocked — ${allOpenQuestions.length} open question${allOpenQuestions.length > 1 ? "s" : ""} must be resolved first (blocking and non-blocking questions both block finalization):\n${allOpenQuestions.map(q => `• ${q}`).join("\n")}` }
  }
  const unconfirmedAssumptions = deps.extractHandoffSection(existingDraft, "## Design Assumptions To Validate")
  if (unconfirmedAssumptions.trim()) {
    return { error: `Approval blocked — ## Design Assumptions To Validate contains unconfirmed items. Confirm each assumption or call offer_upstream_revision(design) to reject it before finalizing:\n${unconfirmedAssumptions}` }
  }
  let finalContent = existingDraft
  const [decisionAudit, engineerReadiness] = await Promise.all([
    deps.auditSpecDecisions({ specContent: existingDraft, history: ctx.getHistory() }),
    deps.auditDownstreamReadiness({ specContent: existingDraft, downstreamRole: "engineer", featureName: ctx.featureName }),
  ])
  if (decisionAudit.status === "corrections") {
    const { corrected } = deps.applyDecisionCorrections(existingDraft, decisionAudit.corrections!)
    finalContent = corrected
  }
  if (engineerReadiness.findings.length > 0) {
    const findingLines = engineerReadiness.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
    return { error: `Approval blocked — spec is not engineer-ready. An engineer receiving this spec would need to invent the following answers:\n${findingLines}\n\nResolve each before finalizing.` }
  }
  await ctx.update("_Saving final engineering spec..._")
  await deps.saveApprovedEngineeringSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content: finalContent })
  // Clear ## Design Assumptions from design spec on main (non-blocking)
  const { paths } = ctx.loadWorkspaceConfig()
  const designSpecFilePath = `${paths.featuresRoot}/${ctx.featureName}/${ctx.featureName}.design.md`
  deps.clearHandoffSection({
    featureName: ctx.featureName,
    filePath: designSpecFilePath,
    sectionHeading: "## Design Assumptions",
  }).catch(err => console.log(`[ENG-FINALIZE] clearHandoffSection failed (non-blocking): ${err}`))
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${ctx.specFilePath}`
  return { result: { url, nextPhase: "build" } }
}

export async function handleOfferUpstreamRevision(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
): Promise<ToolResult> {
  const target = input.targetAgent as "pm" | "design"
  const question = input.question as string
  console.log(`[ESCALATION] offer_upstream_revision: targetAgent=${target} question="${question.slice(0, 100)}"`)
  deps.setPendingEscalation(featureKey(ctx.featureName), {
    targetAgent: target,
    question,
    designContext: "",
    engineeringContext: ctx.context.currentDraft ?? undefined,
  })
  return {
    result: `Upstream revision request stored (target: ${target}). The user will be prompted to confirm. If they say yes, the ${target === "design" ? "Designer" : "PM"} will be notified with your constraint.`,
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Design Tool Handler
// ────────────────────────────────────────────────────────────────────────────────

export type DesignToolDeps = {
  auditSpecDraft: PmToolDeps["auditSpecDraft"]
  saveDraftDesignSpec: DraftSaver
  saveApprovedDesignSpec: ApprovedSaver
  applySpecPatch: (existing: string, patch: string) => string
  extractAllOpenQuestions: (content: string) => string[]
  auditPhaseCompletion: (params: { specContent: string; rubric: string; featureName: string; productVision?: string; systemArchitecture?: string; approvedProductSpec?: string }) => Promise<{ ready: boolean; findings: Array<{ issue: string; recommendation: string }> }>
  auditDownstreamReadiness: (params: { specContent: string; downstreamRole: DownstreamRole; featureName: string }) => Promise<{ findings: Array<{ issue: string; recommendation: string }> }>
  auditSpecDecisions: (params: { specContent: string; history: Array<{ role: string; content: string }> }) => Promise<DecisionAuditResult>
  applyDecisionCorrections: (content: string, corrections: DecisionCorrection[]) => { corrected: string }
  auditSpecStructure: ArchitectToolDeps["auditSpecStructure"]
  auditBrandTokens: (specContent: string, brandContent: string) => Array<{ token: string; specValue: string; brandValue: string }>
  auditAnimationTokens: (specContent: string, brandContent: string) => Array<{ param: string; specValue: string; brandValue: string }>
  extractDesignAssumptions: (content: string) => string
  seedHandoffSection: (params: { featureName: string; targetFilePath: string; targetBranchName: string; targetSectionHeading: string; content: string }) => Promise<void>
  classifyForPmGaps: (params: { agentResponse: string; approvedProductSpec?: string }) => Promise<{ gaps: string[]; architectItems: string[]; designItems: string[] }>
  classifyForArchGap: (question: string) => Promise<string>
  preseedEngineeringSpec: (params: { featureName: string; filePath: string; architectItems: string[] }) => Promise<void>
  setPendingEscalation: (key: FeatureKey, escalation: { targetAgent: "pm" | "architect" | "design"; question: string; designContext: string; productSpec?: string }) => void
  generateDesignPreview: (params: { specContent: string; featureName: string; brandContent?: string }) => Promise<{ html: string; warnings: string[] }>
  saveDraftHtmlPreview: (params: { featureName: string; filePath: string; content: string }) => Promise<void>
  filterDesignContent: (html: string) => Promise<string>
  buildDesignRubric: (targetFormFactors: string[]) => string
  uploadFileToSlack: SlackFileUploader
  readFile: FileReader
}

/** Mutable state passed by reference so the caller can read mutations. */
export type DesignToolState = {
  patchAppliedThisTurn: boolean
  lastGeneratedPreviewHtml: string | null
}

/** Additional design-specific context beyond ToolHandlerContext. */
export type DesignToolCtx = ToolHandlerContext & {
  /** Product spec content for audit cross-reference. */
  auditProductSpec?: string
  /** Brand content from BRAND.md. */
  brand?: string
  /** Target form factors from WorkspaceConfig. */
  targetFormFactors?: string[]
  /** Slack channel for file uploads. */
  channelId: string
  /** Thread timestamp for file uploads. */
  threadTs: string
  /** Whether fix-all mode is active. */
  isFixAll: boolean
}

export async function handleDesignTool(
  name: string,
  input: Record<string, unknown>,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
  state: DesignToolState,
): Promise<ToolResult> {
  // During fix-all passes, block escalation tool calls
  if (ctx.isFixAll && (name === "offer_pm_escalation" || name === "offer_architect_escalation")) {
    console.log(`[FIX-ALL] Blocked ${name} during fix-all — deferring to post-loop action menu`)
    return { result: `[Fix-all mode] Escalation is suspended during fix-all passes. Apply all spec patches first. Any PM or architect gaps will be surfaced in the structured action menu after fix-all completes — do not escalate during this pass.` }
  }
  if (name === "save_design_spec_draft") {
    return handleSaveDesignDraft(input, ctx, deps, state)
  }
  if (name === "apply_design_spec_patch") {
    return handleApplyDesignSpecPatch(input, ctx, deps, state)
  }
  if (name === "rewrite_design_spec") {
    return handleRewriteDesignSpec(input, ctx, deps, state)
  }
  if (name === "generate_design_preview") {
    return handleGenerateDesignPreview(ctx, deps)
  }
  if (name === "offer_pm_escalation") {
    return handleOfferPmEscalation(input, ctx, deps)
  }
  if (name === "offer_architect_escalation") {
    return handleOfferArchitectEscalation(input, ctx, deps)
  }
  if (name === "fetch_url") {
    return handleFetchUrl(input, deps)
  }
  if (name === "run_phase_completion_audit") {
    return handleDesignPhaseCompletionAudit(ctx, deps)
  }
  if (name === "finalize_design_spec") {
    return handleFinalizeDesignSpec(ctx, deps)
  }
  return { error: `Unknown tool: ${name}` }
}

// ── Shared save logic ──────────────────────────────────────────────────────────

async function saveDesignDraftInternal(
  content: string,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
  state: DesignToolState,
  { skipSlackUpload = false }: { skipSlackUpload?: boolean } = {},
): Promise<ToolResult> {
  await ctx.update("_Auditing draft against product vision and architecture..._")
  const audit = await deps.auditSpecDraft({
    draft: content,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    productSpec: ctx.auditProductSpec,
    featureName: ctx.featureName,
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — draft not saved: ${audit.message}` }
  }

  // Health gate — block save if structural findings increased
  const preSaveSpec = await ctx.readFile(ctx.specFilePath, ctx.specBranchName).catch(() => null)
  const preSaveStructural = preSaveSpec ? deps.auditSpecStructure(preSaveSpec, "design").length : 0
  const postSaveStructural = deps.auditSpecStructure(content, "design").length
  if (postSaveStructural > preSaveStructural) {
    console.log(`[HEALTH-GATE] save blocked: structural findings increased ${preSaveStructural} → ${postSaveStructural}`)
    return { error: `Save blocked — structural issues increased from ${preSaveStructural} to ${postSaveStructural}. The patch introduced new conflicts rather than resolving them.` }
  }

  await ctx.update("_Saving draft to GitHub..._")
  await deps.saveDraftDesignSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content })

  // Generate HTML preview
  await ctx.update("_Generating HTML preview..._")
  const { paths: dp, githubOwner: dOwner, githubRepo: dRepo } = ctx.loadWorkspaceConfig()
  const designSpecUrl = `https://github.com/${dOwner}/${dRepo}/blob/${ctx.specBranchName}/${ctx.specFilePath}`
  const htmlFilePath = `${dp.featuresRoot}/${ctx.featureName}/${ctx.featureName}.preview.html`
  let previewUrl = "none"
  let renderWarnings: string[] = []
  const previewResult = await deps.generateDesignPreview({
    specContent: content,
    featureName: ctx.featureName,
    brandContent: ctx.brand,
  }).catch((e: Error) => e)
  if (!(previewResult instanceof Error)) {
    renderWarnings = previewResult.warnings
    state.lastGeneratedPreviewHtml = previewResult.html
    await deps.saveDraftHtmlPreview({ featureName: ctx.featureName, filePath: htmlFilePath, content: previewResult.html }).catch(() => {})
    if (!skipSlackUpload) {
      try {
        await deps.uploadFileToSlack({
          channelId: ctx.channelId,
          threadTs: ctx.threadTs,
          content: previewResult.html,
          filename: `${ctx.featureName}.preview.html`,
          title: `${ctx.featureName} — Design Preview`,
        })
        previewUrl = "uploaded_to_slack"
      } catch (uploadErr: any) {
        console.error(`[preview] Slack upload failed: ${uploadErr?.message}`)
        previewUrl = "saved_to_github"
      }
    } else {
      previewUrl = "saved_to_github"
    }
  } else {
    console.error(`[preview] HTML generation failed: ${previewResult.message}`)
  }

  const brandDrifts = ctx.brand ? deps.auditBrandTokens(content, ctx.brand) : []
  const specGap = audit.status === "gap" ? audit.message : null
  return { result: { specUrl: designSpecUrl, previewUrl, brandDrifts, specGap, renderWarnings: renderWarnings.length > 0 ? renderWarnings : undefined } }
}

// ── Individual tool handlers ────────────────────────────────────────────────────

export async function handleSaveDesignDraft(
  input: Record<string, unknown>,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
  state: DesignToolState,
): Promise<ToolResult> {
  return saveDesignDraftInternal(input.content as string, ctx, deps, state)
}

export async function handleApplyDesignSpecPatch(
  input: Record<string, unknown>,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
  state: DesignToolState,
): Promise<ToolResult> {
  const patch = input.patch as string
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  const mergedDraft = deps.applySpecPatch(existingDraft ?? "", patch)
  state.patchAppliedThisTurn = true
  return saveDesignDraftInternal(mergedDraft, ctx, deps, state, { skipSlackUpload: true })
}

export async function handleRewriteDesignSpec(
  input: Record<string, unknown>,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
  state: DesignToolState,
): Promise<ToolResult> {
  state.patchAppliedThisTurn = true
  return saveDesignDraftInternal(input.content as string, ctx, deps, state, { skipSlackUpload: true })
}

export async function handleGenerateDesignPreview(
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
): Promise<ToolResult> {
  const { paths: gp } = ctx.loadWorkspaceConfig()
  const htmlFilePath = `${gp.featuresRoot}/${ctx.featureName}/${ctx.featureName}.preview.html`
  try {
    await ctx.update("_Fetching preview..._")
    const cachedHtml = await ctx.readFile(htmlFilePath, ctx.specBranchName)
    if (cachedHtml) {
      await deps.uploadFileToSlack({
        channelId: ctx.channelId,
        threadTs: ctx.threadTs,
        content: cachedHtml,
        filename: `${ctx.featureName}.preview.html`,
        title: `${ctx.featureName} — Design Preview`,
      })
      return { result: { previewUrl: "uploaded_to_slack" } }
    }
    await ctx.update("_Generating preview..._")
    const previewResult = await deps.generateDesignPreview({ specContent: ctx.context.currentDraft ?? "", featureName: ctx.featureName, brandContent: ctx.brand })
    await deps.saveDraftHtmlPreview({ featureName: ctx.featureName, filePath: htmlFilePath, content: previewResult.html }).catch(() => {})
    await deps.uploadFileToSlack({
      channelId: ctx.channelId,
      threadTs: ctx.threadTs,
      content: previewResult.html,
      filename: `${ctx.featureName}.preview.html`,
      title: `${ctx.featureName} — Design Preview`,
    })
    return { result: { previewUrl: "uploaded_to_slack", renderWarnings: previewResult.warnings.length > 0 ? previewResult.warnings : undefined } }
  } catch (err: any) {
    return { error: `Preview failed: ${err?.message}` }
  }
}

export async function handleOfferPmEscalation(
  input: Record<string, unknown>,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
): Promise<ToolResult> {
  console.log(`[ESCALATION] offer_pm_escalation tool called for ${ctx.featureName}`)
  console.log(`[ESCALATION] tool question param:\n${input.question}`)
  const rawQuestion = input.question as string
  const classification = await deps.classifyForPmGaps({
    agentResponse: rawQuestion,
    approvedProductSpec: ctx.context.approvedProductSpec ?? undefined,
  })
  if (classification.gaps.length === 0) {
    console.log(`[ESCALATION] Gate 2 classifier: 0 PM gaps — rejecting offer_pm_escalation, redirecting agent`)
    if (classification.architectItems.length > 0) {
      const { paths } = ctx.loadWorkspaceConfig()
      const archFilePath = `${paths.featuresRoot}/${ctx.featureName}/${ctx.featureName}.engineering.md`
      await deps.preseedEngineeringSpec({ featureName: ctx.featureName, filePath: archFilePath, architectItems: classification.architectItems })
        .catch(err => console.log(`[GATE2] preseedEngineeringSpec failed (non-blocking): ${err}`))
    }
    if (classification.designItems.length > 0) {
      const designItemList = classification.designItems.map((d, i) => `${i + 1}. ${d}`).join("\n")
      console.log(`[ESCALATION] Gate 2: ${classification.designItems.length} design-scope item(s) returned to agent for self-resolution`)
      return {
        result: `REJECTED: No PM-scope gaps found. The following items are visual/UX design decisions you own independently — resolve them yourself without escalating:\n\n${designItemList}\n\nFor architecture questions (schema, data model, technical mechanism), call offer_architect_escalation instead.`,
      }
    }
    return {
      result: "REJECTED: No PM-scope gaps found in your question. These appear to be design, brand, or architecture concerns. Resolve brand token conflicts directly from BRAND.md (it is the authoritative source). For architecture questions, call offer_architect_escalation instead. Do not escalate to PM for hex values, animation durations, or implementation decisions.",
    }
  }
  const filteredQuestion = classification.gaps.length === 1
    ? classification.gaps[0]
    : classification.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")
  if (classification.gaps.length < rawQuestion.split(/\d+\.\s/).filter(Boolean).length) {
    console.log(`[ESCALATION] Gate 2 classifier filtered ${rawQuestion.split(/\d+\.\s/).filter(Boolean).length - classification.gaps.length} non-PM items from tool question`)
  }
  deps.setPendingEscalation(featureKey(ctx.featureName), {
    targetAgent: "pm",
    question: filteredQuestion,
    designContext: ctx.context.currentDraft ?? "",
    productSpec: ctx.context.approvedProductSpec ?? undefined,
  })
  if (classification.architectItems.length > 0) {
    const { paths } = ctx.loadWorkspaceConfig()
    const archFilePath = `${paths.featuresRoot}/${ctx.featureName}/${ctx.featureName}.engineering.md`
    deps.preseedEngineeringSpec({ featureName: ctx.featureName, filePath: archFilePath, architectItems: classification.architectItems })
      .catch(err => console.log(`[GATE2] preseedEngineeringSpec failed (non-blocking): ${err}`))
  }
  return {
    result: "Escalation offer stored. The user will be prompted to confirm. If they say yes, the PM will be notified with your question.",
  }
}

export async function handleOfferArchitectEscalation(
  input: Record<string, unknown>,
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
): Promise<ToolResult> {
  const archQuestion = input.question as string
  const archGapClass = await deps.classifyForArchGap(archQuestion)
  if (archGapClass === "DESIGN-ASSUMPTION") {
    return {
      result: `[PLATFORM REJECTION] This question is an implementation detail — the UI design does not depend on the answer. Do NOT escalate this to the architect.\n\nInstead:\n1. Decide the user-visible behavior (e.g. "conversation is preserved when the user signs in").\n2. Add an entry to the ## Design Assumptions section documenting what the architect will need to confirm.\n3. Continue designing — the architect resolves this during engineering, not before.\n\nExample Design Assumption entry: "- Conversation data is preserved on sign-in via server-side or client-side storage (implementation TBD by architect)."`,
    }
  }
  deps.setPendingEscalation(featureKey(ctx.featureName), {
    targetAgent: "architect",
    question: archQuestion,
    designContext: ctx.context.currentDraft ?? "",
  })
  return {
    result: "Escalation offer stored. The user will be prompted to confirm. If they say yes, the Architect will be notified with your question.",
  }
}

export async function handleFetchUrl(
  input: Record<string, unknown>,
  deps: DesignToolDeps,
): Promise<ToolResult> {
  const url = input.url as string
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` }
    const text = await res.text()
    const content = await deps.filterDesignContent(text)
    return { result: { content } }
  } catch (err: any) {
    return { error: `Fetch failed: ${err?.message}` }
  }
}

export async function handleDesignPhaseCompletionAudit(
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
): Promise<ToolResult> {
  await ctx.update("_Running phase completion audit..._")
  const draft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  if (!draft) {
    return { result: { ready: false, findings: [{ issue: "No design spec draft found", recommendation: "Save a draft first using save_design_spec_draft before running the audit." }] } }
  }
  const result = await deps.auditPhaseCompletion({
    specContent: draft,
    rubric: deps.buildDesignRubric(ctx.targetFormFactors ?? []),
    featureName: ctx.featureName,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    approvedProductSpec: ctx.context.approvedProductSpec,
  })
  return { result }
}

export async function handleFinalizeDesignSpec(
  ctx: DesignToolCtx,
  deps: DesignToolDeps,
): Promise<ToolResult> {
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  if (!existingDraft) {
    return { error: "No draft saved yet — save a draft first before finalizing." }
  }

  // Gate: Upstream PM spec deterministic audit (Principle 14 — retroactive enforcement)
  // DESIGN-REVIEWED: Design finalization logs PM spec findings as a WARNING — the PM must fix
  // them but design can proceed. The HARD gate is at engineering finalization where the full
  // spec chain must be clean. This avoids blocking design when PM hasn't caught up yet.
  if (ctx.auditProductSpec) {
    const { auditPmSpec } = await import("./deterministic-auditor")
    const pmFindings = auditPmSpec(ctx.auditProductSpec)
    if (!pmFindings.ready) {
      console.log(`[FINALIZE-GATE] design: WARNING — PM spec has ${pmFindings.findings.length} deterministic finding(s) — must be fixed before engineering finalization`)
    }
  }

  const allOpenQuestions = deps.extractAllOpenQuestions(existingDraft)
  if (allOpenQuestions.length > 0) {
    return { error: `Approval blocked — ${allOpenQuestions.length} open question${allOpenQuestions.length > 1 ? "s" : ""} must be resolved first (blocking and non-blocking questions both block finalization):\n${allOpenQuestions.map(q => `• ${q}`).join("\n")}` }
  }
  const finalStructural = deps.auditSpecStructure(existingDraft, "design")
  if (finalStructural.length > 0) {
    const structLines = finalStructural.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
    return { error: `Finalization blocked — ${finalStructural.length} structural conflict${finalStructural.length === 1 ? "" : "s"} must be resolved first:\n${structLines}` }
  }

  let finalContent = existingDraft
  const [decisionAudit, architectReadiness] = await Promise.all([
    deps.auditSpecDecisions({ specContent: existingDraft, history: ctx.getHistory() }),
    deps.auditDownstreamReadiness({ specContent: existingDraft, downstreamRole: "architect", featureName: ctx.featureName }),
  ])
  if (decisionAudit.status === "corrections") {
    const { corrected } = deps.applyDecisionCorrections(existingDraft, decisionAudit.corrections!)
    finalContent = corrected
  }
  if (architectReadiness.findings.length > 0) {
    const findingLines = architectReadiness.findings.map((f, i) => `${i + 1}. ${f.issue} — ${f.recommendation}`).join("\n")
    return { error: `Approval blocked — spec is not architect-ready. An architect receiving this spec would need to invent the following answers:\n${findingLines}\n\nResolve each before finalizing.` }
  }
  // Brand token drift hard gate
  if (ctx.brand) {
    const finalBrandDrifts = deps.auditBrandTokens(finalContent, ctx.brand)
    const finalAnimDrifts = deps.auditAnimationTokens(finalContent, ctx.brand)
    const totalDrifts = finalBrandDrifts.length + finalAnimDrifts.length
    if (totalDrifts > 0) {
      const driftLines = [
        ...finalBrandDrifts.map(d => `• ${d.token}: spec has ${d.specValue} but BRAND.md requires ${d.brandValue}`),
        ...finalAnimDrifts.map(d => `• ${d.param}: spec has ${d.specValue} but BRAND.md requires ${d.brandValue}`),
      ].join("\n")
      return { error: `Finalization blocked — ${totalDrifts} brand token drift${totalDrifts === 1 ? "" : "s"} detected. Patch the spec to align with BRAND.md before finalizing:\n${driftLines}` }
    }
  }
  await ctx.update("_Saving final design spec..._")
  await deps.saveApprovedDesignSpec({ featureName: ctx.featureName, filePath: ctx.specFilePath, content: finalContent })
  // Seed ## Design Assumptions to engineering spec branch (non-blocking)
  const assumptionsContent = deps.extractDesignAssumptions(finalContent)
  if (assumptionsContent.trim()) {
    const { paths } = ctx.loadWorkspaceConfig()
    const engSpecFilePath = `${paths.featuresRoot}/${ctx.featureName}/${ctx.featureName}.engineering.md`
    deps.seedHandoffSection({
      featureName: ctx.featureName,
      targetFilePath: engSpecFilePath,
      targetBranchName: `spec/${ctx.featureName}-engineering`,
      targetSectionHeading: "## Design Assumptions To Validate",
      content: assumptionsContent,
    }).catch(err => console.log(`[DESIGN-FINALIZE] seedHandoffSection failed (non-blocking): ${err}`))
  }
  const { githubOwner, githubRepo } = ctx.loadWorkspaceConfig()
  const url = `https://github.com/${githubOwner}/${githubRepo}/blob/main/${ctx.specFilePath}`
  return { result: { url, nextPhase: "engineering" } }
}
