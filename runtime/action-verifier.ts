/**
 * Post-response action verification gate — Principle 8 enforcement.
 *
 * Verifies that claims in agent prose match actual tool calls.
 * If the agent says "finalized" but never called finalize_*, the claim
 * is stripped and a correction is appended.
 *
 * @deterministic — same response + same toolCalls = same output, always.
 */

export type ToolCallRecord = {
  name: string
  input?: unknown
}

// ────────────────────────────────────────────────────────────────────────────────
// Claim patterns — what the agent might say, and what tool call must back it up
// ────────────────────────────────────────────────────────────────────────────────

type ClaimRule = {
  /** Regex patterns that detect the claim in prose (case-insensitive). */
  patterns: RegExp[]
  /** Tool name prefixes that validate the claim. If ANY matching tool was called, the claim is valid. */
  validatingToolPrefixes: string[]
  /** Correction text appended when the claim is false. */
  correction: string
}

const CLAIM_RULES: ClaimRule[] = [
  {
    patterns: [
      /\bfinalized\b/i,
      /\bapproved and saved\b/i,
      /\bmerged to main\b/i,
      /\bspec is (now )?approved\b/i,
      /\bready for (the )?(engineer|build|implementation)/i,
    ],
    validatingToolPrefixes: ["finalize_"],
    correction: "_Note: the spec has NOT been finalized. Say *approve* to run the finalization audit._",
  },
  {
    patterns: [
      /\bsaved (the |a )?draft\b/i,
      /\bspec (has been |is )?(updated|saved|committed)\b/i,
      /\bdraft (has been |is )?(saved|updated|committed)\b/i,
    ],
    validatingToolPrefixes: ["save_", "apply_", "rewrite_"],
    correction: "_Note: no spec changes were saved this turn._",
  },
  {
    patterns: [
      /\bescalated to (the )?(PM|product manager|designer|architect)\b/i,
      /\bbringing (the |in )?(PM|product manager|designer|architect)\b/i,
    ],
    validatingToolPrefixes: ["offer_pm_escalation", "offer_architect_escalation", "offer_upstream_revision"],
    correction: "_Note: no escalation was initiated this turn._",
  },
]

// ────────────────────────────────────────────────────────────────────────────────
// Main verification function
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Verifies that action claims in agent prose are backed by actual tool calls.
 * Returns the response with false claims stripped and corrections appended.
 *
 * If no false claims are found, returns the response unchanged.
 */
export function verifyActionClaims(response: string, toolCalls: ToolCallRecord[]): string {
  const toolNames = toolCalls.map(t => t.name)
  const corrections: string[] = []

  for (const rule of CLAIM_RULES) {
    // Check if any pattern matches the response
    const claimFound = rule.patterns.some(p => p.test(response))
    if (!claimFound) continue

    // Check if any validating tool was called
    const validated = rule.validatingToolPrefixes.some(prefix =>
      toolNames.some(name => name.startsWith(prefix) || name === prefix)
    )

    if (!validated) {
      console.log(`[ACTION-VERIFIER] false claim detected: matched ${rule.patterns.find(p => p.test(response))?.source} but no ${rule.validatingToolPrefixes.join("/")} tool was called`)
      corrections.push(rule.correction)
    }
  }

  if (corrections.length === 0) return response

  console.log(`[ACTION-VERIFIER] ${corrections.length} false claim(s) corrected`)
  return response + "\n\n---\n\n" + corrections.join("\n")
}
