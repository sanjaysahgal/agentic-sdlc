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
FINDING: <one sentence naming the specific gap or violation> | <one specific fix — no alternatives, no "or", no "either/or"; if multiple approaches exist, pick the best one and commit to it>

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

  if (text === "PASS") {
    console.log(`[AUDITOR] auditPhaseCompletion: feature=${featureName} rubricCriteria=${rubric.split(/^\d+\./m).length - 1} → ready=true`)
    return { ready: true, findings: [] }
  }

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
  if (findings.length === 0) {
    console.log(`[AUDITOR] auditPhaseCompletion: feature=${featureName} → ready=true (no parseable findings)`)
    return { ready: true, findings: [] }
  }

  console.log(`[AUDITOR] auditPhaseCompletion: feature=${featureName} → ready=false findings=${findings.length}`)
  return { ready: false, findings }
}

// ─── Adversarial downstream-readiness audit ────────────────────────────────────
//
// Open-ended alternative to rubric-based checks. Instead of checking a named list
// of criteria, asks Sonnet to take the perspective of the next-phase specialist and
// list every decision the spec leaves undefined.
//
// Complements auditPhaseCompletion (rubric) — the rubric catches known classes;
// this catches unknown classes the rubric didn't enumerate.
//
// Call this at every finalization gate alongside the rubric check.
// Both must return ready: true before the spec is approved.

type DownstreamRole = "designer" | "architect" | "engineer"

const DOWNSTREAM_ROLE_CONTEXT: Record<DownstreamRole, { persona: string; task: string; upstreamRole: string }> = {
  designer: {
    persona: "a senior UX designer",
    task: "design every screen, user flow, interaction, state, and copy string for this feature — you must be able to hand your design spec directly to an engineer with zero ambiguity",
    upstreamRole: "PM",
  },
  architect: {
    persona: "a senior software architect",
    task: "design the technical architecture, data model, API surface, and all implementation decisions for this feature",
    upstreamRole: "PM and designer",
  },
  engineer: {
    persona: "an engineer implementing this feature from scratch",
    task: "write all the code for this feature — backend, frontend, migrations, and error handling",
    upstreamRole: "architect",
  },
}

export async function auditDownstreamReadiness(params: {
  specContent: string
  downstreamRole: DownstreamRole
  featureName: string
}): Promise<PhaseCompletionAuditResult> {
  const { specContent, downstreamRole, featureName } = params
  const { persona, task, upstreamRole } = DOWNSTREAM_ROLE_CONTEXT[downstreamRole]

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are ${persona}. You have just received the spec below and your job is to ${task}. You cannot ask the ${upstreamRole} any follow-up questions — you must work from this document alone.

Read the spec carefully as if you are about to start work. Identify every place where you would need to guess, invent, or make an assumption in order to do your job. This includes:
- Interaction behaviors not specified (what happens when a user taps X? can they dismiss Y?)
- Error and failure states with no recovery path defined
- UI modality decisions left open (inline vs overlay, modal vs banner, toast vs inline text)
- Timing and threshold values referenced but not given a number
- Loading and transition states with no visual treatment defined
- Scope boundaries undefined (which users? which conditions? which tiers?)
- Transition behaviors left as vague qualitative descriptions ("smoothly", "without disruption")

For each such gap, output exactly one line:
FINDING: <what decision or specification is missing from the spec> | <the specific decision the ${upstreamRole} must make before you can proceed>

Important: only flag decisions that are rightfully the ${upstreamRole}'s to make — not implementation choices that are yours as the ${downstreamRole}. Do not flag visual details, layout specifics, or creative choices that you own.

If the spec provides everything you need to proceed without guessing, output exactly: PASS

Output only FINDING lines and/or PASS. No preamble, no explanation, no numbering.`,
    messages: [
      {
        role: "user",
        content: `Feature: ${featureName}\n\n## Spec\n${specContent}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : "PASS"

  if (text === "PASS") {
    console.log(`[AUDITOR] auditDownstreamReadiness: feature=${featureName} role=${downstreamRole} → ready=true`)
    return { ready: true, findings: [] }
  }

  const findings: Array<{ issue: string; recommendation: string }> = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("FINDING:")) continue
    const body = line.replace("FINDING:", "")
    const pipeIndex = body.indexOf("|")
    if (pipeIndex === -1) continue
    findings.push({
      issue: body.slice(0, pipeIndex).trim(),
      recommendation: body.slice(pipeIndex + 1).trim(),
    })
  }

  if (findings.length === 0) {
    console.log(`[AUDITOR] auditDownstreamReadiness: feature=${featureName} role=${downstreamRole} → ready=true (no parseable findings)`)
    return { ready: true, findings: [] }
  }

  console.log(`[AUDITOR] auditDownstreamReadiness: feature=${featureName} role=${downstreamRole} → ready=false findings=${findings.length}`)
  return { ready: false, findings }
}

// ─── PM Rubric ─────────────────────────────────────────────────────────────────

export const PM_RUBRIC = `1. USER FLOWS — Every user story in ## User Stories has an explicit success path AND at least one error/edge path documented in ## Edge Cases or the story itself. A user story with no error path is incomplete.

2. MEASURABLE ACCEPTANCE CRITERIA — Every criterion in ## Acceptance Criteria is specific and testable by an engineer. Criteria containing words like "fast", "smooth", "easy", "good", "improve", "soft", "non-intrusive", "proactively", "proactive", "ambient", "seamlessly", "seamless", "minimal", "appropriate", "subtle", or any comparative without a baseline are not measurable and must be flagged. Each criterion must name a concrete, observable outcome.

3. NO OPEN QUESTIONS — The ## Open Questions section contains zero questions (blocking or non-blocking). All questions must be resolved before approval — not just blocking ones. Any line with [blocking: yes] or [blocking: no] in ## Open Questions is a finding.

4. DATA REQUIREMENTS — Any user story that reads, writes, or stores data must have its data requirements explicitly described (in the user story, acceptance criteria, or a dedicated section). "User data is saved" is not a data requirement. "User profile including name, email, and onboarding completion flag is persisted to the database" is a data requirement.

5. ARCHITECTURE CONSISTENCY — The spec does not propose or assume any technical approach (auth method, data store, API pattern, platform type) that explicitly contradicts the System Architecture. Silence on implementation is acceptable — only flag explicit contradictions.

6. NON-GOALS COMPLETENESS — The ## Non-Goals section explicitly excludes at least one scope boundary that a reasonable engineer might otherwise include. An empty Non-Goals section or a vague "nothing out of scope" statement is a red flag.`

// ─── PM Design-Readiness Rubric ────────────────────────────────────────────────
//
// Runs at PM finalization (inside finalize_product_spec handler) — not the PM_RUBRIC completeness
// gate. Checks whether the spec provides enough concrete constraints for a designer to make
// implementation decisions without inventing answers. Runs on the PM spec itself before it is
// approved. Complements PM_RUBRIC criterion 2 (measurable criteria) — catches gaps that Sonnet
// may miss in PM context but the designer would encounter immediately.

export const PM_DESIGN_READINESS_RUBRIC = `1. VAGUE LANGUAGE — Scan ## Acceptance Criteria, ## User Stories, and ## Edge Cases for requirements that two designers would implement differently:

- Vague sensory or quality descriptors: "soft", "ambient", "subtle", "minimal", "appropriate", "smooth", "seamless", "non-intrusive", "clean", "polished", "gentle", "quiet", "unobtrusive", "friendly", "clear", "warm", "elegant", "natural", "nice" — each must be replaced with a concrete, observable UI behavior
- Undefined timing or threshold values: "quickly", "immediately", "eventually", "after some time", "after inactivity", or any mention of "TTL", "timeout", "session expiry", "limit", "quota", or "rate" that does not also name the actual numeric value in seconds or minutes
- Transition vagueness: "without disruption", "seamlessly transitions", "smoothly moves", "without interruption" — each must specify exactly what the user sees during and after the transition
- Underspecified error or edge behaviors: "handle gracefully", "show an error", "notify the user", "display a warning", "surface a message" — each must name the exact UI treatment (modal, inline text, toast, banner) and either the exact copy or a format with all variable slots filled

2. INTERACTION COMPLETENESS — Every UI element that a user can tap, press, or interact with must define what happens when the user does so. For each interactive element described or implied in the spec (indicators, banners, nudges, CTAs, buttons): the spec must state whether it is interactive or not, and if interactive, what action it triggers. "Indicator" or "banner" without specifying tap behavior is incomplete. If tapping does nothing, the spec must say so explicitly.

3. ERROR AND FAILURE RECOVERY — Every user action that can fail must have a defined recovery UX. For each user story or edge case that names a failure mode (sign-up failure, session expiry mid-flow, auth resolution failure, network error, rate limit hit): the spec must state the exact recovery path — retry offered, alternative suggested, redirect to a specific state, or error with no recovery. "Failed attempts are handled" or "errors are shown" without naming the recovery path is incomplete.

4. UI MODALITY AND PLACEMENT — Every notification, nudge, alert, or injected content element must specify: (a) modality — inline in the content stream, floating overlay, full-screen modal, banner at top/bottom, or toast; (b) dismissibility — whether the user can dismiss it and how; (c) persistence — whether it persists until action, auto-dismisses after N seconds, or stays for the session. "A message appears" or "a nudge is shown" without all three attributes is incomplete.

5. LOADING AND TRANSITION STATES — Every async operation with a duration the user can perceive must define what the user sees during the wait. For any operation that takes more than an instant (auth resolution, account creation, data load): the spec must name the loading treatment — skeleton screen, spinner, progress indicator, blank canvas, or immediate optimistic render — and what the user sees when it resolves (instant replace, fade-in, scroll-to-top). "Loads the home screen" without specifying the loading state is incomplete.

For each gap found in any criterion above, output exactly one FINDING line naming the specific requirement or element and one specific PM decision that would make it design-ready.`

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

10. NO UNRESOLVED PRODUCT ASSUMPTIONS OR PM SPEC VAGUENESS — This criterion has two parts:

PART A — Design assumptions: Identify any design decision that assumes a product answer not explicitly stated or approved in the ## Approved Product Spec or ## Product Vision — for example: a UI flow that assumes a specific auth provider when the PM spec says "SSO" without naming a provider; acceptance criteria using subjective language like "soft" or "ambient" that the PM spec never defined measurably; a screen that assumes a feature is available on all tiers when scope was never defined.

PART B — PM spec vagueness: Scan the ## Approved Product Spec for requirements that use vague or undefined language for user-visible behaviors — for example: "handle gracefully", "preserve conversations", "appropriate response", "seamlessly", or any error path/edge case described without specifying the actual behavior. For each such vague PM requirement, check whether the design spec provides a specific, implementable decision. If the PM spec is too vague to design against AND the design spec also lacks a specific implementation (missing screen, missing state, missing error copy), that is a product-scope gap — the design team cannot invent the answer unilaterally.

For each finding from PART A or PART B, output exactly one line with the prefix "[PM-GAP]" followed by: which PM requirement is vague or missing, and what specific PM decision is needed before design can proceed. If no gaps exist, output nothing for this criterion.

11. NO OPEN QUESTIONS — The ## Open Questions section contains zero questions of any kind. All [type: design] questions must be resolved before design approval. Engineering constraints belong in ## Design Assumptions (seeded to engineering spec at finalization), not in ## Open Questions. Any line with [blocking: yes] or [blocking: no] in ## Open Questions is a blocking gap.`
}

export const DESIGN_RUBRIC = buildDesignRubric(["mobile", "desktop"])

// ─── Engineer Rubric ────────────────────────────────────────────────────────────

export const ENGINEER_RUBRIC = `1. API CONTRACTS — Every user story or data operation must have at least one endpoint defined. Each endpoint must name: HTTP method + path, request body/query params (field names and types), and response shape (field names and types). "API to be defined" or "endpoint TBD" is not a contract.

2. DATA MODEL — Every entity the feature reads or writes must have its fields named explicitly (not just the entity name). Relationship cardinality (one-to-many, etc.) must be stated. "User table updated" is not a data model entry.

3. ERROR PATHS — For every operation (create, read, update, delete), at least one error case must be documented with its HTTP status code and response shape. A spec with only happy-path flows is incomplete.

4. AUTHENTICATION + AUTHORIZATION — Every endpoint must state its auth requirement explicitly: which roles or conditions allow access. "Auth required" alone is not sufficient — it must name the role or condition.

5. MIGRATION STRATEGY — Any schema change (new table, new column, column rename, column removal) must have a migration approach documented: additive migration, backfill strategy, or explicit "no migration needed" with reasoning. "Schema will be updated" is not a strategy.

6. NO OPEN QUESTIONS — The ## Open Questions section contains zero questions (blocking or non-blocking). All questions must be resolved before engineering approval — not just blocking ones. Any line with [blocking: yes] or [blocking: no] in ## Open Questions is a finding.`
