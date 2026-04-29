// Phase 5 / I22 — Haiku free-text classifier for escalation dismissal intent.
//
// Per the project's free-text classification rule (memory:
// feedback_free_text_classification): any function classifying human prose
// MUST use an LLM, never keyword matching. Keyword matchers were used here
// historically and produced false positives ("ignore" inside a sentence
// like "don't ignore those gaps" mis-classified as dismiss); Haiku reads
// the full message context.
//
// The classifier sits OUTSIDE the pure router (Principle 12 — routers
// make no I/O calls). The dispatcher calls `classifyDismissIntent` before
// invoking the router and propagates the result via
// `RoutingIntent.dismissIntent`. The router then deterministically branches
// on the boolean flag — Phase 4 cutover wires this in production.
//
// Conservative bias: when the model is uncertain it returns NOT-DISMISS.
// This is by design — false-dismiss is worse than false-hold (the audit
// signal is preserved either way; only the user's experience is affected).

import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ maxRetries: 0, timeout: 15_000 })

// Exported for tests to assert prompt structure (producer-test side of the
// producer/consumer chain). Changes to this string are spec-visible.
export const DISMISS_SYSTEM_PROMPT = `You are classifying a user's reply during an active spec audit escalation.

The platform has paused the downstream agent (designer or architect) and is offering to bring an upstream agent (PM or designer) into the thread to resolve audit findings on an upstream spec. The user can confirm the escalation ("yes"), continue conversing about the items, or DISMISS the escalation entirely — accepting the upstream spec as-is and letting the downstream agent resume without writeback.

Determine if the user's reply is a clear DISMISS signal: they want to abandon the escalation, leave the upstream spec unchanged, and proceed downstream regardless of the audit findings.

CONSERVATIVE RULE: Only classify as DISMISS when the message clearly and unambiguously abandons the escalation. Ambiguity, questions, alternative proposals, or partial acceptance are NOT dismiss signals — return NOT-DISMISS in those cases.

Examples that ARE dismiss (DISMISS):
- "leave it as-is"
- "the spec is fine, skip this"
- "ignore those gaps"
- "we'll deal with it later, move on"
- "abandon this escalation"
- "drop the escalation, just continue"
- "those aren't real issues, proceed"
- "skip this, let's keep going"
- "forget about it, the spec works"
- "no need to change anything, just resume"

Examples that are NOT dismiss (NOT-DISMISS):
- "yes"
- "approved"
- "ok"
- "go ahead"
- "what about item 3"
- "tell me more about the first one"
- "let me think about it"
- "I disagree with item 2"
- "fix item 1 only"
- "no, the spec needs work"  (declining the spec, NOT dismissing the escalation)
- "that's wrong"
- "actually we should..."
- "hmm, maybe later"  (deferred, not dismissed)

Respond with exactly one of:
DISMISS
NOT-DISMISS`

export type DismissClassification = {
  readonly dismiss: boolean
  // The raw model output, preserved so the dispatcher can log decisions for
  // post-hoc review. Useful when a NOT-DISMISS feels wrong in retrospect.
  readonly rawOutput: string
}

export async function classifyDismissIntent(rawText: string): Promise<DismissClassification> {
  if (!rawText.trim()) return { dismiss: false, rawOutput: "" }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    system: DISMISS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: rawText }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "NOT-DISMISS"
  const dismiss = text === "DISMISS"
  // Operators debugging "user dismissed but agent kept escalating" need the
  // raw classifier output and the input that produced it. Truncate the input
  // to keep the log line bounded; the classifier is conservative-bias by
  // design so spotting false negatives is more important than false positives.
  console.log(`[DISMISS-CLASSIFIER] dismiss=${dismiss} rawOutput="${text}" input="${rawText.slice(0, 80).replace(/\n/g, " ")}"`)
  return { dismiss, rawOutput: text }
}
