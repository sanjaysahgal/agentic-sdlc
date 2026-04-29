/**
 * Deterministic spec auditors — Principle 11.
 *
 * Every function in this file is @deterministic: same input → same output, always.
 * No LLM calls. No probabilistic evaluation. Pure parsing, counting, and matching.
 *
 * These replace `auditPhaseCompletion` as the PRIMARY gate for readiness checks.
 * The LLM rubric layer (`auditPhaseCompletion`) remains as @enrichment — it runs
 * in parallel and surfaces additional findings, but never gates decisions.
 */

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

export type DeterministicFinding = {
  criterion: string   // which check produced this (e.g. "VAGUE_LANGUAGE", "OPEN_QUESTIONS")
  issue: string       // specific finding
  recommendation: string  // opinionated fix
}

export type DeterministicAuditResult = {
  ready: boolean
  findings: DeterministicFinding[]
}

// ────────────────────────────────────────────────────────────────────────────────
// Shared constants
// ────────────────────────────────────────────────────────────────────────────────

/** Words that make acceptance criteria non-testable. Used across PM + design audits. */
export const VAGUE_WORDS = [
  "soft", "non-intrusive", "proactively", "ambient", "seamlessly", "minimal",
  "appropriate", "subtle", "smooth", "seamless", "clean", "polished", "gentle",
  "quiet", "unobtrusive", "friendly", "clear", "warm", "elegant", "natural",
  "nice", "fast", "easy", "good", "improve",
]

/** Timing words without numeric values. */
export const VAGUE_TIMING = [
  "quickly", "immediately", "eventually", "after some time", "after inactivity",
]

/** Error behavior phrases that need specific UI treatment. */
export const VAGUE_ERROR_PHRASES = [
  "handle gracefully", "show an error", "notify the user", "display a warning",
  "surface a message", "errors are shown", "errors are handled",
]

/** Deferral markers that block any spec from approval. */
export const DEFERRAL_MARKERS = [
  "TBD", "TODO", "PLACEHOLDER", "to be determined", "to be decided",
  "to come", "to be defined", "tbd", "todo",
]

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

/** Extract the body text of a ## section (everything between ## heading and next ## or EOF). */
export function extractSection(content: string, heading: string): string {
  // Find the heading line, then capture everything until the next ## heading or end of string
  const lines = content.split("\n")
  const headingPrefix = `## ${heading}`
  let startIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(headingPrefix)) {
      startIdx = i + 1
      break
    }
  }
  if (startIdx === -1) return ""
  const bodyLines: string[] = []
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break
    bodyLines.push(lines[i])
  }
  return bodyLines.join("\n").trim()
}

/** Extract all ## section headings from a spec. */
export function extractSectionHeadings(content: string): string[] {
  return (content.match(/^## .+/gm) ?? []).map(h => h.replace(/^## /, "").trim())
}

/** Extract all ### subsection headings from a section body. */
export function extractSubsectionHeadings(sectionBody: string): string[] {
  return (sectionBody.match(/^### .+/gm) ?? []).map(h => h.replace(/^### /, "").trim())
}

/** Check if a line contains any word from a list (case-insensitive, word-boundary). */
export function containsVagueWord(line: string, words: string[]): string | null {
  const lower = line.toLowerCase()
  for (const word of words) {
    // Word boundary match to avoid false positives (e.g. "clear" in "clearTimeout")
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
    if (re.test(lower)) return word
  }
  return null
}

/** Extract numbered items from a section (lines starting with number + dot or dash). */
export function extractNumberedItems(section: string): string[] {
  return section.split("\n")
    .filter(l => /^\s*(\d+[\.\)]\s|[-*]\s)/.test(l))
    .map(l => l.replace(/^\s*(\d+[\.\)]\s|[-*]\s)/, "").trim())
}

/** Extract user stories from ## User Stories section. */
export function extractUserStories(content: string): Array<{ id: string; text: string }> {
  const section = extractSection(content, "User Stories")
  if (!section) return []
  const stories: Array<{ id: string; text: string }> = []
  const lines = section.split("\n")
  for (const line of lines) {
    const match = line.match(/^[-*]\s*(US-?\d+|User Story \d+|Story \d+)[:\s]+(.*)/i)
      ?? line.match(/^\s*(\d+)[\.\)]\s+(.*)/)
    if (match) {
      stories.push({ id: match[1], text: match[2].trim() })
    }
  }
  return stories
}

/** Extract screen definitions from ## Screens section. Returns screen name → body. */
export function extractScreens(content: string): Map<string, string> {
  const screensSection = extractSection(content, "Screens")
  if (!screensSection) return new Map()
  const screens = new Map<string, string>()
  const screenBlocks = screensSection.split(/(?=^### )/m)
  for (const block of screenBlocks) {
    const heading = block.match(/^### (.+)/m)
    if (heading) {
      screens.set(heading[1].trim(), block)
    }
  }
  return screens
}

/** Extract API endpoints from ## API Contracts section. */
export function extractEndpoints(content: string): Array<{ method: string; path: string; body: string }> {
  const section = extractSection(content, "API Contracts")
  if (!section) return []
  const endpoints: Array<{ method: string; path: string; body: string }> = []
  const blocks = section.split(/(?=^### )/m)
  for (const block of blocks) {
    const heading = block.match(/^### (GET|POST|PUT|PATCH|DELETE)\s+(\S+)/im)
    if (heading) {
      endpoints.push({ method: heading[1].toUpperCase(), path: heading[2], body: block })
    }
  }
  return endpoints
}

/** Extract data model entities from ## Data Model section. */
export function extractEntities(content: string): Array<{ name: string; body: string }> {
  const section = extractSection(content, "Data Model")
  if (!section) return []
  const entities: Array<{ name: string; body: string }> = []
  const blocks = section.split(/(?=^### )/m)
  for (const block of blocks) {
    const heading = block.match(/^### (.+)/m)
    if (heading) {
      entities.push({ name: heading[1].trim(), body: block })
    }
  }
  return entities
}

// ────────────────────────────────────────────────────────────────────────────────
// PM Spec Audit (@deterministic)
// Replaces: auditPhaseCompletion(PM_RUBRIC) + auditPhaseCompletion(ARCHITECT_UPSTREAM_PM_RUBRIC)
// ────────────────────────────────────────────────────────────────────────────────

/** @deterministic */
export function auditPmSpec(specContent: string): DeterministicAuditResult {
  const findings: DeterministicFinding[] = []

  // Criterion: NO OPEN QUESTIONS (PM_RUBRIC #3, ARCH_PM #2)
  const openQuestionsSection = extractSection(specContent, "Open Questions")
  if (openQuestionsSection) {
    const questions = openQuestionsSection.split("\n")
      .filter(l => l.includes("[blocking:"))
    for (const q of questions) {
      findings.push({
        criterion: "OPEN_QUESTIONS",
        issue: `Open question not resolved: ${q.replace(/^[-*]\s*/, "").trim()}`,
        recommendation: "Resolve this question and remove it from ## Open Questions before approval.",
      })
    }
  }

  // Criterion: MEASURABLE ACCEPTANCE CRITERIA (PM_RUBRIC #2)
  const acSection = extractSection(specContent, "Acceptance Criteria")
  if (acSection) {
    const acLines = acSection.split("\n").filter(l => /^\s*[-*]\s|^\s*\d+[\.\)]/.test(l))
    for (const line of acLines) {
      const vagueWord = containsVagueWord(line, VAGUE_WORDS)
      if (vagueWord) {
        const acId = line.match(/(AC#?\d+)/)?.[1] ?? "AC"
        findings.push({
          criterion: "VAGUE_LANGUAGE",
          issue: `${acId} uses vague language: "${vagueWord}" — two implementers would interpret this differently.`,
          recommendation: `Replace "${vagueWord}" with a concrete, measurable criterion.`,
        })
      }
      const vagueTiming = containsVagueWord(line, VAGUE_TIMING)
      if (vagueTiming) {
        const acId = line.match(/(AC#?\d+)/)?.[1] ?? "AC"
        findings.push({
          criterion: "VAGUE_TIMING",
          issue: `${acId} uses undefined timing: "${vagueTiming}" without a numeric value in seconds or minutes.`,
          recommendation: `Replace "${vagueTiming}" with a specific duration (e.g. "within 200ms", "after 60 seconds of inactivity").`,
        })
      }
      const vagueError = VAGUE_ERROR_PHRASES.find(p => line.toLowerCase().includes(p))
      if (vagueError) {
        const acId = line.match(/(AC#?\d+)/)?.[1] ?? "AC"
        findings.push({
          criterion: "VAGUE_ERROR_BEHAVIOR",
          issue: `${acId} uses vague error behavior: "${vagueError}" without specifying UI treatment.`,
          recommendation: `Replace with specific UI treatment: modal, inline text, toast, or banner — with exact copy.`,
        })
      }
    }
  }

  // Criterion: NO DEFERRAL MARKERS
  for (const marker of DEFERRAL_MARKERS) {
    const re = new RegExp(`\\b${marker}\\b`, "gi")
    const matches = specContent.match(re)
    if (matches && matches.length > 0) {
      findings.push({
        criterion: "DEFERRAL_MARKERS",
        issue: `Spec contains "${marker}" (${matches.length} occurrence${matches.length > 1 ? "s" : ""}) — deferred decisions block approval.`,
        recommendation: `Resolve every "${marker}" with a concrete decision or remove the item.`,
      })
    }
  }

  // Criterion: NON-GOALS COMPLETENESS (PM_RUBRIC #6)
  const nonGoals = extractSection(specContent, "Non-Goals")
  if (!nonGoals || nonGoals.length < 20) {
    findings.push({
      criterion: "NON_GOALS",
      issue: "## Non-Goals is empty or too brief — a reasonable engineer might include scope that should be excluded.",
      recommendation: "Add at least one explicit scope exclusion that prevents scope creep.",
    })
  }

  console.log(`[AUDITOR] auditPmSpec: ${findings.length} finding(s)`)
  findings.forEach((f, i) => console.log(`[AUDITOR] auditPmSpec[${i + 1}]: [${f.criterion}] ${f.issue.slice(0, 120)}`))

  return { ready: findings.length === 0, findings }
}

// ────────────────────────────────────────────────────────────────────────────────
// PM Design-Readiness Audit (@deterministic)
// Replaces: auditPhaseCompletion(PM_DESIGN_READINESS_RUBRIC)
// ────────────────────────────────────────────────────────────────────────────────

/** @deterministic */
export function auditPmDesignReadiness(specContent: string): DeterministicAuditResult {
  const findings: DeterministicFinding[] = []

  // All PM spec checks apply
  const pmFindings = auditPmSpec(specContent)
  findings.push(...pmFindings.findings)

  // Criterion: VAGUE LANGUAGE — broader scan across User Stories and Edge Cases
  for (const sectionName of ["User Stories", "Edge Cases"]) {
    const section = extractSection(specContent, sectionName)
    if (!section) continue
    const lines = section.split("\n").filter(l => l.trim().length > 10)
    for (const line of lines) {
      const vagueWord = containsVagueWord(line, VAGUE_WORDS)
      if (vagueWord) {
        findings.push({
          criterion: "VAGUE_LANGUAGE",
          issue: `## ${sectionName} uses vague language: "${vagueWord}" — a designer would need clarification.`,
          recommendation: `Replace "${vagueWord}" with a specific, observable behavior.`,
        })
      }
    }
  }

  // Criterion: LOADING AND TRANSITION STATES — check for async operations without loading treatment
  const acSection = extractSection(specContent, "Acceptance Criteria")
  const userStories = extractSection(specContent, "User Stories")
  const combined = `${acSection}\n${userStories}`
  const asyncPatterns = ["sign-in", "sign-up", "auth", "load", "fetch", "create account", "resolve", "redirect"]
  for (const pattern of asyncPatterns) {
    if (combined.toLowerCase().includes(pattern)) {
      // Check if loading/transition behavior is specified anywhere in the spec
      const hasLoadingSpec = specContent.toLowerCase().includes("loading") ||
        specContent.toLowerCase().includes("skeleton") ||
        specContent.toLowerCase().includes("spinner") ||
        specContent.toLowerCase().includes("progress")
      if (!hasLoadingSpec) {
        findings.push({
          criterion: "LOADING_STATES",
          issue: `Spec references async operation "${pattern}" but never specifies loading treatment.`,
          recommendation: "Define what users see during async operations: skeleton, spinner, progress indicator, or optimistic render.",
        })
        break  // One finding is enough to flag the gap
      }
    }
  }

  // Deduplicate findings by issue text
  const seen = new Set<string>()
  const deduped = findings.filter(f => {
    if (seen.has(f.issue)) return false
    seen.add(f.issue)
    return true
  })

  console.log(`[AUDITOR] auditPmDesignReadiness: ${deduped.length} finding(s)`)
  deduped.forEach((f, i) => console.log(`[AUDITOR] auditPmDesignReadiness[${i + 1}]: [${f.criterion}] ${f.issue.slice(0, 120)}`))

  return { ready: deduped.length === 0, findings: deduped }
}

// ────────────────────────────────────────────────────────────────────────────────
// Design Spec Audit (@deterministic)
// Replaces: auditPhaseCompletion(buildDesignRubric)
// ────────────────────────────────────────────────────────────────────────────────

/** @deterministic */
export function auditDesignSpec(specContent: string, params: {
  targetFormFactors?: string[]
  brandContent?: string
} = {}): DeterministicAuditResult {
  const { targetFormFactors = [], brandContent } = params
  const findings: DeterministicFinding[] = []

  // Criterion: NO OPEN QUESTIONS (DESIGN #11)
  const openQuestionsSection = extractSection(specContent, "Open Questions")
  if (openQuestionsSection) {
    const questions = openQuestionsSection.split("\n")
      .filter(l => l.includes("[blocking:"))
    for (const q of questions) {
      findings.push({
        criterion: "OPEN_QUESTIONS",
        issue: `Open question not resolved: ${q.replace(/^[-*]\s*/, "").trim()}`,
        recommendation: "Resolve this question and remove it from ## Open Questions.",
      })
    }
  }

  // Criterion: NO TBD/TODO/PLACEHOLDER (DESIGN #8)
  for (const marker of DEFERRAL_MARKERS) {
    const re = new RegExp(`\\b${marker}\\b`, "gi")
    const matches = specContent.match(re)
    if (matches && matches.length > 0) {
      findings.push({
        criterion: "DEFERRAL_MARKERS",
        issue: `Spec contains "${marker}" (${matches.length} occurrence${matches.length > 1 ? "s" : ""}).`,
        recommendation: `Replace every "${marker}" with a concrete design decision.`,
      })
    }
  }

  // Criterion: NO VAGUE LANGUAGE (DESIGN #6)
  const screens = extractScreens(specContent)
  for (const [screenName, screenBody] of screens) {
    const lines = screenBody.split("\n").filter(l => l.trim().length > 10)
    for (const line of lines) {
      const vagueWord = containsVagueWord(line, [
        "near the top", "slightly rounded", "prominent", "subtle",
        "appropriate spacing", "reasonable margin", ...VAGUE_WORDS,
      ])
      if (vagueWord) {
        findings.push({
          criterion: "VAGUE_LANGUAGE",
          issue: `${screenName}: uses vague language "${vagueWord}" — two engineers would interpret differently.`,
          recommendation: `Replace "${vagueWord}" with a specific value (px, rem, token, or exact description).`,
        })
      }
    }
  }

  // Criterion: ANIMATION TIMING AND EASING (DESIGN #4)
  const animationKeywords = ["animated", "animation", "slides", "fades", "transitions", "entry animation", "exit animation"]
  for (const [screenName, screenBody] of screens) {
    for (const keyword of animationKeywords) {
      if (screenBody.toLowerCase().includes(keyword)) {
        // Check if timing is specified (must have ms or s duration)
        const hasTimingSpec = /\d+\s*ms|\d+(\.\d+)?\s*s\b/.test(screenBody)
        const hasEasing = /ease[-\s]?(in|out|in-out)|cubic-bezier|linear/i.test(screenBody)
        if (!hasTimingSpec) {
          findings.push({
            criterion: "ANIMATION_TIMING",
            issue: `${screenName}: mentions "${keyword}" but no duration in ms/s specified.`,
            recommendation: `Add explicit duration (e.g. "300ms") and easing function for every animation.`,
          })
          break  // One per screen
        }
        if (!hasEasing) {
          findings.push({
            criterion: "ANIMATION_EASING",
            issue: `${screenName}: has animation duration but no easing function specified.`,
            recommendation: `Add easing function (e.g. "ease-out", "cubic-bezier(0.4, 0, 0.2, 1)").`,
          })
          break
        }
      }
    }
  }

  // Criterion: FORM FACTOR COVERAGE (DESIGN #9)
  if (targetFormFactors.length > 1) {
    for (const [screenName, screenBody] of screens) {
      for (const ff of targetFormFactors) {
        if (!screenBody.toLowerCase().includes(ff.toLowerCase())) {
          // Check Non-Goals for explicit exclusion
          const nonGoals = extractSection(specContent, "Non-Goals")
          if (!nonGoals.toLowerCase().includes(ff.toLowerCase())) {
            findings.push({
              criterion: "FORM_FACTOR_COVERAGE",
              issue: `${screenName}: no layout defined for "${ff}" form factor.`,
              recommendation: `Define ${ff} layout for this screen, or explicitly exclude ${ff} in ## Non-Goals.`,
            })
          }
        }
      }
    }
  }

  // Criterion: ALL UI COPY SPECIFIED (DESIGN #3) — check for missing copy indicators
  for (const [screenName, screenBody] of screens) {
    // Look for common patterns that indicate missing copy
    if (/copy\s*(to be|TBD|TODO)/i.test(screenBody) ||
        /label:\s*$/m.test(screenBody) ||
        /text:\s*$/m.test(screenBody) ||
        /heading:\s*$/m.test(screenBody)) {
      findings.push({
        criterion: "MISSING_COPY",
        issue: `${screenName}: contains unspecified UI copy (empty label/text/heading or "TBD" copy).`,
        recommendation: "Define every text string verbatim — button labels, headings, body copy, error messages.",
      })
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  const deduped = findings.filter(f => {
    const key = `${f.criterion}:${f.issue}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  console.log(`[AUDITOR] auditDesignSpec: ${deduped.length} finding(s)`)
  deduped.forEach((f, i) => console.log(`[AUDITOR] auditDesignSpec[${i + 1}]: [${f.criterion}] ${f.issue.slice(0, 120)}`))

  return { ready: deduped.length === 0, findings: deduped }
}

// ────────────────────────────────────────────────────────────────────────────────
// Engineering Spec Audit (@deterministic)
// Replaces: auditPhaseCompletion(ENGINEER_RUBRIC)
// ────────────────────────────────────────────────────────────────────────────────

/** @deterministic */
export function auditEngineeringSpec(specContent: string): DeterministicAuditResult {
  const findings: DeterministicFinding[] = []

  // Criterion: NO OPEN QUESTIONS (ENGINEER #6)
  const openQuestionsSection = extractSection(specContent, "Open Questions")
  if (openQuestionsSection) {
    const questions = openQuestionsSection.split("\n")
      .filter(l => l.includes("[blocking:"))
    for (const q of questions) {
      findings.push({
        criterion: "OPEN_QUESTIONS",
        issue: `Open question not resolved: ${q.replace(/^[-*]\s*/, "").trim()}`,
        recommendation: "Resolve this question and remove it from ## Open Questions.",
      })
    }
  }

  // Criterion: NO DEFERRAL MARKERS
  for (const marker of DEFERRAL_MARKERS) {
    const re = new RegExp(`\\b${marker}\\b`, "gi")
    const matches = specContent.match(re)
    if (matches && matches.length > 0) {
      findings.push({
        criterion: "DEFERRAL_MARKERS",
        issue: `Spec contains "${marker}" (${matches.length} occurrence${matches.length > 1 ? "s" : ""}).`,
        recommendation: `Replace every "${marker}" with a concrete engineering decision.`,
      })
    }
  }

  // Criterion: API CONTRACTS (ENGINEER #1)
  const endpoints = extractEndpoints(specContent)
  if (endpoints.length === 0) {
    const hasApiSection = specContent.includes("## API Contracts") || specContent.includes("## API")
    if (hasApiSection) {
      findings.push({
        criterion: "API_CONTRACTS",
        issue: "## API Contracts section exists but no endpoints defined with HTTP method + path.",
        recommendation: "Define at least one endpoint with ### METHOD /path format.",
      })
    }
  }
  for (const ep of endpoints) {
    // Check for request/response shape — look for field definitions (names with types, or JSON-like shapes)
    const hasRequestShape = /request|body|params|query/i.test(ep.body) && /\w+:\s*\w+|{[^}]+}/i.test(ep.body)
    const hasResponseShape = /response|return|status/i.test(ep.body) && /\w+:\s*\w+|{[^}]+}|\d{3}/i.test(ep.body)
    if (!hasRequestShape && !["GET", "DELETE"].includes(ep.method)) {
      findings.push({
        criterion: "API_CONTRACTS",
        issue: `${ep.method} ${ep.path}: no request body/params with field names and types defined.`,
        recommendation: "Define request fields with names and types.",
      })
    }
    if (!hasResponseShape) {
      findings.push({
        criterion: "API_CONTRACTS",
        issue: `${ep.method} ${ep.path}: no response shape with field names and types defined.`,
        recommendation: "Define response fields with names and types.",
      })
    }
    // Criterion: AUTH ON EVERY ENDPOINT (ENGINEER #4)
    const hasAuth = /auth|bearer|token|role|permission|public|unauthenticated|none.*auth/i.test(ep.body)
    if (!hasAuth) {
      findings.push({
        criterion: "ENDPOINT_AUTH",
        issue: `${ep.method} ${ep.path}: no authentication/authorization requirement stated.`,
        recommendation: "State which role or condition allows access, or explicitly mark as public/unauthenticated.",
      })
    }
  }

  // Criterion: DATA MODEL (ENGINEER #2)
  const entities = extractEntities(specContent)
  for (const entity of entities) {
    // Check for field definitions (must have field names, not just entity name)
    // Accepts: bullet lists with field names, table rows, or "field: type" patterns
    const hasFields = /\bfield|column|attribute|\|.*\|.*\|/i.test(entity.body) ||
      entity.body.split("\n").filter(l => /^\s*[-*]\s*`?\w+`?[:\s]/.test(l)).length >= 2 ||
      (entity.body.match(/\w+:\s*(uuid|string|text|integer|boolean|timestamp|jsonb?|bigint|serial)/gi) ?? []).length >= 2
    if (!hasFields) {
      findings.push({
        criterion: "DATA_MODEL",
        issue: `Data model entity "${entity.name}": no fields defined — only entity name without field list.`,
        recommendation: "List each field with name and type.",
      })
    }
  }

  // Criterion: MIGRATION STRATEGY (ENGINEER #5)
  const hasSchemaChanges = entities.length > 0
  if (hasSchemaChanges) {
    const hasMigration = /migration|migrate|backfill|additive|alter table|add column/i.test(specContent)
    if (!hasMigration) {
      findings.push({
        criterion: "MIGRATION_STRATEGY",
        issue: "Data model defines entities but no migration strategy documented.",
        recommendation: "Document migration approach: additive migration, backfill strategy, or explicit 'greenfield — no migration needed'.",
      })
    }
  }

  console.log(`[AUDITOR] auditEngineeringSpec: ${findings.length} finding(s)`)
  findings.forEach((f, i) => console.log(`[AUDITOR] auditEngineeringSpec[${i + 1}]: [${f.criterion}] ${f.issue.slice(0, 120)}`))

  return { ready: findings.length === 0, findings }
}

// ────────────────────────────────────────────────────────────────────────────────
// Universal Hedge / Deferral Detection (@deterministic)
// Replaces: prompt-dependent hedge detection across all agents
// ────────────────────────────────────────────────────────────────────────────────

/** Deferral phrases that agents should never use — they defer to the user instead of recommending. */
export const DEFERRAL_PHRASES = [
  "what would you like to focus on",
  "which option do you prefer",
  "what do you think",
  "how would you like to proceed",
  "what approach would you prefer",
  "let me know what you'd like",
  "what would you like me to",
  "shall I",
  "would you like me to",
  "do you want me to",
  "should I proceed",
  "which direction",
  "what's your preference",
  "up to you",
  "your call",
  "depends on your",
]

/** Legitimate question patterns that should NOT trigger the gate. */
export const LEGITIMATE_QUESTIONS = [
  "should I escalate",
  "say yes",
  "say *yes*",
  "confirm",
  "approve",
]

/** @deterministic — detects if an agent response defers decisions to the user. */
export function detectHedgeLanguage(response: string): string[] {
  const lower = response.toLowerCase()
  const hedges: string[] = []
  for (const phrase of DEFERRAL_PHRASES) {
    // Lowercase both sides — the surfaced-by-Block-I4 bug was that
    // DEFERRAL_PHRASES contains case-sensitive entries (e.g. "shall I")
    // which never matched against `lower`. Normalizing at compare time
    // makes the contract "case-insensitive substring match" regardless of
    // how phrases are spelled in the constant.
    const phraseLower = phrase.toLowerCase()
    if (lower.includes(phraseLower)) {
      // Check if it's a legitimate question (escalation confirmation, etc.)
      const isLegitimate = LEGITIMATE_QUESTIONS.some(lq => {
        const idx = lower.indexOf(phraseLower)
        const surrounding = lower.slice(Math.max(0, idx - 50), idx + phraseLower.length + 50)
        return surrounding.includes(lq.toLowerCase())
      })
      if (!isLegitimate) {
        hedges.push(phrase)
      }
    }
  }
  return hedges
}
