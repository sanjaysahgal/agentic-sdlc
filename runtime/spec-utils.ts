// Shared spec content utilities used across message handlers and tests.

// Extracts all [blocking: yes] open questions from a spec.
// Used to gate approval — a spec with unresolved blocking questions cannot be saved.
export function extractBlockingQuestions(specContent: string): string[] {
  const lines = specContent.split("\n")
  return lines
    .filter(line => line.includes("[blocking: yes]"))
    .map(line => line.replace(/^[-*]\s*/, "").trim())
}

