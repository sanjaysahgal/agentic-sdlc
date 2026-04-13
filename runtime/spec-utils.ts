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

