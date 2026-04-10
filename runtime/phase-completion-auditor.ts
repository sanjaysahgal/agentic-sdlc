import Anthropic from "@anthropic-ai/sdk"

// Phase Completion Gate — shared infrastructure for all spec-producing agents.
//
// To add a phase completion gate to a new agent:
//
// 1. Define a rubric constant here (export const ARCHITECT_RUBRIC = `...`)
//    The rubric is a numbered list of criteria. Each item names what must be present
//    and what "incomplete" looks like so Sonnet can distinguish pass from fail.
//
// 2. Add a `run_phase_completion_audit` tool to the agent's TOOLS array (no parameters needed).
//    Tool description: "Call when user signals approval — BEFORE finalize_*. Returns { ready, findings }."
//
// 3. Add approval-intent detection + audit-first sequence to the agent's system prompt.
//    See the "When to finalize" section in agents/pm.ts and agents/design.ts.
//
// 4. Wire the tool handler in message.ts: read draft → auditPhaseCompletion(rubric) → return { result }.
//    The agent surfaces findings; the human re-approves; agent re-runs audit.
//
// 5. Add tests to tests/unit/phase-completion-auditor.test.ts following the vi.hoisted/vi.mock pattern.

// 90s timeout — Sonnet rubric evaluations can be moderately long but must not
// hang indefinitely. No retries: a stall is a failure, not a recoverable transient.
const client = new Anthropic({ maxRetries: 0, timeout: 90_000 })

export type PhaseCompletionAuditResult = {
  ready: boolean
  findings: Array<{ issue: string; recommendation: string }>
}

export async function auditPhaseCompletion(params: {
  specContent: string
  rubric: string
  featureName: string
  productVision?: string
  systemArchitecture?: string
  approvedProductSpec?: string
}): Promise<PhaseCompletionAuditResult> {
  const { specContent, rubric, featureName, productVision, systemArchitecture, approvedProductSpec } = params

  const contextSection = [
    productVision ? `## Product Vision\n${productVision}` : "",
    systemArchitecture ? `## System Architecture\n${systemArchitecture}` : "",
    approvedProductSpec ? `## Approved Product Spec\n${approvedProductSpec}` : "",
  ].filter(Boolean).join("\n\n")

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are auditing a spec for phase completion. The spec must pass every criterion in the rubric below before the phase can be approved.

RUBRIC:
${rubric}

For each rubric criterion the spec FAILS, output exactly one line:
FINDING: <one sentence naming the specific gap or violation> | <one actionable recommendation to fix it, with specific values>

If the spec passes ALL criteria, output exactly: PASS

Output only FINDING lines and/or PASS. No preamble, no explanation, no numbering.`,
    messages: [
      {
        role: "user",
        content: `Feature: ${featureName}
${contextSection ? `\n${contextSection}\n` : ""}
## Spec to audit
${specContent}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "PASS"

  if (text === "PASS") return { ready: true, findings: [] }

  const findings: Array<{ issue: string; recommendation: string }> = []

  for (const line of text.split("\n")) {
    if (!line.startsWith("FINDING:")) continue
    const body = line.replace("FINDING:", "")
    const pipeIndex = body.indexOf("|")
    if (pipeIndex === -1) continue // malformed — skip
    findings.push({
      issue: body.slice(0, pipeIndex).trim(),
      recommendation: body.slice(pipeIndex + 1).trim(),
    })
  }

  // Unexpected format (no PASS, no valid FINDING lines) — fail-safe, don't block
  if (findings.length === 0) return { ready: true, findings: [] }

  return { ready: false, findings }
}

// ─── PM Rubric ─────────────────────────────────────────────────────────────────

export const PM_RUBRIC = `1. USER FLOWS — Every user story in ## User Stories has an explicit success path AND at least one error/edge path documented in ## Edge Cases or the story itself. A user story with no error path is incomplete.

2. MEASURABLE ACCEPTANCE CRITERIA — Every criterion in ## Acceptance Criteria is specific and testable by an engineer. Criteria containing words like "fast", "smooth", "easy", "good", "improve", or any comparative without a baseline are not measurable and must be flagged. Each criterion must name a concrete, observable outcome.

3. NO OPEN QUESTIONS — The ## Open Questions section contains zero questions tagged [blocking: yes] that are unresolved. A spec with unresolved blocking questions cannot be approved — those questions must be answered first.

4. DATA REQUIREMENTS — Any user story that reads, writes, or stores data must have its data requirements explicitly described (in the user story, acceptance criteria, or a dedicated section). "User data is saved" is not a data requirement. "User profile including name, email, and onboarding completion flag is persisted to the database" is a data requirement.

5. ARCHITECTURE CONSISTENCY — The spec does not propose or assume any technical approach (auth method, data store, API pattern, platform type) that explicitly contradicts the System Architecture. Silence on implementation is acceptable — only flag explicit contradictions.

6. NON-GOALS COMPLETENESS — The ## Non-Goals section explicitly excludes at least one scope boundary that a reasonable engineer might otherwise include. An empty Non-Goals section or a vague "nothing out of scope" statement is a red flag.`

// ─── Design Rubric ─────────────────────────────────────────────────────────────

// buildDesignRubric injects the team's target form factors into criterion 9.
// Use this wherever you call auditPhaseCompletion for a design spec — pass targetFormFactors from WorkspaceConfig.
// DESIGN_RUBRIC is the default (mobile + desktop) — exported for tests and as a fallback.
export function buildDesignRubric(formFactors: string[]): string {
  const formFactorList = formFactors.join(", ")
  return `1. ALL SCREENS DEFINED — Every screen, sheet, modal, and overlay that appears in any ## User Flows flow must have a corresponding entry in ## Screens with: purpose, all states (at minimum: default, loading, empty, error), and interactions. A screen referenced in flows but absent from ## Screens is a blocking gap.

2. ALL STATES FULLY SPECIFIED — For every screen in ## Screens, each named state must be defined with its visual treatment. "Error state: shows error message" is not a definition. "Error state: red inline text beneath the input reading the exact error string, no modal" is a definition. State names without visual descriptions are incomplete.

3. ALL UI COPY SPECIFIED — Every text string that appears on screen must be defined verbatim in the spec: button labels, chip labels, placeholder text, empty state headlines and body copy, error messages, titles, subtitles. "Button label: TBD", "copy to be determined", or any implied copy without an explicit value is a finding. The only acceptable absence is an explicit "no title" or "no subtitle" statement.

4. ALL ANIMATIONS WITH TIMING AND EASING — Every sheet, modal, overlay, state transition, or element that the spec describes as animated must specify: entry/exit direction (e.g. slides up from bottom), duration in milliseconds, and easing function (e.g. ease-out, cubic-bezier). "Smooth transition" or "animated" without a timing value is insufficient.

5. NO CONFLICTING VALUES — The spec must not contain contradictory values for the same element across different sections. If two sections specify different values for the same property, that is a conflict and must be flagged.

6. NO VAGUE LANGUAGE — The spec must not contain language that two engineers would interpret differently. Flag: "near the top", "slightly rounded", "prominent", "subtle", "appropriate spacing", "reasonable margin". Each must be replaced with a specific value.

7. BRAND TOKEN CONSISTENCY — Every color, font, and spacing value used in the spec must correspond to a named token from the ## Brand section or be an explicit "none" statement. Raw hex values in screen descriptions that don't match any brand token are a finding.

8. NO TBD/TODO/PLACEHOLDER — The spec must contain zero instances of "TBD", "TODO", "PLACEHOLDER", "to be determined", "to be decided", "to come", "to be defined", or any equivalent deferral. Every such occurrence is a blocking gap.

9. FORM FACTOR COVERAGE — Every screen must define layout behavior for all target form factors: ${formFactorList}. For each form factor, the spec must describe at minimum how key elements are arranged or sized at that viewport (e.g. single-column vs two-column, full-width vs fixed-width container, stacked vs side-by-side). A screen that defines layout for only one form factor without addressing the others is incomplete. The only acceptable exception is an explicit exclusion in ## Non-Goals (e.g. "Desktop layout is out of scope for this feature").

10. NO UNRESOLVED PRODUCT ASSUMPTIONS — Compare every significant design decision in this spec against the ## Approved Product Spec and ## Product Vision provided in context. Identify any design decision that assumes a product answer not explicitly stated or approved in those documents — for example: an error UX that assumes a specific recovery flow when the PM spec only says "handle gracefully"; a UI flow that assumes a specific auth provider when the PM spec says "SSO" without naming a provider; acceptance criteria using subjective language like "soft" or "ambient" that the PM spec never defined measurably; a screen that assumes a feature is available on all tiers when scope was never defined. Each such assumption is a product-scope gap that the design team cannot resolve unilaterally. Output one finding per gap with the exact prefix "[type: product] [blocking: yes]" followed by a concise description of the assumption and what PM decision is needed to resolve it. If all design decisions are grounded in explicit product spec decisions, output nothing for this criterion.`
}

export const DESIGN_RUBRIC = buildDesignRubric(["mobile", "desktop"])

// ─── Engineer Rubric ────────────────────────────────────────────────────────────

export const ENGINEER_RUBRIC = `1. API CONTRACTS — Every user story or data operation must have at least one endpoint defined. Each endpoint must name: HTTP method + path, request body/query params (field names and types), and response shape (field names and types). "API to be defined" or "endpoint TBD" is not a contract.

2. DATA MODEL — Every entity the feature reads or writes must have its fields named explicitly (not just the entity name). Relationship cardinality (one-to-many, etc.) must be stated. "User table updated" is not a data model entry.

3. ERROR PATHS — For every operation (create, read, update, delete), at least one error case must be documented with its HTTP status code and response shape. A spec with only happy-path flows is incomplete.

4. AUTHENTICATION + AUTHORIZATION — Every endpoint must state its auth requirement explicitly: which roles or conditions allow access. "Auth required" alone is not sufficient — it must name the role or condition.

5. MIGRATION STRATEGY — Any schema change (new table, new column, column rename, column removal) must have a migration approach documented: additive migration, backfill strategy, or explicit "no migration needed" with reasoning. "Schema will be updated" is not a strategy.

6. NO UNRESOLVED BLOCKING QUESTIONS — The spec contains zero questions tagged [blocking: yes] that are unresolved. A spec with unresolved blocking questions cannot move to implementation.`
