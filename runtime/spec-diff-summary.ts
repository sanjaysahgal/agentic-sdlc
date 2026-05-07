/**
 * @deterministic — Pure structural diff summary for product/design/engineering specs.
 *
 * Manifest item B24. Surfaced 2026-05-01 in Step 2a manual testing (catastrophic
 * observation #29). The user-facing post-writeback message said "spec was
 * partially updated, 1 PM-scope gap remains" — implying a small leftover.
 * Reality: the strip-pass had corrupted 6 unrelated ACs while the original gap
 * the PM was supposed to fix went untouched. The user had no warning, no diff
 * surface, no way to know what had changed without manually inspecting GitHub.
 *
 * Fix: a deterministic AC-level diff between pre- and post-writeback spec
 * states. Same input ⇒ same output (Principle 11). Composed into the platform's
 * post-writeback status messages so the user sees concrete change reporting:
 * "Modified ACs 4, 13. Added AC 26." instead of vague "spec was updated."
 *
 * Pure function, no LLM, no I/O. The caller is responsible for surfacing the
 * brief into user-facing messages.
 */

import { extractAcMap } from "./spec-content-verifier"

export type SpecDiffSummary = {
  addedAcs: number[]
  removedAcs: number[]
  modifiedAcs: number[]
  /** Concise one-line human summary, suitable for inlining into a Slack message. */
  brief: string
}

/**
 * Normalize an AC body for change-detection comparison. Collapses whitespace
 * and lowercases — substantive content changes (different wording, different
 * values) will register as differences; cosmetic whitespace/case will not.
 */
function normalizeForDiff(body: string): string {
  return body.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Compute the AC-level diff between two spec states. Returns added, removed,
 * and modified AC numbers (sorted ascending) plus a one-line brief.
 *
 * Pure function. Same input ⇒ same output (Principle 11).
 */
export function summarizeAcDiff(beforeSpec: string, afterSpec: string): SpecDiffSummary {
  const before = extractAcMap(beforeSpec)
  const after = extractAcMap(afterSpec)

  const beforeKeys = new Set(before.keys())
  const afterKeys = new Set(after.keys())

  const addedAcs: number[] = []
  const removedAcs: number[] = []
  const modifiedAcs: number[] = []

  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) {
      addedAcs.push(k)
    } else if (normalizeForDiff(after.get(k)!) !== normalizeForDiff(before.get(k)!)) {
      modifiedAcs.push(k)
    }
  }
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) removedAcs.push(k)
  }

  addedAcs.sort((a, b) => a - b)
  removedAcs.sort((a, b) => a - b)
  modifiedAcs.sort((a, b) => a - b)

  const parts: string[] = []
  if (modifiedAcs.length > 0) parts.push(`Modified ${formatAcList(modifiedAcs)}`)
  if (addedAcs.length > 0) parts.push(`added ${formatAcList(addedAcs)}`)
  if (removedAcs.length > 0) parts.push(`removed ${formatAcList(removedAcs)}`)
  const brief = parts.length === 0 ? "No AC changes detected." : parts.join("; ") + "."

  return { addedAcs, removedAcs, modifiedAcs, brief }
}

function formatAcList(nums: number[]): string {
  if (nums.length === 0) return ""
  if (nums.length === 1) return `AC ${nums[0]}`
  return `ACs ${nums.join(", ")}`
}
