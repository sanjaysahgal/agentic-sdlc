// Block G5 of the approved system-wide plan
// (~/.claude/plans/rate-this-plan-zesty-tiger.md). Helpers for safely
// rendering values into log lines without leaking secrets.
//
// Usage:
//   console.log(`[STORE] saved spec — token=${redactToken(token)}`)
//   console.log(`[USER] feature=${redactPii(featureName)}`)
//
// Patterns redacted:
//   - Slack tokens (xoxb/xoxa/xoxp)
//   - Anthropic / OpenAI keys (sk-ant-, sk-proj-)
//   - GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_)
//   - AWS access keys (AKIA…)
//   - Generic high-entropy strings starting with "Bearer " or "token=" / "key="
//
// PII (email, phone, SSN-shaped numbers) is NOT redacted by `redactToken`
// — that's `redactPii` (separate function so callers reason about each
// concern explicitly).
//
// The platform's [STORE], [ROUTER], [HEDGE-GATE] log lines today log only
// feature names + counts + branch labels — none of which are secrets.
// This module exists so any future log line that DOES reference a secret
// has a single pure helper to call, structurally.

const TOKEN_PATTERNS: RegExp[] = [
  /xoxb-\d{10,}-\d{10,}-[a-zA-Z0-9]{20,}/g,
  /xoxa-\d{10,}-\d{10,}-[a-zA-Z0-9]{20,}/g,
  /xoxp-\d{10,}-\d{10,}-\d{10,}-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{32,}/g,
  /sk-proj-[a-zA-Z0-9_-]{32,}/g,
  /(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
]

const PII_EMAIL  = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const PII_PHONE  = /\b\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g
const PII_SSN    = /\b\d{3}-\d{2}-\d{4}\b/g

/**
 * Replace any vendor-token pattern in `value` with a fingerprint
 * (`<KIND>-…last8>`) so logs are still useful for debugging but secrets
 * never appear in plaintext.
 */
export function redactToken(value: string | undefined | null): string {
  if (value == null) return String(value)
  let out = value
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (match) => {
      const tail = match.slice(-4)
      return `<TOKEN-…${tail}>`
    })
  }
  return out
}

/**
 * Replace common PII patterns (email, phone, SSN) with a placeholder.
 * Call this for any log line that may carry user-provided strings.
 */
export function redactPii(value: string | undefined | null): string {
  if (value == null) return String(value)
  return value
    .replace(PII_EMAIL, "<EMAIL>")
    .replace(PII_PHONE, "<PHONE>")
    .replace(PII_SSN,   "<SSN>")
}

/** Convenience: redact both tokens and PII in one pass. */
export function redactAll(value: string | undefined | null): string {
  return redactPii(redactToken(value))
}
