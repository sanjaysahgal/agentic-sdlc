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

  if (/^ok$/i.test(text)) return { status: "ok" }

  // Case-insensitive, handles extra spaces before colon and leading whitespace/newlines
  const conflictMatch = text.match(/^[\s]*CONFLICT\s*:\s*([\s\S]*?)$/im)
  if (conflictMatch) return { status: "conflict", message: conflictMatch[1].trim() }

  const gapMatch = text.match(/^[\s]*GAP\s*:\s*([\s\S]*?)$/im)
  if (gapMatch) return { status: "gap", message: gapMatch[1].trim() }

  // Unexpected format — don't block the save
  return { status: "ok" }
}

// ─── Render ambiguity audit ────────────────────────────────────────────────────
// Identifies elements in a design spec that are too vague for consistent rendering.
// "Consistent" means two independent renderers given the same spec produce the same output.
// Returns an array of specific ambiguity strings; empty array means the spec is render-ready.
// Non-blocking — ambiguities don't prevent save; they surface to the agent as required fixes.

// Deterministic pre-filter: finds screens/sheets/modals referenced in User Flows
// that have no corresponding definition in the ## Screens section.
// No LLM needed — exact substring match is sufficient for structured section names.
function findUndefinedScreenReferences(spec: string): string[] {
  const screensSection = spec.match(/## Screens([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? ""
  const flowsSection = spec.match(/## User Flows([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? ""
  if (!flowsSection) return []

  const refs = new Map<string, string>() // lowercased name → original name
  for (const match of flowsSection.matchAll(/\b([\w][\w\s-]{1,30}?)\s+(screen|sheet|modal|overlay)\b/gi)) {
    refs.set(match[1].trim().toLowerCase(), match[1].trim())
  }

  const missing: string[] = []
  for (const [lower, original] of refs) {
    if (!screensSection.toLowerCase().includes(lower)) {
      missing.push(`"${original}" referenced in User Flows but has no definition in ## Screens section`)
    }
  }
  return missing
}

export async function auditSpecRenderAmbiguity(designSpec: string, options?: { formFactors?: string[] }): Promise<string[]> {
  if (!designSpec) return []

  // Run deterministic check first — catches missing screen definitions without an LLM call
  const undefinedScreens = findUndefinedScreenReferences(designSpec)

  const formFactorCheck = options?.formFactors && options.formFactors.length > 0
    ? `- Layout defined for only one form factor when the spec targets ${options.formFactors.join(", ")}: flag any screen that has layout details but doesn't specify how it adapts across all target form factors`
    : ""

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `You are auditing a design spec for rendering consistency. Identify elements where two different HTML renderers given the same spec would produce different output because the spec doesn't define the value explicitly.

Flag ONLY elements where a renderer must make an unspecified choice:
- Screens with no title/subtitle defined and no explicit "no title" or "no subtitle" statement
- UI element positions described only as relative ("between X and Y", "near the bottom") without exact pixel spacing
- Sheets, modals, or overlays with no entry direction (from bottom, from top, overlay fade-in)
- Sheets, modals, or overlays with no entry/exit animation, timing, or easing specified (e.g. defined as "bottom sheet" but no slide-up animation duration or easing)
- Interactive element text (button labels, chip labels, placeholder text) not defined in the spec
- Animation behavior described vaguely ("smooth transition") without timing values when the spec references an animation
- UI copy that is stated as "TBD", "to be determined", "placeholder", or any equivalent deferral — these are not defined values and cannot be rendered consistently
- Screen states (loading, empty, error) that are named in the state list but have no visual description — named without definition is not defined
- Values that appear with two different specifications within the same spec (e.g. a color token defined as two different hex codes in different sections)
- Language that two renderers would interpret differently: "near the top", "slightly", "subtle", "prominent", "appropriate" used in place of a specific measurement or value${formFactorCheck ? `\n${formFactorCheck}` : ""}
- Suggestion chips or action chips described without a concrete position anchor relative to a fixed layout element: if chips can be interpreted as floating in the vertical center of the screen OR pinned near a fixed element (prompt bar, nav bar, bottom edge), the spec must say which — "horizontal row" alone is ambiguous
- Auth or SSO buttons containing both an icon/logo and label text without specifying their internal horizontal arrangement — flag if the spec does not say how icon and text are positioned relative to each other (e.g. "icon left, text centered", "both centered as a unit with 8px gap"); "full-width stacked" does not resolve this

Do NOT flag:
- General aesthetic descriptions ("minimal", "dark, premium feel")
- Elements that have an explicit "none" or "no X" statement
- Brand token values — color drift is handled by a separate brand auditor
- Implementation details and accessibility notes

Return a JSON array of strings. Each string names one specific ambiguity. If the spec is fully specified for rendering, return: []

Return ONLY the JSON array, no preamble or explanation.`,
    messages: [{ role: "user", content: designSpec }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]"
  let llmAmbiguities: string[] = []
  try {
    const parsed = JSON.parse(text)
    llmAmbiguities = Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
  } catch (e) {
    console.warn(`[auditSpecRenderAmbiguity] JSON parse failed on LLM output: "${text.slice(0, 120)}". Error: ${e instanceof Error ? e.message : String(e)}. Attempting repair...`)
    // Attempt to extract a JSON array from within the output (LLM sometimes adds preamble/postamble)
    const bracketMatch = text.match(/\[\s*([\s\S]*?)\s*\]/)
    if (bracketMatch) {
      try {
        const repaired = JSON.parse(`[${bracketMatch[1]}]`)
        llmAmbiguities = Array.isArray(repaired) ? repaired.filter((s): s is string => typeof s === "string") : []
        console.warn(`[auditSpecRenderAmbiguity] JSON repair succeeded. Extracted ${llmAmbiguities.length} finding(s).`)
      } catch {
        console.warn(`[auditSpecRenderAmbiguity] JSON repair failed. Ambiguities for this audit will be empty.`)
        llmAmbiguities = []
      }
    } else {
      console.warn(`[auditSpecRenderAmbiguity] No bracket-delimited content found in LLM output. Ambiguities will be empty.`)
      llmAmbiguities = []
    }
  }

  return [...undefinedScreens, ...llmAmbiguities]
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

// Extracts design-relevant content (brand tokens, CSS variables, colors, fonts, spacing) from
// raw HTML/CSS fetched from a reference URL. Used by fetch_url tool handler in place of .slice()
// truncation — Haiku reads the raw content and returns only what the design agent needs.
export async function filterDesignContent(rawHtml: string): Promise<string> {
  // Pre-slice only to fit Haiku context — this is an implementation limit of the LLM call,
  // not a silent truncation passed to the design agent. Haiku extracts what matters.
  const input = rawHtml.slice(0, 150_000)

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: `Extract design-relevant content from this HTML/CSS for a design agent extracting brand tokens.

Return ONLY:
- CSS custom properties (--variable: value)
- Color values (#hex, rgb(), hsl(), oklch())
- Font families and font sizes
- Spacing/sizing values that establish the design system
- Design system class names and token definitions

Exclude all HTML content, JavaScript, non-design markup, and boilerplate.
If no design tokens exist, return the most visually relevant CSS rules (max 50 rules).
Return plain text, no JSON wrapping.`,
    messages: [{ role: "user", content: input }],
  })

  return response.content[0].type === "text" ? response.content[0].text.trim() : input
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
