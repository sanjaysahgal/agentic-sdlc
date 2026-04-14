// Shared spec content utilities used across message handlers and tests.

// Extracts labeled text literals from a design spec for use as platform-confirmed grounding facts.
// Matches patterns like: Heading: "...", Tagline: "...", Header: "...", Description: "..."
// These are injected into the design agent's enriched user message so the agent references
// authoritative platform-extracted values rather than reconstructing spec content from memory.
export function extractSpecTextLiterals(specContent: string): Array<{ label: string; value: string }> {
  const results: Array<{ label: string; value: string }> = []
  const pattern = /^[-*\s]*\**(Heading|Tagline|Header|Description|placeholder)\**:\s*"([^"]{2,})"/gim
  for (const match of specContent.matchAll(pattern)) {
    results.push({ label: match[1], value: match[2].trim() })
  }
  return results
}

// Extracts all [blocking: yes] open questions from a spec.
// Used to gate approval — a spec with unresolved blocking questions cannot be saved.
export function extractBlockingQuestions(specContent: string): string[] {
  const lines = specContent.split("\n")
  return lines
    .filter(line => line.includes("[blocking: yes]"))
    .map(line => line.replace(/^[-*]\s*/, "").trim())
}

// Generic section body extractor — base implementation for all handoff section reads.
// Returns trimmed body text between the named heading and the next ## heading (or EOF).
// Returns "" if section is absent or body is empty after trimming.
export function extractHandoffSection(specContent: string, sectionHeading: string): string {
  // Escape any regex special chars in the heading (e.g. ## Design Assumptions To Validate)
  const escapedHeading = sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n*$)`, "i")
  const match = specContent.match(pattern)
  if (!match) return ""
  return match[1].trim()
}

// Convenience wrapper: extracts body of ## Design Assumptions section.
// Used at finalize_design_spec to seed assumptions to engineering spec.
export function extractDesignAssumptions(specContent: string): string {
  return extractHandoffSection(specContent, "## Design Assumptions")
}

// Extracts ALL questions from ## Open Questions section (both [blocking: yes] and [blocking: no]).
// Section-scoped: only matches lines within ## Open Questions, not other sections.
// Used by finalization gates — the final approved spec must have zero open questions of any kind.
export function extractAllOpenQuestions(specContent: string): string[] {
  const sectionBody = extractHandoffSection(specContent, "## Open Questions")
  if (!sectionBody) return []
  return sectionBody
    .split("\n")
    .filter(line => line.includes("[blocking:"))
    .map(line => line.replace(/^[-*]\s*/, "").trim())
}

