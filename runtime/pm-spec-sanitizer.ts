// Sanitizes PM product spec drafts before saving to GitHub.
// Removes two classes of content that should never appear in a PM spec:
//
// 1. Design-scope sections — entire ## sections whose headings indicate visual/design
//    content (## Design Direction, ## Color Palette, ## Animation, etc.). These belong
//    in the design spec. The PM spec encodes WHAT the user experiences, not HOW it looks.
//
// 2. Cross-domain open questions — lines in ## Open Questions that are [type: engineering]
//    or [type: design]. PM spec ## Open Questions must contain only [type: product] items.
//    Engineering questions belong in the engineering spec; design questions the designer resolves.
//
// Called at both save_product_spec_draft and apply_product_spec_patch tool handlers,
// before saveDraftSpec writes to GitHub.

// Section headings that signal design-scope content in a PM spec.
// Uses prefix matching (case-insensitive) — covers plurals and variations.
const DESIGN_SCOPE_HEADING_PREFIXES = [
  "design direction",
  "design language",
  "design system",
  "color palette",
  "colors",
  "colour",
  "animation",
  "visual design",
  "visual language",
  "visual treatment",
  "visual",
  "typography",
  "layout",
  "ui design",
  "ui components",
  "branding",
  "brand tokens",
  "component",
  "iconography",
  "spacing",
]

function isDesignScopeHeading(line: string): boolean {
  const match = line.match(/^#{1,3}\s+(.+)$/)
  if (!match) return false
  const heading = match[1].toLowerCase().trim()
  return DESIGN_SCOPE_HEADING_PREFIXES.some(prefix => heading.startsWith(prefix))
}

// Strips entire design-scope sections from spec content.
// A section runs from its ## heading to (but not including) the next ## heading or EOF.
function stripDesignScopeSections(content: string): { result: string; stripped: string[] } {
  const lines = content.split("\n")
  const stripped: string[] = []
  const kept: string[] = []
  let inDesignSection = false

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      // New section heading — decide whether to enter or leave design-scope mode
      inDesignSection = isDesignScopeHeading(line)
      if (inDesignSection) {
        stripped.push(line.match(/^#{1,3}\s+(.+)$/)![1])
        continue
      }
    }
    if (inDesignSection) continue
    kept.push(line)
  }

  // Collapse multiple consecutive blank lines left by section removal
  const collapsed = kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()
  return { result: collapsed, stripped }
}

// Strips cross-domain lines from ## Open Questions.
// PM spec open questions must be [type: product] only.
// Lines with [type: engineering] or [type: design] are removed.
function stripCrossDomainOpenQuestions(content: string): { result: string; stripped: string[] } {
  const stripped: string[] = []
  const result = content.replace(/^.*\[type:\s*(engineering|design)\].*$/gim, (match) => {
    stripped.push(match.trim())
    return ""
  })
  // Collapse blank lines inside ## Open Questions left by removal
  const cleaned = result.replace(/\n{3,}/g, "\n\n")
  return { result: cleaned, stripped }
}

export interface SanitizeResult {
  content: string
  wasModified: boolean
  strippedSections: string[]         // design-scope section headings removed
  strippedOpenQuestions: string[]    // cross-domain open question lines removed
}

export function sanitizePmSpecDraft(content: string): SanitizeResult {
  const { result: afterSections, stripped: strippedSections } = stripDesignScopeSections(content)
  const { result: afterQuestions, stripped: strippedOpenQuestions } = stripCrossDomainOpenQuestions(afterSections)

  const wasModified = strippedSections.length > 0 || strippedOpenQuestions.length > 0

  if (strippedSections.length > 0) {
    console.log(`[PM-SANITIZER] stripped ${strippedSections.length} design-scope section(s): ${strippedSections.join(", ")}`)
  }
  if (strippedOpenQuestions.length > 0) {
    console.log(`[PM-SANITIZER] stripped ${strippedOpenQuestions.length} cross-domain open question(s) from ## Open Questions`)
  }

  return {
    content: afterQuestions,
    wasModified,
    strippedSections,
    strippedOpenQuestions,
  }
}
