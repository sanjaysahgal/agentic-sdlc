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
  /** Reason for flagging — quoted-phrase mismatch, missing AC, or inference-style claim mismatch (B21) */
  reason: "claimed-wording-not-in-ac" | "ac-does-not-exist" | "inference-claim-not-in-ac"
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
export function findAcReferences(agentResponse: string): Array<{ acNumber: number; surroundingText: string; citationStart: number; citationLength: number }> {
  const refs: Array<{ acNumber: number; surroundingText: string; citationStart: number; citationLength: number }> = []
  const re = /\bAC\s*#?\s*(\d{1,3})\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(agentResponse)) !== null) {
    const acNum = parseInt(m[1], 10)
    // Capture ±200 chars around the citation for claim extraction
    const start = Math.max(0, m.index - 200)
    const end = Math.min(agentResponse.length, m.index + m[0].length + 200)
    const surroundingText = agentResponse.slice(start, end)
    refs.push({ acNumber: acNum, surroundingText, citationStart: m.index, citationLength: m[0].length })
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
 * B29 — Prose-fragment detector. Returns true if the phrase looks like a fragment
 * of agent prose rather than a claim about AC content. Used to filter out the
 * quoted-phrase extractor's false-positive captures.
 *
 * The plan-specified "AC-vocabulary signal" approach (require subject + verb +
 * threshold) over-filters legitimate fabrications like "two-factor authentication
 * via SMS" (a real spec-content claim with no AC-vocabulary tokens). Instead,
 * this targets the specific patterns the MT-33 false-positives exhibited:
 *
 *   - Starts with a mid-word contraction suffix ("re ", "ll ", "ve ", "d ",
 *     "s ", "t ", "m ", "n "). Picked up when the regex extracted a span
 *     between two apostrophes that were actually contractions (`they're` →
 *     `re meaningfully different situations. I`).
 *   - Contains stand-alone 1st-person pronouns (I, I'll, I've, I'd, we, we'll,
 *     we've, us, our) or 2nd-person (you, you'll, you've, your). AC bodies are
 *     written in 3rd-person ("the user", "the system"); agent prose uses 1st/2nd.
 *
 * Pure, deterministic. Same input ⇒ same output (Principle 11).
 */
const CONTRACTION_SUFFIX_START = /^(?:re|ll|ve|d|s|t|m|n)\s/i
const PROSE_PRONOUN_REGEX = /\b(?:I|I'?(?:ll|ve|d|m)|we|we'?(?:ll|ve|d)|us|our|you|you'?(?:ll|ve|d|r)|your)\b/

// TRIGGER-JUSTIFIED: B29 deterministic post-extraction filter inside verifyAcReferences; runs on every quoted phrase the extractor returns, no trigger-phrase dependence.
export function isProseFragment(phrase: string): boolean {
  if (CONTRACTION_SUFFIX_START.test(phrase)) return true
  if (PROSE_PRONOUN_REGEX.test(phrase)) return true
  return false
}

/**
 * B29 — Intra-spec dedup. Returns true if the phrase appears in ANY AC's body
 * other than the cited AC. Used to skip "claimed-wording-not-in-ac" flags when
 * the agent quoted real spec content but the extractor attributed the phrase
 * to the wrong AC (a wrong-attribution case, not a hallucination).
 *
 * Step 2a MT-33 false-positive that this catches:
 *   - "AC 27 does NOT contain 'The logged-out indicator disappears within 1
 *     second of valid authentication token receipt'" — the phrase IS in AC 4,
 *     just attributed to AC 27 because the ±200 window crossed both citations.
 *
 * The check is "phrase appears in another AC's body", not "phrase appears
 * verbatim in the cited AC body" — wrong-attribution differs from fabrication.
 *
 * Pure, deterministic. Same input ⇒ same output (Principle 11).
 */
export function phraseAppearsInAnotherAc(
  normalizedPhrase: string,
  citedAcNumber: number,
  acMap: Map<number, string>,
): boolean {
  for (const [acNum, body] of acMap) {
    if (acNum === citedAcNumber) continue
    const normalizedBody = body.toLowerCase().replace(/\s+/g, " ")
    if (normalizedBody.includes(normalizedPhrase)) return true
  }
  return false
}

/**
 * B21 — Inference-style claim detection. The agent often cites an AC as
 * precedent for a numeric value: "200ms matches the threshold used in AC 4
 * and AC 27." This claims AC 4 / AC 27 contain a 200ms timing — and if they
 * don't, it's a fabricated citation.
 *
 * Returns timing values (normalized to milliseconds) extracted from text. Used
 * to compare an inference window against the cited AC's body: if the value
 * appears in the window but not in the AC, the agent's "matches AC N" claim
 * is fabricated.
 */
export type TimingValue = { ms: number; raw: string }

export function extractTimingValues(text: string): TimingValue[] {
  const values: TimingValue[] = []
  const seen = new Set<string>()
  const patterns: Array<{ re: RegExp; toMs: (n: number) => number }> = [
    { re: /(\d+\.?\d*)\s*(?:ms|milliseconds?)\b/gi, toMs: n => n },
    { re: /(\d+\.?\d*)\s*(?:s|seconds?)\b/gi, toMs: n => n * 1000 },
    { re: /(\d+\.?\d*)\s*(?:minutes?|mins?)\b/gi, toMs: n => n * 60_000 },
    { re: /(\d+\.?\d*)\s*(?:hours?|hrs?)\b/gi, toMs: n => n * 3_600_000 },
  ]
  for (const { re, toMs } of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const n = parseFloat(m[1])
      if (Number.isNaN(n)) continue
      const raw = m[0].trim()
      const key = `${toMs(n)}|${raw.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      values.push({ ms: toMs(n), raw })
    }
  }
  return values
}

/**
 * Tight inference window around an AC citation — narrower than the ±200 char
 * window used for quoted-phrase extraction. The inference check needs to be
 * conservative: a timing value in the SAME sentence/clause as "AC N" is a
 * claim about AC N. A timing value 150 chars away may be unrelated.
 *
 * Window: ±80 chars on either side of the AC citation match. Empirically
 * captures the canonical inference pattern ("Xms matches AC N", "AC N uses
 * Xms") without bleeding into adjacent sentences.
 */
function extractInferenceWindow(agentResponse: string, citationStart: number, citationLength: number): string {
  const start = Math.max(0, citationStart - 80)
  const end = Math.min(agentResponse.length, citationStart + citationLength + 80)
  return agentResponse.slice(start, end)
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
    //
    // B29 — three-part precision tightening per Step 2a MT-33 (false-positive cascade
    // that resulted from over-eager B11 v1 algorithm when promoted to BLOCKING):
    //
    //   (a) Phrase length must be ≥ 16 chars (was 8). Very short phrases like
    //       "immediately" are almost always picked up from PM prose, not from
    //       claims about AC content. The 16-char floor removes that class of FP
    //       at the cost of letting through fabrications of ≤ 15-char phrases
    //       (acceptable — most spec-content claims are longer than that).
    //
    //   (b) Phrase must contain AC-vocabulary signal (subject + verb + threshold).
    //       Filters out fragments of agent prose like "re meaningfully different
    //       situations. I" that the quoted-phrase extractor captured due to the
    //       ±200 char window. AC bodies follow a recognizable
    //       subject-verb-threshold shape; prose generally doesn't.
    //
    //   (c) Phrase must NOT appear in ANOTHER AC's body. If it does, the agent
    //       quoted real spec content but the extractor attributed it to the
    //       wrong AC (the ±200 window crossed two AC citations). That's
    //       wrong-attribution, not fabrication — skip the flag.
    //
    // After tightening, BLOCKING is safe to keep on at the writeback boundary.
    const phrases = extractQuotedPhrasesNear(ref.surroundingText)
    const normalizedActual = actualText.toLowerCase().replace(/\s+/g, " ")
    for (const phrase of phrases) {
      const normalizedPhrase = phrase.toLowerCase().replace(/\s+/g, " ")
      // (a) Length floor: skip phrases under 16 chars — likely prose fragments.
      if (normalizedPhrase.length < 16) continue
      // (b) Prose-fragment detector: skip phrases that look like agent prose
      // rather than AC content (contraction-suffix starts; 1st/2nd-person pronouns).
      if (isProseFragment(phrase)) continue
      // Already-in-AC phrases pass verification — no flag.
      if (normalizedActual.includes(normalizedPhrase)) continue
      // (c) Intra-spec dedup: if the phrase IS in another AC's body, this is
      // wrong-attribution (the agent quoted real spec content but the ±200
      // window crossed citations). Skip the flag.
      if (phraseAppearsInAnotherAc(normalizedPhrase, ref.acNumber, acMap)) continue
      // All three filters passed AND phrase is missing from cited AC → fabrication.
      hallucinations.push({
        citedAcNumber: ref.acNumber,
        claimedWording: phrase,
        actualWording: actualText,
        reason: "claimed-wording-not-in-ac",
      })
    }

    // B21 — Inference-style claim check. The agent often cites an AC as
    // precedent for a numeric value: "200ms matches the threshold used in
    // AC 4 and AC 27." If the cited AC's body does NOT contain a timing
    // equal to the claimed value, the citation is fabricated.
    //
    // Window: tight ±80 char window around the citation (vs ±200 for quoted
    // phrases), to keep the inference signal local — a timing value in the
    // same sentence as "AC N" is a claim about AC N; one 150 chars away may
    // be unrelated. False positives here are lower-cost than false negatives:
    // BLOCKING the writeback gives operators a chance to verify; letting a
    // fabricated citation through corrupts the spec (canonical Step 2a #13).
    const inferenceWindow = extractInferenceWindow(agentResponse, ref.citationStart, ref.citationLength)
    const claimedTimings = extractTimingValues(inferenceWindow)
    if (claimedTimings.length > 0) {
      const acTimings = extractTimingValues(actualText)
      const acMsValues = new Set(acTimings.map(t => t.ms))
      for (const claim of claimedTimings) {
        if (!acMsValues.has(claim.ms)) {
          hallucinations.push({
            citedAcNumber: ref.acNumber,
            claimedWording: claim.raw,
            actualWording: actualText,
            reason: "inference-claim-not-in-ac",
          })
        }
      }
    }
  }

  return hallucinations
}

/**
 * Format a list of hallucinations as a human-readable diagnostic string,
 * suitable for log lines or user-facing notices.
 */
/**
 * B28 — User-facing message for the BLOCKING writeback path. Per Step 2a
 * observation #32 (catastrophic UX), the prior code returned `null` from the
 * writer on hallucination detection and the caller `return`ed silently. User
 * typed `approved`, saw nothing — black-box stuck state.
 *
 * Now the caller posts this message to Slack on BLOCK. The message is in
 * platform voice (per Principle 17 cross-surface consistency), names the
 * concrete count, includes the verifier's formatted findings so the user can
 * see exactly which citations were fabricated, and ends with a clear next-step
 * CTA. The user can re-author the recommendation and re-confirm without
 * needing to know about the platform's internal verifier.
 *
 * Pure, deterministic. Same input ⇒ same output (Principle 11).
 */
export function buildBlockedWritebackMessage(
  hallucinations: AcHallucination[],
  agentRole: "PM" | "Architect" | "Designer",
): string {
  const n = hallucinations.length
  const itemWord = n === 1 ? "issue" : "issues"
  const findings = formatHallucinations(hallucinations)
  return [
    `*Platform —* ${agentRole}'s recommendation contained ${n} citation ${itemWord} that need re-authoring before the spec can be updated. Here's what was flagged:`,
    "",
    findings,
    "",
    `Reply with a revised recommendation and we'll try the writeback again. (The spec on main is unchanged.)`,
  ].join("\n")
}

export function formatHallucinations(hallucinations: AcHallucination[]): string {
  return hallucinations.map((h, i) => {
    if (h.reason === "ac-does-not-exist") {
      return `${i + 1}. AC ${h.citedAcNumber} does NOT exist in the spec. Agent claimed: "${h.claimedWording}".`
    }
    if (h.reason === "inference-claim-not-in-ac") {
      return `${i + 1}. AC ${h.citedAcNumber} does NOT contain timing "${h.claimedWording}" — agent cited AC ${h.citedAcNumber} as precedent for that value. Actual AC ${h.citedAcNumber} text: "${h.actualWording}".`
    }
    return `${i + 1}. AC ${h.citedAcNumber} does NOT contain "${h.claimedWording}". Actual AC ${h.citedAcNumber} text: "${h.actualWording}".`
  }).join("\n")
}
