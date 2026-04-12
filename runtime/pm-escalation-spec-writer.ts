// Writes confirmed PM/Architect recommendations back to the approved product spec on main.
// Called after the human confirms escalation recommendations so the spec auditor doesn't
// re-discover the same gaps on the next design run.

import Anthropic from "@anthropic-ai/sdk"
import { applySpecPatch } from "./spec-patcher"
import { readFile, saveApprovedSpec } from "./github-client"
import { loadWorkspaceConfig } from "./workspace-config"

// 60s timeout — spec patch generation is a focused Haiku call; no retries.
const client = new Anthropic({ maxRetries: 0, timeout: 60_000 })

export async function patchProductSpecWithRecommendations(params: {
  featureName: string
  question: string          // original blocking questions escalated to PM/Architect
  recommendations: string  // PM/Architect agent response text (confirmed by human)
  humanConfirmation: string // what the human said when confirming
}): Promise<void> {
  const { featureName, question, recommendations, humanConfirmation } = params
  const { paths } = loadWorkspaceConfig()
  const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`

  const existingSpec = await readFile(productSpecPath, "main")
  if (!existingSpec) {
    console.log(`[ESCALATION] product spec writeback: spec not found on main for feature=${featureName}, skipping`)
    return
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You are a product spec editor. Given a set of blocking questions that were escalated to the PM and the PM's confirmed recommendations, output a targeted patch to add the confirmed decisions to the product spec.

Output ONLY the patched sections in markdown format (## Section heading followed by the full updated section body). Do not output sections that did not change. Do not output the entire spec — only changed sections.

Each confirmed recommendation must appear as a concrete, measurable entry (not vague language) in the appropriate section:
- Product decisions (UX behavior, user flows, error states) → ## Acceptance Criteria
- Edge cases and failure modes → ## Edge Cases

Do not add a preamble, explanation, or any text outside the ## sections.`,
    messages: [{
      role: "user",
      content: `EXISTING SPEC:\n${existingSpec}\n\nBLOCKING QUESTIONS:\n${question}\n\nPM RECOMMENDATIONS:\n${recommendations}\n\nHUMAN CONFIRMATION: "${humanConfirmation}"\n\nOutput the updated spec sections that encode these confirmed decisions as concrete acceptance criteria and edge cases.`,
    }],
  })

  const patch = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  if (!patch || !patch.includes("##")) {
    console.log(`[ESCALATION] product spec writeback: Haiku returned no valid patch for feature=${featureName}, skipping`)
    return
  }

  const mergedSpec = applySpecPatch(existingSpec, patch)
  await saveApprovedSpec({ featureName, filePath: productSpecPath, content: mergedSpec })
  console.log(`[ESCALATION] product spec writeback: patched ${productSpecPath} on main with confirmed PM recommendations`)
}
