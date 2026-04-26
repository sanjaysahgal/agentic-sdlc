/**
 * Escalation Orchestrator — platform-controlled upstream spec validation.
 *
 * This module enforces the spec chain: downstream agents cannot write specs
 * until ALL upstream specs pass deterministic audits. When gaps are found,
 * the platform auto-escalates to the upstream agent with a categorized brief.
 *
 * The platform detects (structural). The agent recommends (domain expertise).
 * The human approves.
 *
 * @deterministic — all functions produce identical output on identical input.
 */

import { auditPmSpec, auditDesignSpec, DeterministicFinding, DeterministicAuditResult } from "./deterministic-auditor"

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

export type UpstreamReadinessResult = {
  ready: boolean
  /** Which upstream spec has findings (null if ready) */
  blockingSpec: "pm" | "design" | null
  /** Findings from the blocking spec */
  findings: DeterministicFinding[]
  /** Categorized brief ready to send to upstream agent (null if ready) */
  escalationBrief: string | null
}

export type FindingCategory = {
  criterion: string
  count: number
  /** Representative examples — all items if <5, first 3 if ≥5 */
  examples: string[]
  /** All items in this category (for re-audit verification) */
  allIssues: string[]
}

// ────────────────────────────────────────────────────────────────────────────────
// Group findings by criterion category
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Groups deterministic findings by their `criterion` field.
 * Returns categories sorted by count (largest first).
 */
export function groupFindingsByCategory(findings: DeterministicFinding[]): FindingCategory[] {
  const groups = new Map<string, DeterministicFinding[]>()

  for (const finding of findings) {
    const list = groups.get(finding.criterion) ?? []
    list.push(finding)
    groups.set(finding.criterion, list)
  }

  const categories: FindingCategory[] = []
  for (const [criterion, items] of groups) {
    const allIssues = items.map(f => f.issue)
    const examples = items.length >= 5
      ? items.slice(0, 3).map(f => f.issue)
      : items.map(f => f.issue)

    categories.push({ criterion, count: items.length, examples, allIssues })
  }

  // Sort by count descending — biggest categories first
  categories.sort((a, b) => b.count - a.count)
  return categories
}

// ────────────────────────────────────────────────────────────────────────────────
// Build categorized escalation brief
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Builds a structured escalation brief from categorized findings.
 * The upstream agent receives this and resolves at the category level.
 *
 * @param categories - Grouped findings from groupFindingsByCategory
 * @param targetAgent - Which agent will receive this brief ("pm" or "design")
 * @param requestingAgent - Which agent needs resolution ("ux-design" or "architect")
 */
export function buildCategorizedEscalationBrief(
  categories: FindingCategory[],
  targetAgent: "pm" | "design",
  requestingAgent: "ux-design" | "architect",
): string {
  const totalFindings = categories.reduce((sum, c) => sum + c.count, 0)
  const targetLabel = targetAgent === "pm" ? "Product Manager" : "UX Designer"
  const requestingLabel = requestingAgent === "ux-design" ? "Design" : "Engineering"
  const specLabel = targetAgent === "pm" ? "product spec" : "design spec"

  const header = `PLATFORM UPSTREAM AUDIT — ${targetLabel.toUpperCase()} RESOLUTION NEEDED

The ${specLabel} has ${totalFindings} deterministic finding${totalFindings === 1 ? "" : "s"} across ${categories.length} categor${categories.length === 1 ? "y" : "ies"} that must be resolved before ${requestingLabel.toLowerCase()} can proceed.

For each category, give your expert recommendation. Resolve at the category level where a single rule applies to all items (e.g. "all timing ACs use 200ms for UI transitions"). For items that need individual answers, address each one.

Output format for each category:
**[CATEGORY_NAME]** — My recommendation: [specific resolution]
→ Rationale: [one sentence]
`

  const categoryBlocks = categories.map((cat, i) => {
    const exampleList = cat.examples.map(e => `  - ${e}`).join("\n")
    const moreNote = cat.count > cat.examples.length
      ? `\n  _(${cat.count - cat.examples.length} more similar finding${cat.count - cat.examples.length === 1 ? "" : "s"})_`
      : ""

    return `${i + 1}. **${cat.criterion}** (${cat.count} finding${cat.count === 1 ? "" : "s"}):\n${exampleList}${moreNote}`
  }).join("\n\n")

  return `${header}\n${categoryBlocks}`
}

// ────────────────────────────────────────────────────────────────────────────────
// Check upstream readiness
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether all upstream specs pass deterministic audits.
 * For architect: PM-first ordering — only checks design if PM is clean.
 *
 * Returns ready=true if no findings. Returns the blocking spec, findings,
 * and a pre-built escalation brief if not ready.
 */
export function checkUpstreamReadiness(
  agent: "ux-design" | "architect",
  specs: { pmSpec?: string; designSpec?: string },
  targetFormFactors?: string[],
): UpstreamReadinessResult {
  // Design agent: check PM spec only
  if (agent === "ux-design") {
    if (!specs.pmSpec) {
      console.log(`[ESCALATION-ORCHESTRATOR] design: no PM spec available — skipping upstream check`)
      return { ready: true, blockingSpec: null, findings: [], escalationBrief: null }
    }

    const pmResult = auditPmSpec(specs.pmSpec)
    if (pmResult.ready) {
      console.log(`[ESCALATION-ORCHESTRATOR] design: PM spec clean — upstream ready`)
      return { ready: true, blockingSpec: null, findings: [], escalationBrief: null }
    }

    const categories = groupFindingsByCategory(pmResult.findings)
    const brief = buildCategorizedEscalationBrief(categories, "pm", "ux-design")
    console.log(`[ESCALATION-ORCHESTRATOR] design: PM spec has ${pmResult.findings.length} finding(s) across ${categories.length} categories — blocking`)
    return { ready: false, blockingSpec: "pm", findings: pmResult.findings, escalationBrief: brief }
  }

  // Architect agent: PM-first, then design
  if (specs.pmSpec) {
    const pmResult = auditPmSpec(specs.pmSpec)
    if (!pmResult.ready) {
      const categories = groupFindingsByCategory(pmResult.findings)
      const brief = buildCategorizedEscalationBrief(categories, "pm", "architect")
      console.log(`[ESCALATION-ORCHESTRATOR] architect: PM spec has ${pmResult.findings.length} finding(s) — blocking (PM-first)`)
      return { ready: false, blockingSpec: "pm", findings: pmResult.findings, escalationBrief: brief }
    }
    console.log(`[ESCALATION-ORCHESTRATOR] architect: PM spec clean`)
  }

  // PM clean — now check design
  if (specs.designSpec) {
    const designResult = auditDesignSpec(specs.designSpec, { targetFormFactors })
    if (!designResult.ready) {
      const categories = groupFindingsByCategory(designResult.findings)
      const brief = buildCategorizedEscalationBrief(categories, "design", "architect")
      console.log(`[ESCALATION-ORCHESTRATOR] architect: design spec has ${designResult.findings.length} finding(s) — blocking`)
      return { ready: false, blockingSpec: "design", findings: designResult.findings, escalationBrief: brief }
    }
    console.log(`[ESCALATION-ORCHESTRATOR] architect: design spec clean`)
  }

  console.log(`[ESCALATION-ORCHESTRATOR] architect: all upstream specs clean — ready`)
  return { ready: true, blockingSpec: null, findings: [], escalationBrief: null }
}

// ────────────────────────────────────────────────────────────────────────────────
// Verify escalation resolution
// ────────────────────────────────────────────────────────────────────────────────

/**
 * After upstream spec is patched, re-runs the deterministic audit.
 * Returns the remaining findings (if any) with a new brief.
 * If empty, the escalation is fully resolved.
 */
export function verifyEscalationResolution(
  blockingSpec: "pm" | "design",
  updatedSpec: string,
  requestingAgent: "ux-design" | "architect",
  targetFormFactors?: string[],
): UpstreamReadinessResult {
  const result = blockingSpec === "pm"
    ? auditPmSpec(updatedSpec)
    : auditDesignSpec(updatedSpec, { targetFormFactors })

  if (result.ready) {
    console.log(`[ESCALATION-ORCHESTRATOR] re-audit: ${blockingSpec} spec clean after patch — escalation resolved`)
    return { ready: true, blockingSpec: null, findings: [], escalationBrief: null }
  }

  const categories = groupFindingsByCategory(result.findings)
  const brief = buildCategorizedEscalationBrief(categories, blockingSpec, requestingAgent)
  console.log(`[ESCALATION-ORCHESTRATOR] re-audit: ${blockingSpec} spec still has ${result.findings.length} finding(s) — new escalation brief`)
  return { ready: false, blockingSpec, findings: result.findings, escalationBrief: brief }
}
