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
}): Promise<string | null> {
  const { featureName, question, recommendations, humanConfirmation } = params
  const { paths } = loadWorkspaceConfig()
  const productSpecPath = `${paths.featuresRoot}/${featureName}/${featureName}.product.md`

  const existingSpec = await readFile(productSpecPath, "main")
  if (!existingSpec) {
    console.log(`[ESCALATION] product spec writeback: spec not found on main for feature=${featureName}, skipping`)
    return null
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: `You are a product spec editor. Given an approved product spec and PM recommendations that resolve blocking gaps, output a targeted patch to make the spec concrete and actionable.

RULES — follow exactly:

1. REPLACE vague criteria, never keep them alongside concrete versions.
   For each PM recommendation, find the acceptance criterion it addresses. If that criterion contains vague language — including words like "soft", "non-intrusive", "ambient", "proactively", "seamlessly", "minimal", "appropriate", "subtle", "smooth", "fast", "easy", "good", "improve", or any other unmeasurable adjective — REPLACE the entire criterion with a concrete, measurable version that reflects the PM's confirmed decision. Remove the vague version entirely. Do not output both the old vague criterion and the new concrete one.

2. KEEP all existing acceptance criteria that are not being replaced.
   The output section must contain every existing criterion from that section — only the vague ones get replaced; non-vague ones are carried forward unchanged.

3. STRIP visual and technical details from PM recommendations before writing to spec.
   The spec encodes WHAT the user experiences — not HOW it looks or HOW it is implemented. Strip: specific colors (hex values, rgba, color names), UI component choices (badge, chip, button, label — unless the PM explicitly owns this as a product requirement), exact pixel positions or margins, timing values in milliseconds unless they define a product-level SLA, and exact copy/wording unless it is the required user-facing string.
   Example: "A persistent non-dismissible indicator" belongs in the spec. "rgba(245, 245, 245, 0.6) badge in the top-right corner" does not.

4. ADD new concrete criteria for gaps not already in the spec.
   If a PM recommendation addresses a gap with no existing criterion, add it as a new numbered criterion in the appropriate section.

5. Route to the correct sections:
   - Product decisions (UX behavior, what the user experiences, when things fire) → ## Acceptance Criteria
   - Error experiences and failure modes → ## Edge Cases

6. HYGIENE PASS — scan the entire spec for any remaining vague language beyond what the current PM recommendations directly address.
   After applying rules 1–5, scan every criterion in ## Acceptance Criteria and ## Edge Cases for the vague words listed in Rule 1. If a criterion contains vague language AND the correct concrete meaning can be inferred from PM decisions already present in the spec (either from this writeback or from prior confirmed decisions visible in the existing spec), replace it. If the meaning cannot be inferred — the PM never addressed it — leave it unchanged for the next escalation. Do not invent decisions the PM has not made.

7. Output ONLY sections that changed, in full (complete section body — all criteria, not just changed ones). No preamble, no explanation, nothing outside ## sections.`,
    messages: [{
      role: "user",
      content: `EXISTING SPEC:\n${existingSpec}\n\nBLOCKING QUESTIONS:\n${question}\n\nPM RECOMMENDATIONS:\n${recommendations}\n\nOutput the updated spec sections with vague criteria replaced by concrete PM decisions, visual/technical details stripped, and any remaining vague language in the spec resolved where the PM's intent is already clear.`,
    }],
  })

  const patch = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  if (!patch || !patch.includes("##")) {
    console.log(`[ESCALATION] product spec writeback: Haiku returned no valid patch for feature=${featureName}, skipping`)
    return null
  }

  const mergedSpec = applySpecPatch(existingSpec, patch)
  await saveApprovedSpec({ featureName, filePath: productSpecPath, content: mergedSpec })
  console.log(`[ESCALATION] product spec writeback: patched ${productSpecPath} on main with confirmed PM recommendations`)
  return mergedSpec
}
