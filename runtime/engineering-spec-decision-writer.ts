// Writes confirmed architect decisions to the engineering spec draft.
// Called after the human confirms an architect escalation (offer_architect_escalation)
// so the decision is recorded in the engineering spec rather than the product spec.
//
// No Haiku — architect responses are already precise technical language.
// Raw append under ## Pre-Engineering Architectural Decisions.

import { readFile, saveDraftEngineeringSpec } from "./github-client"
import { loadWorkspaceConfig } from "./workspace-config"

export async function patchEngineeringSpecWithDecision(params: {
  featureName: string
  question: string   // original escalation question
  decision: string   // architect's response text (confirmed by human)
}): Promise<void> {
  const { featureName, question, decision } = params
  const { paths } = loadWorkspaceConfig()
  const archFilePath = `${paths.featuresRoot}/${featureName}/${featureName}.engineering.md`
  const archBranchName = `spec/${featureName}-engineering`

  const decisionBlock = `\n### Architect Decision (pre-engineering)\n**Question:** ${question}\n**Decision:** ${decision}\n`

  let existing: string | null = null
  try {
    existing = await readFile(archFilePath, archBranchName)
  } catch {
    // Branch or file doesn't exist yet — will create stub below
  }

  let merged: string
  const sectionHeading = "## Pre-Engineering Architectural Decisions"

  if (!existing) {
    // Create stub with the decisions section
    merged = `# ${featureName} Engineering Spec\n\n${sectionHeading}\n${decisionBlock}`
  } else if (existing.includes(sectionHeading)) {
    // Append the new decision block under the existing section
    merged = existing.replace(
      new RegExp(`(${sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n)([\\s\\S]*?)(?=\\n## |\\n*$)`),
      (_, heading, body) => `${heading}${body.trimEnd()}${decisionBlock}`,
    )
  } else {
    // Section doesn't exist — prepend it before the first ## heading or at end
    const firstHeadingIdx = existing.search(/\n## /)
    if (firstHeadingIdx !== -1) {
      merged = existing.slice(0, firstHeadingIdx) + `\n\n${sectionHeading}\n${decisionBlock}` + existing.slice(firstHeadingIdx)
    } else {
      merged = `${existing.trimEnd()}\n\n${sectionHeading}\n${decisionBlock}`
    }
  }

  try {
    await saveDraftEngineeringSpec({ featureName, filePath: archFilePath, content: merged })
    console.log(`[ENGINEERING-DECISION] patchEngineeringSpecWithDecision: decision written to ${archFilePath} on ${archBranchName}`)
  } catch (err) {
    console.log(`[ENGINEERING-DECISION] patchEngineeringSpecWithDecision: failed (non-blocking): ${err}`)
  }
}
