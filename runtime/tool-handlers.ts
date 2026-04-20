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

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

export type ToolResult = { result?: unknown; error?: string }

/** Adapter for reading files from the target repo. */
export type FileReader = (path: string, branch: string) => Promise<string | null>

/** Adapter for saving draft specs to GitHub. */
export type DraftSaver = (params: { featureName: string; filePath: string; content: string }) => Promise<void>

/** Adapter for saving approved specs to main. */
export type ApprovedSaver = (params: { featureName: string; filePath: string; content: string }) => Promise<void>

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
  auditDownstreamReadiness: (params: { specContent: string; downstreamRole: string; featureName: string }) => Promise<{ findings: Array<{ issue: string; recommendation: string }> }>
  auditSpecDecisions: (params: { specContent: string; history: Message[] }) => Promise<{ status: string; corrections?: Array<{ original: string; corrected: string }> }>
  applyDecisionCorrections: (content: string, corrections: Array<{ original: string; corrected: string }>) => { corrected: string }
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
  auditSpecStructure: (content: string, specType: string) => Array<{ issue: string; recommendation: string }>
  clearHandoffSection: (params: { featureName: string; filePath: string; sectionHeading: string }) => Promise<void>
  setPendingEscalation: (featureName: string, escalation: { targetAgent: string; question: string; designContext: string; engineeringContext?: string }) => void
  readFile: FileReader
}

export async function handleArchitectTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
): Promise<ToolResult> {
  if (name === "save_engineering_spec_draft") {
    return handleSaveEngineeringSpecDraft(input, ctx, deps)
  }
  if (name === "apply_engineering_spec_patch") {
    return handleApplyEngineeringSpecPatch(input, ctx, deps)
  }
  if (name === "read_approved_specs") {
    return handleReadApprovedSpecs(input, ctx, deps)
  }
  if (name === "finalize_engineering_spec") {
    return handleFinalizeEngineeringSpec(ctx, deps)
  }
  if (name === "offer_upstream_revision") {
    return handleOfferUpstreamRevision(input, ctx, deps)
  }
  return { error: `Unknown tool: ${name}` }
}

export async function handleSaveEngineeringSpecDraft(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
  deps: ArchitectToolDeps,
): Promise<ToolResult> {
  const content = input.content as string
  await ctx.update("_Auditing spec against product vision and architecture..._")
  const audit = await deps.auditSpecDraft({
    draft: content,
    productVision: ctx.context.productVision,
    systemArchitecture: ctx.context.systemArchitecture,
    featureName: ctx.featureName,
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — spec not saved: ${audit.message}` }
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
  })
  if (audit.status === "conflict") {
    return { error: `Conflict detected — patch not saved: ${audit.message}` }
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
): Promise<ToolResult> {
  const existingDraft = await ctx.readFile(ctx.specFilePath, ctx.specBranchName)
  if (!existingDraft) {
    return { error: "No draft saved yet — save a draft first before finalizing." }
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
  deps.setPendingEscalation(ctx.featureName, {
    targetAgent: target,
    question,
    designContext: "",
    engineeringContext: ctx.context.currentDraft ?? undefined,
  })
  return {
    result: `Upstream revision request stored (target: ${target}). The user will be prompted to confirm. If they say yes, the ${target === "design" ? "Designer" : "PM"} will be notified with your constraint.`,
  }
}
