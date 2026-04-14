// Writes confirmed PM/Architect recommendations back to the approved product spec on main.
// Called after the human confirms escalation recommendations so the spec auditor doesn't
// re-discover the same gaps on the next design run.

import Anthropic from "@anthropic-ai/sdk"
import { applySpecPatch } from "./spec-patcher"
import { readFile, saveApprovedSpec } from "./github-client"
import { loadWorkspaceConfig } from "./workspace-config"

// 60s timeout — spec patch generation is a focused Haiku call; no retries.
const client = new Anthropic({ maxRetries: 0, timeout: 60_000 })

// Visual detail patterns that should never appear in a PM product spec.
// PM spec encodes WHAT the user experiences — not animation values, colors, or gradients.
// These are structural signals: if any criterion in the spec contains these, it has leaked
// design/implementation detail that Haiku was supposed to strip but didn't.
const VISUAL_DETAIL_PATTERNS = [
  /\b\d+\.?\d*\s*%.*opacit/i,          // opacity percentages: "25% opacity", "opacity 50%"
  /opacit.*\d+\.?\d*\s*%/i,            // opacity percentages reversed
  /\b\d+\.?\d*\s*(ms|milliseconds?)\b/i, // animation timing in ms
  /\b\d+\.?\d*\s*s(?:econds?)?\s+(?:over|duration|cycle|loop)/i, // "2.5 seconds over", "4 second cycle"
  /(?:over|duration|cycle|loop)\s+\d+\.?\d*\s*s/i, // "over 2.5s"
  /#[0-9a-fA-F]{3,6}\b/,               // hex color values
  /rgba?\s*\(/i,                        // rgba/rgb color functions
  /radial.{0,20}gradient|gradient.{0,20}radial/i, // radial gradient specifics
  /\bglow\s+(?:radius|size|spread|color)\b/i,  // glow implementation details
  /easing\s+function|cubic.bezier/i,   // animation easing details
]

// Fast structural check: does this spec content contain visual/animation details
// that should never appear in a PM product spec?
function hasVisualDetails(specContent: string): boolean {
  // Only scan criteria lines (lines starting with - or digits in ## sections)
  const criteriaLines = specContent
    .split("\n")
    .filter(l => /^\s*[-\d]/.test(l))
  return criteriaLines.some(line => VISUAL_DETAIL_PATTERNS.some(p => p.test(line)))
}

// Second-pass Haiku call: strip visual/animation/technical details from a spec
// that already has them. Called only when hasVisualDetails() fires — not on every patch.
async function stripVisualDetailsFromSpec(specContent: string): Promise<string> {
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: `You are a product spec cleaner. Remove all visual, animation, and technical implementation details from acceptance criteria and edge cases. The PM spec describes WHAT the user experiences — not HOW it looks or is implemented.

Remove from every criterion:
- Specific opacity percentages (e.g. "25% → 35% opacity", "50–100% opacity")
- Animation durations (e.g. "2.5 seconds", "4s cycle", "300ms")
- Color values (hex, rgba, color names)
- Gradient specifics (radial vs linear, direction, stops)
- Glow implementation details (radius, spread, combined vs separate)
- Easing functions (cubic-bezier, ease-in-out)
- Pixel measurements

Replace with the behavior the criterion is describing, without the visual specifics. If a criterion is ONLY a visual implementation detail with no underlying user behavior, remove it entirely.

Output the full spec with all sections preserved. No preamble, no explanation — output only the cleaned spec content.`,
    messages: [{ role: "user", content: specContent }],
  })
  const cleaned = response.content[0].type === "text" ? response.content[0].text.trim() : specContent
  return cleaned || specContent
}

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
    max_tokens: 4096,
    system: `You are a product spec editor. Given an approved product spec and PM recommendations that resolve blocking gaps, output a targeted patch to make the spec concrete and actionable.

RULES — follow exactly:

1. REPLACE vague criteria, never keep them alongside concrete versions.
   For each PM recommendation, find the acceptance criterion it addresses. If that criterion contains vague language — including words like "soft", "non-intrusive", "ambient", "proactively", "seamlessly", "minimal", "appropriate", "subtle", "smooth", "fast", "easy", "good", "improve", or any other unmeasurable adjective — REPLACE the entire criterion with a concrete, measurable version that reflects the PM's confirmed decision. Remove the vague version entirely. Do not output both the old vague criterion and the new concrete one.

2. KEEP all existing acceptance criteria that are not being replaced.
   The output section must contain every existing criterion from that section — only the vague ones get replaced; non-vague ones are carried forward unchanged.

3. STRIP visual details, technical details, and UI copy from PM recommendations before writing to spec.
   The spec encodes WHAT the user experiences — not HOW it looks, HOW it is implemented, or WHAT IT SAYS. Strip:
   - Specific colors (hex values, rgba, color names)
   - UI component choices (badge, chip, button, label — unless the PM explicitly owns this as a product requirement)
   - Exact pixel positions or margins
   - Timing values in milliseconds unless they define a product-level SLA
   - Exact UI copy and wording — the PM defines intent ("an inline error the user can dismiss"), the designer writes the actual words. NEVER write specific strings like "The AI is currently unavailable. Please try again in a moment." in the spec.
   Example: "A persistent non-dismissible error indicator appears at the top of the chat" belongs in the spec. "rgba(245, 245, 245, 0.6) badge in the top-right corner saying 'The AI is currently unavailable.'" does not.

4. ADD new concrete criteria for gaps not already in the spec.
   If a PM recommendation addresses a gap with no existing criterion, add it as a new numbered criterion in the appropriate section.

5. Route to the correct sections:
   - Product decisions (UX behavior, what the user experiences, when things fire) → ## Acceptance Criteria
   - Error experiences and failure modes → ## Edge Cases

6. RESOLVE contradictions — never let two criteria say opposite things.
   If two PM recommendations in this writeback conflict with each other, OR if a PM recommendation conflicts with an existing spec criterion, resolve it: use the more specific, more restrictive recommendation. Remove the contradictory criterion or text entirely. Never output two criteria that contradict each other on the same topic. Example: if one recommendation says "the warning is dismissible" and another says "the warning is not dismissible", choose the more restrictive one ("not dismissible") and remove any criterion that says it is dismissible.

7. COMPLETE or remove incomplete criteria.
   If any criterion in the spec is incomplete (ends mid-sentence, is a placeholder, or contains "TBD" / "TODO" / "[incomplete]"), either complete it using the PM's confirmed recommendations or remove it. Never leave an incomplete criterion in the output.

8. HYGIENE PASS — scan the entire spec for any remaining vague language beyond what the current PM recommendations directly address.
   After applying rules 1–7, scan every criterion in ## Acceptance Criteria and ## Edge Cases for the vague words listed in Rule 1. If a criterion contains vague language AND the correct concrete meaning can be inferred from PM decisions already present in the spec (either from this writeback or from prior confirmed decisions visible in the existing spec), replace it. If the meaning cannot be inferred — the PM never addressed it — leave it unchanged for the next escalation. Do not invent decisions the PM has not made.

9. Output ONLY sections that changed, in full (complete section body — all criteria, not just changed ones). No preamble, no explanation, nothing outside ## sections.`,
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

  let mergedSpec = applySpecPatch(existingSpec, patch)

  // Structural post-patch audit: if the merged spec contains visual/animation details
  // that Haiku was supposed to strip (Rule 3) but didn't, run a second focused pass to
  // remove them before saving. This catches opacity values, animation durations, hex
  // colors, gradient specifics, etc. that should never appear in a PM product spec.
  if (hasVisualDetails(mergedSpec)) {
    console.log(`[ESCALATION] product spec writeback: visual details detected in patch for feature=${featureName} — running strip pass`)
    mergedSpec = await stripVisualDetailsFromSpec(mergedSpec)
    console.log(`[ESCALATION] product spec writeback: visual detail strip pass complete for feature=${featureName}`)
  }

  await saveApprovedSpec({ featureName, filePath: productSpecPath, content: mergedSpec })
  console.log(`[ESCALATION] product spec writeback: patched ${productSpecPath} on main with confirmed PM recommendations`)
  return mergedSpec
}
