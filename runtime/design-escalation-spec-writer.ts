// Writes confirmed Designer recommendations back to the approved design spec on main.
// Called after the human confirms architect→design escalation recommendations so the
// deterministic auditor doesn't re-discover the same gaps on the next architect run.
//
// Follows the same pattern as pm-escalation-spec-writer.ts but for design specs.
// No visual detail stripping — design specs SHOULD have visual specifics.

import Anthropic from "@anthropic-ai/sdk"
import { applySpecPatch } from "./spec-patcher"
import { readFile, updateApprovedSpecOnMain } from "./github-client"
import { loadWorkspaceConfig } from "./workspace-config"

const client = new Anthropic({ maxRetries: 0, timeout: 60_000 })

export async function patchDesignSpecWithRecommendations(params: {
  featureName: string
  question: string          // original blocking questions escalated to Designer
  recommendations: string   // Designer agent response text (confirmed by human)
  humanConfirmation: string  // what the human said when confirming
}): Promise<string | null> {
  const { featureName, question, recommendations, humanConfirmation } = params
  const { paths } = loadWorkspaceConfig()
  const designSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.design.md`

  const existingSpec = await readFile(designSpecPath, "main")
  if (!existingSpec) {
    console.log(`[ESCALATION] design spec writeback: spec not found on main for feature=${featureName}, skipping`)
    return null
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    system: `You are a design spec editor. Given an approved design spec and Designer recommendations that resolve blocking gaps identified by the Architect, output a targeted patch to make the spec complete.

RULES — follow exactly:

1. ADD missing layouts, states, and definitions that the Designer recommended.
   For form factor coverage gaps: add the layout sections the Designer specified.
   For vague language: replace with the Designer's concrete definitions.
   For missing animations: add the timing/easing the Designer specified.

2. KEEP all existing content that is not being changed.
   The output sections must contain everything from the existing section — only add or replace, never remove existing content unless the Designer explicitly said to.

3. PRESERVE visual specifics — this is a DESIGN spec, not a product spec.
   Colors, typography, spacing, animation timing, pixel values all belong here.
   Do not strip any visual details.

4. RESOLVE contradictions — if the Designer's recommendation conflicts with existing spec content, use the Designer's version (it was confirmed by the human).

5. Output ONLY sections that changed, in full (complete section body). No preamble, no explanation, nothing outside ## or ### sections.`,
    messages: [{
      role: "user",
      content: `EXISTING DESIGN SPEC:\n${existingSpec}\n\nBLOCKING QUESTIONS FROM ARCHITECT:\n${question}\n\nDESIGNER RECOMMENDATIONS:\n${recommendations}\n\nOutput the updated spec sections with the Designer's confirmed changes applied.`,
    }],
  })

  const patch = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  if (!patch || !patch.includes("#")) {
    console.log(`[ESCALATION] design spec writeback: Haiku returned no valid patch for feature=${featureName}, skipping`)
    return null
  }

  const mergedSpec = applySpecPatch(existingSpec, patch)

  await updateApprovedSpecOnMain({
    filePath: designSpecPath,
    content: mergedSpec,
    commitMessage: `[ESCALATION] ${featureName} · design.md — confirmed designer recommendations applied`,
  })
  console.log(`[ESCALATION] design spec writeback: patched ${designSpecPath} on main with confirmed Designer recommendations`)
  return mergedSpec
}
