import Anthropic from "@anthropic-ai/sdk"

// 60s timeout, no retries — audit calls process spec content but must not hang.
// A stall surfaces as an error (audits fail-safe to "ok"), not a silent hang.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 0 })

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

  if (/^ok$/i.test(text)) {
    console.log(`[AUDITOR] auditSpecDraft: feature=${featureName} → ok`)
    return { status: "ok" }
  }

  // Case-insensitive, handles extra spaces before colon and leading whitespace/newlines
  const conflictMatch = text.match(/^[\s]*CONFLICT\s*:\s*([\s\S]*?)$/im)
  if (conflictMatch) {
    const result: AuditResult = { status: "conflict", message: conflictMatch[1].trim() }
    console.log(`[AUDITOR] auditSpecDraft: feature=${featureName} → conflict: ${result.message.slice(0, 100)}`)
    return result
  }

  const gapMatch = text.match(/^[\s]*GAP\s*:\s*([\s\S]*?)$/im)
  if (gapMatch) {
    const result: AuditResult = { status: "gap", message: gapMatch[1].trim() }
    console.log(`[AUDITOR] auditSpecDraft: feature=${featureName} → gap: ${result.message.slice(0, 100)}`)
    return result
  }

  // Unexpected format — don't block the save
  console.log(`[AUDITOR] auditSpecDraft: feature=${featureName} → ok (unexpected format)`)
  return { status: "ok" }
}


// ─── Render ambiguity audit ────────────────────────────────────────────────────
// Identifies elements in a design spec that are too vague for consistent rendering.
// "Consistent" means two independent renderers given the same spec produce the same output.
// Returns an array of specific ambiguity strings; empty array means the spec is render-ready.
// Non-blocking — ambiguities don't prevent save; they surface to the agent as required fixes.

// Deterministic copy-completeness check: finds quoted copy literals that are
// structurally incomplete — placeholder brackets, TBD markers, or sentence-case
// narrative strings that don't end with terminal punctuation.
//
// Scope: checks ALL quoted strings for TBD/placeholder markers (universally bad),
// but only checks terminal punctuation for narrative roles (tagline, description,
// subheading, slogan, etc.) — NOT button labels, headings, auth copy, or placeholders.
// This avoids false positives on "Sign in", "Sign in with Google", etc.
// No LLM needed — structural incompleteness is detectable without reasoning.
export function auditCopyCompleteness(spec: string): string[] {
  const issues: string[] = []

  // 1. Placeholder bracket patterns — scan ALL quoted strings since [TBD] anywhere is bad
  const allQuoted = [...spec.matchAll(/"([^"]{2,120})"/g)].map(m => m[1].trim())
  for (const s of allQuoted) {
    if (/\[(?:TBD|placeholder|to be determined|todo|coming soon|insert|fill in)[^\]]*\]/i.test(s)) {
      issues.push(`Copy literal contains placeholder: "${s}" — must be replaced with final text before spec can be approved`)
    }
  }

  // 2. Terminal punctuation — only check narrative copy roles, not button labels or headings.
  // Narrative roles: tagline, subheading, supporting text, description, slogan, hero text, nudge
  // Pattern: <role> "..." or <role>: "..."
  const narrativePattern = /(?:tagline|subheading|supporting[\s-]text|description|slogan|hero[\s-]text|body[\s-]copy|nudge[\s-]?text)\s*:?\s*"([^"]{2,200})"/gi
  for (const match of spec.matchAll(narrativePattern)) {
    const s = match[1].trim()
    // Skip if already flagged as TBD above
    if (/\[(?:TBD|placeholder)[^\]]*\]/i.test(s)) continue
    const hasTerminalPunctuation = /[.!?]$/.test(s)
    if (!hasTerminalPunctuation) {
      issues.push(`Narrative copy missing terminal punctuation: "${s}" — taglines and subheadings are complete sentences and must end with . ! or ?`)
    }
  }

  return issues
}

// Deterministic pre-filter: finds screens/sheets/modals referenced in User Flows
// that have no corresponding definition in the ## Screens section.
// No LLM needed — exact substring match is sufficient for structured section names.
function findUndefinedScreenReferences(spec: string): string[] {
  const screensSection = spec.match(/## Screens([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? ""
  const flowsSection = spec.match(/## User Flows([\s\S]*?)(?:\n## |\n# |$)/)?.[1] ?? ""
  if (!flowsSection) return []

  const refs = new Map<string, string>() // lowercased name → original name
  for (const match of flowsSection.matchAll(/\b([\w][\w \t-]{1,30}?)\s+(screen|sheet|modal|overlay)\b/gi)) {
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

// Deterministic brand-redundancy check: detects when the app name (nav wordmark)
// is repeated in the auth sheet heading — a common polish failure on mobile apps.
// The nav frame already establishes brand context; repeating it in the auth heading
// is redundant and signals amateur-level UX. No LLM needed — pure string match.
export function auditRedundantBranding(spec: string): string[] {
  const issues: string[] = []

  const wordmarkMatch = spec.match(/^[-*]\s*([^\n:]+?)\s+wordmark:/im)
  const wordmark = wordmarkMatch?.[1]?.trim()
  if (!wordmark) return issues

  for (const match of spec.matchAll(/[Hh]eading:\s*"([^"]+)"/g)) {
    const heading = match[1].trim()
    if (heading.toLowerCase().includes(wordmark.toLowerCase())) {
      issues.push(
        `Auth heading "${heading}" repeats the app name already shown in the nav wordmark — ` +
        `redundant: the nav bar already establishes brand context. ` +
        `Replace with copy that adds meaning: e.g. "Welcome back" or "Sign in".`
      )
    }
  }

  return issues
}

export async function auditSpecRenderAmbiguity(designSpec: string, options?: { formFactors?: string[] }): Promise<string[]> {
  if (!designSpec) return []

  // Run deterministic checks first — no LLM call needed
  const undefinedScreens = findUndefinedScreenReferences(designSpec)
  const copyIssues = auditCopyCompleteness(designSpec)
  const brandingIssues = auditRedundantBranding(designSpec)

  const formFactorCheck = options?.formFactors && options.formFactors.length > 0
    ? `- Layout defined for only one form factor when the spec targets ${options.formFactors.join(", ")}: flag any screen that has layout details but doesn't specify how it adapts across all target form factors`
    : ""

  // Two-pass design: Pass 1 identifies issues, Pass 2 generates recommendations.
  // Structural enforcement: recommendations are produced by a call designed only to answer
  // "what would you do?" — structurally cannot produce hedges. No pattern-matching needed.

  // Pass 1 — identify genuine render ambiguities (issues only, no recommendations)
  const issuesResponse = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: `You are a senior UX designer reviewing a design spec. Identify elements where a developer implementing from this spec would be genuinely stuck — forced to make a visual choice with no right answer because the spec doesn't define it.

Only flag elements where two competent developers would make different choices. Do not flag elements with a single obvious interpretation or where standard defaults apply.

Flag ONLY:
- Screens with no title/subtitle defined and no explicit "no title" or "no subtitle" statement
- UI element positions described only as relative without exact pixel spacing
- Sheets, modals, or overlays with no entry direction or animation timing/easing specified
- Interactive element text (button labels, chip labels, placeholder text) not defined
- Animation behavior described vaguely without timing values
- UI copy stated as "TBD", "to be determined", "placeholder", or any deferral
- Screen states named in the state list but with no visual description
- Values appearing with two different specifications within the same spec
- Language two developers would implement differently: "near the top", "slightly", "subtle", "prominent"${formFactorCheck ? `\n${formFactorCheck}` : ""}
- Suggestion chips or action chips with no concrete position anchor
- Auth or SSO buttons with no internal icon+text arrangement specified
- Grammatically incomplete user-facing copy (sentence-case strings ending mid-thought)

Design quality gaps (same severity):
- Horizontally scrollable rows with no scrollbar treatment
- Dynamic content areas with no empty state defined
- Primary interactive elements with no minimum touch target size
- Copy redundantly restating visually established context

Do NOT flag: general aesthetics, elements with explicit "none" statements, brand token values, implementation details, scrollbar treatment when explicitly specified, empty state when screen is always-populated.

Return a JSON array of issue strings only. Each issue ≤15 words. If the spec is fully specified, return: []
Return ONLY the JSON array, no preamble.`,
    messages: [{ role: "user", content: designSpec }],
  })

  const parseJsonArray = (raw: string, label: string): string[] => {
    const text = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim()
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
    } catch {
      const bracketMatch = text.match(/\[[\s\S]*\]/)
      if (bracketMatch) {
        try { return JSON.parse(bracketMatch[0]).filter((s: unknown): s is string => typeof s === "string") } catch {}
      }
      console.warn(`[auditSpecRenderAmbiguity] ${label}: JSON parse failed, returning []`)
      return []
    }
  }

  const issues = parseJsonArray(
    issuesResponse.content[0].type === "text" ? issuesResponse.content[0].text : "[]",
    "pass1"
  )

  if (issues.length === 0) {
    const findings = [...undefinedScreens, ...copyIssues, ...brandingIssues]
    console.log(`[AUDITOR] auditSpecRenderAmbiguity: ${findings.length} finding(s) (screens=${undefinedScreens.length} copy=${copyIssues.length} branding=${brandingIssues.length} llm=0)`)
    return findings
  }

  // Pass 2 — generate opinionated recommendation for each issue.
  // This call only answers "what would you do?" — structurally produces decisions, not analysis.
  const recsResponse = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1000,
    system: `You are a senior UX designer with decades of experience. For each issue listed, state exactly what you would specify — one concrete action. You are giving direction to a developer who is waiting to implement.

Return a JSON array of recommendation strings, one per issue, in the same order. Each recommendation ≤12 words. Imperative: "align left edge to username", "use slide-up 280ms ease-out", "set to --muted token".
Return ONLY the JSON array.`,
    messages: [{ role: "user", content: issues.map((issue, i) => `${i + 1}. ${issue}`).join("\n") }],
  })

  const recommendations = parseJsonArray(
    recsResponse.content[0].type === "text" ? recsResponse.content[0].text : "[]",
    "pass2"
  )

  const llmAmbiguities = issues.map((issue, i) => `${issue} — ${recommendations[i] ?? "specify explicitly in spec"}`)

  const findings = [...undefinedScreens, ...copyIssues, ...brandingIssues, ...llmAmbiguities]
  console.log(`[AUDITOR] auditSpecRenderAmbiguity: ${findings.length} finding(s) (screens=${undefinedScreens.length} copy=${copyIssues.length} branding=${brandingIssues.length} llm=${llmAmbiguities.length})`)
  findings.forEach((f, i) => console.log(`[AUDITOR] auditSpecRenderAmbiguity[${i + 1}]: ${f}`))
  return findings
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

  if (text === "OK" || !text.includes("MISMATCH:")) {
    console.log(`[AUDITOR] auditSpecDecisions: ok`)
    return { status: "ok" }
  }

  const corrections: DecisionCorrection[] = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("MISMATCH:")) continue
    const parts = line.replace("MISMATCH:", "").split("|").map(s => s.trim())
    if (parts.length === 3) {
      corrections.push({ description: parts[0], found: parts[1], correct: parts[2] })
    }
  }

  if (corrections.length === 0) {
    console.log(`[AUDITOR] auditSpecDecisions: ok`)
    return { status: "ok" }
  }
  console.log(`[AUDITOR] auditSpecDecisions: ${corrections.length} correction(s)`)
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
  if (text === "none" || !text.includes("•")) {
    console.log(`[AUDITOR] extractLockedDecisions: none`)
    return ""
  }
  const count = (text.match(/•/g) ?? []).length
  console.log(`[AUDITOR] extractLockedDecisions: ${count} decision(s)`)
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
