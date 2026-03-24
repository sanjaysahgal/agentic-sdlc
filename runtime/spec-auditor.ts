import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export type AuditResult =
  | { status: "ok" }
  | { status: "conflict"; message: string }
  | { status: "gap"; message: string }

// Audits a spec draft against product vision and system architecture.
// Runs before every draft save — if a conflict or gap is found, the draft is
// NOT saved and the issue is surfaced to the human instead.
//
// conflict = draft says something that contradicts vision or architecture
// gap      = draft implies something the vision/architecture doesn't address
//            (not necessarily wrong — needs a human decision before proceeding)
export async function auditSpecDraft(params: {
  draft: string
  productVision: string
  systemArchitecture: string
  featureName: string
  productSpec?: string   // Feature-level approved product spec — checked in addition to platform vision
}): Promise<AuditResult> {
  const { draft, productVision, systemArchitecture, featureName, productSpec } = params

  if (!productVision && !systemArchitecture && !productSpec) return { status: "ok" }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `You are a spec auditor. Your job is to check a feature spec draft against a product vision, system architecture, and approved product spec.

You are looking for two things:
1. CONFLICT — the draft explicitly contradicts something in the product vision, architecture, or approved product spec (e.g. proposes password auth when vision says SSO only, or proposes dark-mode-only when the product spec says light-mode-default)
2. GAP — the draft implies or assumes something that none of the source documents address (e.g. assumes a native mobile app exists when the vision only describes web)

IMPORTANT: If the draft already documents the gap as an open question in its "Open Questions" section (tagged [type: engineering] or [type: product]), respond with OK — the gap has been acknowledged by the team and does not need to be re-flagged.

If neither is found, respond with exactly: OK

If a conflict is found, respond with:
CONFLICT: <one sentence naming the specific contradiction and which documents it comes from>

If a gap is found (and it is NOT already in the Open Questions section), respond with:
GAP: <one sentence naming what the draft assumes that is not covered, and what decision needs to be made>

Only flag real issues. Do not flag vague or speculative concerns. One issue at a time — the most important one.`,
    messages: [
      {
        role: "user",
        content: `Feature: ${featureName}

## Product Vision
${productVision || "Not defined."}

## System Architecture
${systemArchitecture || "Not defined."}
${productSpec ? `\n## Approved Product Spec\n${productSpec}` : ""}

## Draft Spec
${draft}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "OK"

  if (text === "OK") return { status: "ok" }

  if (text.startsWith("CONFLICT:")) {
    return { status: "conflict", message: text.replace("CONFLICT:", "").trim() }
  }

  if (text.startsWith("GAP:")) {
    return { status: "gap", message: text.replace("GAP:", "").trim() }
  }

  // Unexpected format — don't block the save
  return { status: "ok" }
}

// ─── Decision audit ────────────────────────────────────────────────────────────
// Checks a final spec against the decisions explicitly locked during the
// conversation (e.g. "Locked. Glow opacity 10%"). If any locked value
// appears differently in the spec, the correction is returned so it can be
// applied before saving — no silent divergence between what was agreed and
// what gets committed.

export type DecisionCorrection = {
  description: string  // human-readable label, e.g. "Glow opacity"
  found: string        // exact string as it appears in the spec
  correct: string      // agreed value
}

export type DecisionAuditResult =
  | { status: "ok" }
  | { status: "corrections"; corrections: DecisionCorrection[] }

export async function auditSpecDecisions(params: {
  specContent: string
  history: Array<{ role: string; content: string }>
}): Promise<DecisionAuditResult> {
  const { specContent, history } = params

  // Need at least a few turns to have anything worth auditing
  if (history.length < 2) return { status: "ok" }

  // Use the last 30 messages — enough to capture all locked decisions without
  // blowing through context on very long threads
  const recentHistory = history.slice(-30)
  const historyText = recentHistory
    .map(m => `${m.role === "user" ? "Human" : "Agent"}: ${m.content}`)
    .join("\n\n")

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: `You are auditing a spec document against decisions that were explicitly locked during a conversation.

Look through the conversation for values that were clearly agreed or "locked" — e.g. "Locked. Glow opacity 10%", "we agreed X", "confirmed: Y is Z", explicit affirmations of a specific value.

Then check if those exact values appear correctly in the spec.

For each mismatch — where a locked value appears DIFFERENTLY in the spec — output exactly one line:
MISMATCH: <short description> | <exact text as written in spec> | <correct agreed value>

The "exact text as written in spec" must be a substring that appears verbatim in the spec so it can be found and replaced. Keep it as short and specific as possible while still being unique.

If no mismatches are found, output exactly: OK

Only flag concrete, specific value mismatches — numbers, named choices, specific strings. Not tone, style, or vague differences. High confidence only.`,
    messages: [
      {
        role: "user",
        content: `## Conversation History (most recent ${recentHistory.length} messages)
${historyText}

## Spec Content
${specContent}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "OK"

  if (text === "OK" || !text.includes("MISMATCH:")) return { status: "ok" }

  const corrections: DecisionCorrection[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("MISMATCH:")) continue
    const parts = line.replace("MISMATCH:", "").split("|").map(s => s.trim())
    if (parts.length === 3) {
      corrections.push({ description: parts[0], found: parts[1], correct: parts[2] })
    }
  }

  if (corrections.length === 0) return { status: "ok" }
  return { status: "corrections", corrections }
}

// Extracts explicitly locked decisions from conversation history.
// Runs before every agent call when history is long enough to have drift risk.
// Returns a formatted bullet list, or empty string if nothing is locked yet.
// Injected into the user message so the agent can't "forget" earlier decisions.
export async function extractLockedDecisions(history: Array<{ role: string; content: string }>): Promise<string> {
  // Not enough exchanges to have drift risk
  if (history.length < 6) return ""

  const recentHistory = history.slice(-40)
  const historyText = recentHistory
    .map(m => `${m.role === "user" ? "Human" : "Agent"}: ${m.content}`)
    .join("\n\n")

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract explicitly locked decisions from this conversation.

A decision is locked when a human clearly confirmed a specific choice — "yes", "go with that", "lock it in", "confirmed", or a clear affirmation after an agent proposed something specific.

Output one bullet per locked decision, like:
• Dark mode primary, light secondary
• Glow opacity: 10%
• Archon Labs aesthetic — dark backgrounds, gradient accents

Keep each bullet concise. Only include decisions that are clearly and explicitly confirmed — not proposals, options being discussed, or open questions.

If fewer than 2 decisions are clearly locked, output: none`,
    messages: [{ role: "user", content: historyText }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "none"
  if (text === "none" || !text.includes("•")) return ""
  return text
}

// Applies decision corrections to a spec string via direct text replacement.
// Returns the corrected spec and a list of corrections that were actually applied.
export function applyDecisionCorrections(specContent: string, corrections: DecisionCorrection[]): {
  corrected: string
  applied: DecisionCorrection[]
} {
  let corrected = specContent
  const applied: DecisionCorrection[] = []
  for (const c of corrections) {
    if (corrected.includes(c.found)) {
      corrected = corrected.split(c.found).join(c.correct)
      applied.push(c)
    }
  }
  return { corrected, applied }
}
