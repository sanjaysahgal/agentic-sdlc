/**
 * @deterministic — Block N's enforceNoHedging-class structural verifier for spec content.
 *
 * Manifest item B11. Surfaced 2026-04-30 (Bug G — PM cites wrong AC numbers in
 * escalation-resume mode). Without this, every PM/architect/designer escalation
 * recommendation that cites "AC N" is a hallucination waiting to slip past user
 * inspection and corrupt the spec via a downstream patcher.
 *
 * v1 scope (this module): AC-number references only.
 *   - Detects "AC N", "AC #N", "AC#N" patterns in agent prose
 *   - For each cited AC, fetches the actual AC text from the product spec
 *   - If the agent quotes / claims wording that doesn't actually appear in the
 *     cited AC, flags it as a hallucination
 *
 * Future scope (separate items): screen-name verification, brand-token verification,
 * section-heading verification, locked-decision verification.
 *
 * The function is pure — same input always returns the same output. Caller is
 * responsible for deciding what to do with the findings (log, block, re-prompt,
 * surface to user).
 */

export type AcHallucination = {
  /** AC number as cited by the agent (e.g. 27 if agent said "AC 27") */
  citedAcNumber: number
  /** What the agent claimed AC N contains (extracted from quoted text near the citation) */
  claimedWording: string
  /** What AC N actually contains (or null if AC N doesn't exist in the spec at all) */
  actualWording: string | null
  /** Reason for flagging — "claimed-wording-not-in-ac" or "ac-does-not-exist" */
  reason: "claimed-wording-not-in-ac" | "ac-does-not-exist"
}

export type ContentVerifierFinding = AcHallucination

/**
 * Extract numbered AC items from a product spec. Returns a Map keyed by AC number.
 * Handles the canonical product-spec format: numbered list items under `## Acceptance Criteria`.
 *
 * Robust to:
 *   - Variations in heading case ("Acceptance Criteria", "ACCEPTANCE CRITERIA")
 *   - Numbered items with optional leading whitespace
 *   - Multi-line AC bodies (joins continuation lines)
 *
 * Returns Map<number, string> where the string is the full body of that AC (trimmed).
 */
export function extractAcMap(productSpec: string): Map<number, string> {
  const result = new Map<number, string>()
  if (!productSpec) return result

  // Find the Acceptance Criteria section (case-insensitive)
  const acSectionMatch = productSpec.match(/^##\s*Acceptance Criteria\s*$/im)
  if (!acSectionMatch || acSectionMatch.index === undefined) return result

  const sectionStart = acSectionMatch.index + acSectionMatch[0].length
  // Section ends at the next `## ` heading or end of file
  const remaining = productSpec.slice(sectionStart)
  const nextHeadingMatch = remaining.match(/^##\s+/m)
  const sectionEnd = nextHeadingMatch?.index ?? remaining.length
  const sectionBody = remaining.slice(0, sectionEnd)

  // Stateful line-by-line parse: a numbered line opens a new AC; subsequent
  // non-numbered, non-heading lines are continuation. Blank lines separate
  // continuations but don't end the AC.
  const lines = sectionBody.split("\n")
  let currentNum: number | null = null
  let currentBuf: string[] = []
  const flush = () => {
    if (currentNum !== null) {
      const body = currentBuf.join(" ").trim().replace(/\s+/g, " ")
      if (body) result.set(currentNum, body)
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const numberedMatch = /^(\d+)\.\s+(.*)$/.exec(line)
    if (numberedMatch) {
      flush()
      currentNum = parseInt(numberedMatch[1], 10)
      currentBuf = [numberedMatch[2]]
    } else if (currentNum !== null) {
      const trimmed = line.trim()
      if (trimmed) currentBuf.push(trimmed)
    }
  }
  flush()
  return result
}

/**
 * Find AC# references in agent prose. Returns the AC numbers cited and a window
 * of surrounding text (for extracting the agent's claim about each AC).
 *
 * Recognizes: "AC 10", "AC #10", "AC#10", "AC10", "(AC 10)" — case-insensitive.
 * Does NOT match decimal numbers, version numbers, or AC mentions inside code blocks.
 */
export function findAcReferences(agentResponse: string): Array<{ acNumber: number; surroundingText: string }> {
  const refs: Array<{ acNumber: number; surroundingText: string }> = []
  const re = /\bAC\s*#?\s*(\d{1,3})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(agentResponse)) !== null) {
    const acNum = parseInt(m[1], 10)
    // Capture ±200 chars around the citation for claim extraction
    const start = Math.max(0, m.index - 200)
    const end = Math.min(agentResponse.length, m.index + m[0].length + 200)
    const surroundingText = agentResponse.slice(start, end)
    refs.push({ acNumber: acNum, surroundingText })
  }
  return refs
}

/**
 * Extract quoted phrases near an AC citation. The agent often says something like:
 *   "AC 10 — 'a clear sign-up call-to-action' should be replaced with ..."
 * The quoted phrase is what the agent CLAIMS is in AC N. Verifying that phrase
 * actually appears in AC N is the core check.
 *
 * Returns all quoted phrases (single-quoted, double-quoted, or "smart-quoted")
 * within the surrounding window.
 */
export function extractQuotedPhrasesNear(surroundingText: string): string[] {
  const phrases: string[] = []
  // Match single-quoted, double-quoted, or smart-quoted strings.
  // Allow common punctuation inside.
  const re = /["'“‘]([^"'”’\n]{3,200})["'”’]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(surroundingText)) !== null) {
    phrases.push(m[1].trim())
  }
  return phrases
}

/**
 * Main entry point. Returns the list of hallucinations detected in the agent's
 * response with respect to the product spec. Empty list means the response
 * passes verification.
 */
export function verifyAcReferences(agentResponse: string, productSpec: string): AcHallucination[] {
  const acMap = extractAcMap(productSpec)
  const refs = findAcReferences(agentResponse)
  const hallucinations: AcHallucination[] = []

  for (const ref of refs) {
    const actualText = acMap.get(ref.acNumber) ?? null

    if (actualText === null) {
      // AC N doesn't exist in the spec at all
      const phrases = extractQuotedPhrasesNear(ref.surroundingText)
      hallucinations.push({
        citedAcNumber: ref.acNumber,
        claimedWording: phrases.join(" / ") || "(no quoted wording extracted)",
        actualWording: null,
        reason: "ac-does-not-exist",
      })
      continue
    }

    // AC N exists. Check if any quoted phrase near the citation actually appears in AC N's body.
    // The agent's claim is "AC N contains X" — if X isn't in AC N's body, it's a hallucination.
    const phrases = extractQuotedPhrasesNear(ref.surroundingText)
    if (phrases.length === 0) continue  // No specific claim to verify; skip (could be a generic reference)

    // Normalize for substring matching: case-insensitive, collapse whitespace.
    const normalizedActual = actualText.toLowerCase().replace(/\s+/g, " ")
    for (const phrase of phrases) {
      const normalizedPhrase = phrase.toLowerCase().replace(/\s+/g, " ")
      // Skip very short phrases (less informative — likely false positives)
      if (normalizedPhrase.length < 8) continue
      // If the phrase is substantial AND not in the AC body, flag it
      if (!normalizedActual.includes(normalizedPhrase)) {
        hallucinations.push({
          citedAcNumber: ref.acNumber,
          claimedWording: phrase,
          actualWording: actualText,
          reason: "claimed-wording-not-in-ac",
        })
      }
    }
  }

  return hallucinations
}

/**
 * Format a list of hallucinations as a human-readable diagnostic string,
 * suitable for log lines or user-facing notices.
 */
export function formatHallucinations(hallucinations: AcHallucination[]): string {
  return hallucinations.map((h, i) => {
    if (h.reason === "ac-does-not-exist") {
      return `${i + 1}. AC ${h.citedAcNumber} does NOT exist in the spec. Agent claimed: "${h.claimedWording}".`
    }
    return `${i + 1}. AC ${h.citedAcNumber} does NOT contain "${h.claimedWording}". Actual AC ${h.citedAcNumber} text: "${h.actualWording}".`
  }).join("\n")
}
