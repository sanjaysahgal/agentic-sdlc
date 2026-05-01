/**
 * @deterministic — extracts and applies "category rules" from PM/agent
 * recommendations. Manifest item B9 (regression catalog bug #16).
 *
 * Why this exists:
 * The PM in escalation-resume mode often issues universal substitution
 * directives like:
 *   - "Any 'immediately' becomes 'within 1 second'"
 *   - "Replace all 'smooth' with 'in under 200ms'"
 *   - "Every 'quickly' → 'within 2 seconds'"
 * Haiku's spec patcher (pm-escalation-spec-writer.ts) applies these
 * inconsistently — it might replace 2 of 5 instances and leave 3
 * untouched. Deterministic auditPmSpec catches the misses, but each miss
 * means a re-escalation round-trip — N round-trips for what should be one.
 *
 * Fix per CLAUDE.md Principle 11 (deterministic audits): pull the
 * substitution out of Haiku's hands. Parse the universal-quantified
 * substitution patterns from the recommendation text deterministically;
 * apply them to the spec via word-boundary string replace BEFORE handing
 * the spec to Haiku. Haiku then merges the rest of the recommendation on
 * top of the already-substituted spec. After Haiku's merge, run a
 * deterministic verification: if any "from" word survives, apply the rules
 * again as a final safety net.
 *
 * The extractor is conservative — it requires the universal quantifier
 * ("any", "all", "every") to fire, so a single-AC change ("change AC#5's
 * 'fast' to '200ms'") doesn't bleed into other ACs that legitimately use
 * "fast." False negatives are safer than false positives.
 *
 * The applier uses word-boundary matching so "fast" doesn't match
 * "breakfast" or "fasten."
 */

export type CategoryRule = {
  /** The string to find (case-insensitive). Matched at word boundaries. */
  from: string
  /** The string to replace it with. */
  to: string
}

/**
 * Parse universal-quantified substitution rules from a recommendation
 * text. Returns the list of (from, to) pairs found. Empty array if none.
 *
 * Supported patterns (case-insensitive):
 *   - "any 'X' becomes 'Y'"            → {from: X, to: Y}
 *   - "any 'X' should be 'Y'"          → {from: X, to: Y}
 *   - "all instances of 'X' become 'Y'"
 *   - "every 'X' → 'Y'"
 *   - "every 'X' -> 'Y'"
 *   - "replace all 'X' with 'Y'"
 *   - "replace 'X' with 'Y'"
 *   - "change 'X' to 'Y'"
 *
 * Quote characters accepted: straight (' "), smart (' ' " ").
 * Conservative on quantifier — patterns lacking "any/all/every/replace/change"
 * are NOT treated as category rules to avoid false positives on
 * single-criterion edits.
 */
export function extractCategoryRules(recommendations: string): CategoryRule[] {
  const rules: CategoryRule[] = []
  if (!recommendations) return rules

  // Quote class — straight and smart, single and double.
  const Q = `["'“”‘’«»]`

  // Pattern A: "any/all/every [instances of] 'X' becomes/become/should be/→/-> 'Y'"
  const reA = new RegExp(
    `(?:any|all|every)(?:\\s+instances?\\s+of)?\\s+${Q}([^${Q.slice(1, -1)}\\n]{1,80})${Q}\\s+(?:becomes?|should\\s+be|→|->)\\s+${Q}([^${Q.slice(1, -1)}\\n]{1,200})${Q}`,
    "gi",
  )

  // Pattern B: "replace [all] 'X' with/by 'Y'"
  const reB = new RegExp(
    `replace(?:\\s+all)?\\s+${Q}([^${Q.slice(1, -1)}\\n]{1,80})${Q}\\s+(?:with|by)\\s+${Q}([^${Q.slice(1, -1)}\\n]{1,200})${Q}`,
    "gi",
  )

  // Pattern C: "change 'X' to 'Y'" (only when accompanied by a universal cue
  // — "change every", "change any", "change all" — to avoid single-criterion changes)
  const reC = new RegExp(
    `change\\s+(?:any|all|every)\\s+${Q}([^${Q.slice(1, -1)}\\n]{1,80})${Q}\\s+to\\s+${Q}([^${Q.slice(1, -1)}\\n]{1,200})${Q}`,
    "gi",
  )

  for (const re of [reA, reB, reC]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(recommendations)) !== null) {
      const from = m[1].trim()
      const to = m[2].trim()
      if (!from || !to) continue
      // Dedupe by from (last write wins is fine — operator-intent is one rule per term)
      const existing = rules.find((r) => r.from.toLowerCase() === from.toLowerCase())
      if (existing) existing.to = to
      else rules.push({ from, to })
    }
  }
  return rules
}

/**
 * Apply category rules to a spec via word-boundary case-insensitive
 * substitution. Pure — same input always returns same output.
 *
 * Word-boundary matching ensures "fast" doesn't match "breakfast" or
 * "fasten." For multi-word "from" values (e.g. "in time"), word boundaries
 * are applied at the start and end of the whole phrase.
 */
export function applyCategoryRules(spec: string, rules: readonly CategoryRule[]): string {
  let result = spec
  for (const { from, to } of rules) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // \b at start/end gives whole-phrase word boundary. Works for single words
    // and multi-word phrases (the boundary applies to the outermost edges).
    const re = new RegExp(`\\b${escaped}\\b`, "gi")
    result = result.replace(re, to)
  }
  return result
}

/**
 * Verify no "from" word from the rules survives in the spec. Returns the
 * list of rules that still have at least one match (empty array = clean).
 * Used post-Haiku to detect when Haiku's merge re-introduced a "from" word
 * (rare but possible when Haiku rewrites a criterion that previously
 * contained the substituted term).
 */
export function findResidualCategoryViolations(
  spec: string,
  rules: readonly CategoryRule[],
): CategoryRule[] {
  const residuals: CategoryRule[] = []
  for (const rule of rules) {
    const escaped = rule.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`\\b${escaped}\\b`, "i")
    if (re.test(spec)) residuals.push(rule)
  }
  return residuals
}
