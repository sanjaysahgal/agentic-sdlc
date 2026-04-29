// Block A6 — V2 designer runner.
//
// Mechanical replication of `runArchitectAgentV2` per the same rewrite-map
// contract (`docs/AGENT_RUNNER_REWRITE_MAP.md` runDesignAgent rows).
// Designer differs from architect in:
//   - Owns the design spec (specType: "design"); upstreamAudits are PM only
//   - No `pendingDecisionReview` branch (architect-only concern)
//   - Has a summarization-warning notice that's tagged `@readiness-irrelevant`
//   - Off-topic redirect identifies as "UX Designer" not "Architect"
//   - Approval-handoff hands off to Architect (next phase) not Engineer agents
//
// Same V2 architecture invariant: one entry, one user-emission return per
// branch, one source of truth (`buildReadinessReport`). The B1 invariant
// test enforces zero not-readiness-aware emissions in V2 runners. State
// mutations are data; runner applies them in fixed order; renderers stay
// pure.
//
// DESIGN-REVIEWED: same V2 single-path-runner pattern as architect per
// Principle 12. (1) Scales: per-feature state via FeatureKey, classifier +
// renderers pure, storage abstracted in K1. (2) Owned by this file post-
// cutover (Block E); legacy `runDesignAgent` deleted in Block F1. (3)
// Cross-cutting: same shape as architect runner; PM runner in A7 follows
// the same pattern; future Coder/Reviewer scaffolded by Block M1.

import type { ReadinessReport, ReadinessReportInput } from "../readiness-builder"
import { buildReadinessReport } from "../readiness-builder"

// ── Types ─────────────────────────────────────────────────────────────────────

// Designer has 6 branches (no decision-review). Same shape as architect's
// classifier output minus that one. Cross-agent contract test in B2 will
// assert this consistency.
export type DesignBranchKind =
  | "approval-confirm"          // pendingApproval + affirmative
  | "stale-spec-error"          // approval cached content !== current draft
  | "off-topic-redirect"        // user message off-topic for design
  | "state-query-fast-path"     // check-in / "where are we"
  | "escalation-engaged"        // readOnly resume after upstream PM reply
  | "normal-agent-turn"         // default: full LLM run

export type DesignClassifierInput = {
  readonly report: ReadinessReport
  readonly intent: DesignIntent
  readonly state:  DesignStateFlags
}

export type DesignIntent = {
  readonly isAffirmative: boolean
  readonly isCheckIn:     boolean
  readonly isStateQuery:  boolean
  readonly isOffTopic:    boolean
}

// DESIGN-REVIEWED: state flags + optional context payload mirror the
// architect shape per Principle 12. Per-feature scope, owned by
// conversation-store, cross-cutting across V2 runners that have pending-
// state branches. Designer has no pendingDecisionReview (architect-only),
// hence no second context payload.
export type DesignStateFlags = {
  readonly hasPendingApproval: boolean
  readonly readOnly:           boolean

  readonly pendingApprovalContext?: {
    readonly filePath:    string
    readonly specContent: string
  }
}

// ── Branch classifier (pure) ──────────────────────────────────────────────────

export function classifyDesignBranch(input: DesignClassifierInput): DesignBranchKind {
  const { intent, state } = input

  // 1. readOnly (escalation-reply) wins.
  if (state.readOnly) return "escalation-engaged"

  // 2. Pending approval + affirmative.
  if (state.hasPendingApproval && intent.isAffirmative) return "approval-confirm"

  // 3. Off-topic.
  if (intent.isOffTopic) return "off-topic-redirect"

  // 4. State-query / check-in.
  if (intent.isStateQuery || intent.isCheckIn) return "state-query-fast-path"

  // 5. Default.
  return "normal-agent-turn"
}

// ── Branch renderers ──────────────────────────────────────────────────────────

export type RenderedResponse = {
  readonly text:           string
  readonly stateMutations: readonly StateMutation[]
}

// Designer-side mutations. Distinct from architect's union (architect saves
// engineering specs; designer saves design specs). Block M1's scaffold may
// unify these into a polymorphic shape if 3+ agents share the same shape.
export type StateMutation =
  | { kind: "clear-pending-approval" }
  | { kind: "save-approved-design-spec"; filePath: string; content: string }
  | { kind: "append-message";            role: "user" | "assistant"; content: string }
  | { kind: "mark-user-oriented";        user: string }

// State-query fast-path. Same pattern as architect: emit `report.summary`
// directly. Closes the same class of bug for designer that the architect
// state-query fast-path retires.
export function renderStateQueryFastPath(params: {
  report:      ReadinessReport
  userMessage: string
}): RenderedResponse {
  return {
    text: params.report.summary,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: params.report.summary },
    ],
  }
}

// Off-topic redirect. Identifies as UX Designer; surfaces the readiness
// summary alongside the redirect (readiness-aware upgrade per rewrite-map
// row #3 designer).
export function renderOffTopicRedirect(params: {
  report:           ReadinessReport
  userMessage:      string
  mainChannelName:  string
}): RenderedResponse {
  const text = [
    `For status and progress updates across all features, ask in *#${params.mainChannelName}* — the concierge has the full picture.`,
    ``,
    `For *this* feature specifically:`,
    params.report.summary,
    ``,
    `I'm the UX Designer — I'm here when you're ready to work on screens, flows, or design decisions.`,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Approval-confirm. Designer hands off to Architect (next phase per
// AGENT_REGISTRY phase ownership), distinct from architect's hand-off to
// engineer agents.
export function renderApprovalConfirm(params: {
  report:           ReadinessReport
  userMessage:      string
  featureName:      string
  filePath:         string
  specContent:      string
  mainChannelName:  string
}): RenderedResponse {
  const text = [
    `The *${params.featureName}* design spec is saved and approved. :white_check_mark:`,
    ``,
    `*What happens next:*`,
    `A software architect produces the engineering plan before any code is written. If you're wearing the architect hat on this one, just say so right here and the engineering phase will begin.`,
    ``,
    `To confirm the approved state or check where any feature stands, go to *#${params.mainChannelName}* and ask.`,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "clear-pending-approval" },
      { kind: "save-approved-design-spec", filePath: params.filePath, content: params.specContent },
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Stale-spec-error. Same shape as architect's; the warning surfaces the
// readiness summary alongside the staleness signal.
export function renderStaleSpecError(params: {
  report:      ReadinessReport
  userMessage: string
}): RenderedResponse {
  const text = [
    `The design spec has been modified since the approval was offered. Please review the current version and say *approve* again when ready.`,
    ``,
    `Current state:`,
    params.report.summary,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "clear-pending-approval" },
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Escalation-engaged. Designer resumes after PM has replied to a designer-
// originated escalation. Same dep-injection pattern as architect.
export async function renderEscalationEngaged(params: {
  report:      ReadinessReport
  userMessage: string
  runLLM:      (input: { brief: string; report: ReadinessReport }) => Promise<string>
}): Promise<RenderedResponse> {
  const text = await params.runLLM({ brief: params.userMessage, report: params.report })
  return {
    text,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Normal-agent-turn. Same dep-injection pattern as architect; report.directive
// is injected into the LLM prompt upfront.
export async function renderNormalAgentTurn(params: {
  report:      ReadinessReport
  userMessage: string
  runLLM:      (input: { directive: string; userMessage: string; report: ReadinessReport }) => Promise<string>
}): Promise<RenderedResponse> {
  const text = await params.runLLM({
    directive:   params.report.directive,
    userMessage: params.userMessage,
    report:      params.report,
  })
  return {
    text,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// ── Main runner orchestration ─────────────────────────────────────────────────

export type RunDesignV2Deps = {
  readonly loadReport:         () => Promise<ReadinessReportInput>
  readonly applyStateMutation: (m: StateMutation) => Promise<void>
  readonly emit:               (text: string) => Promise<void>
  readonly mainChannelName:    string
  readonly fetchCurrentDraft:  (filePath: string, branchName: string) => Promise<string | null>
  readonly runLLMForEscalation: (input: { brief: string; report: ReadinessReport }) => Promise<string>
  readonly runLLMForNormalTurn: (input: { directive: string; userMessage: string; report: ReadinessReport }) => Promise<string>
  readonly log?:               (line: string) => void
}

export type RunDesignV2Params = {
  readonly userMessage: string
  readonly featureName: string
  readonly intent:      DesignIntent
  readonly state:       DesignStateFlags
  readonly userId?:     string
  readonly deps:        RunDesignV2Deps
}

export async function runDesignAgentV2(params: RunDesignV2Params): Promise<void> {
  const log = params.deps.log ?? ((s: string) => console.log(s))

  // 1. Build report.
  const reportInput = await params.deps.loadReport()
  const report      = buildReadinessReport(reportInput)

  // 2. Classify branch.
  const branch = classifyDesignBranch({ report, intent: params.intent, state: params.state })

  log(`[V2-DESIGNER] feature=${params.featureName} branch=${branch} aggregate=${report.aggregate} totalFindings=${report.totalFindingCount}`)

  // 3. Dispatch.
  let rendered: RenderedResponse
  switch (branch) {
    case "state-query-fast-path":
      rendered = renderStateQueryFastPath({ report, userMessage: params.userMessage })
      break

    case "approval-confirm": {
      const ctx = params.state.pendingApprovalContext
      if (!ctx) {
        throw new Error("[V2-DESIGNER] approval-confirm classified but pendingApprovalContext missing")
      }
      const branchName = `spec/${params.featureName}-design`
      const freshDraft = await params.deps.fetchCurrentDraft(ctx.filePath, branchName)
      const isStale    = freshDraft !== null && freshDraft !== ctx.specContent
      if (isStale) {
        rendered = renderStaleSpecError({ report, userMessage: params.userMessage })
        log(`[V2-DESIGNER] feature=${params.featureName} branch=stale-spec-error (was approval-confirm; staleness detected)`)
      } else {
        rendered = renderApprovalConfirm({
          report,
          userMessage:     params.userMessage,
          featureName:     params.featureName,
          filePath:        ctx.filePath,
          specContent:     ctx.specContent,
          mainChannelName: params.deps.mainChannelName,
        })
      }
      break
    }

    case "stale-spec-error":
      throw new Error("[V2-DESIGNER] stale-spec-error must be reached via approval-confirm staleness flip, not direct classification")

    case "off-topic-redirect":
      rendered = renderOffTopicRedirect({
        report,
        userMessage:     params.userMessage,
        mainChannelName: params.deps.mainChannelName,
      })
      break

    case "escalation-engaged":
      rendered = await renderEscalationEngaged({
        report,
        userMessage: params.userMessage,
        runLLM:      params.deps.runLLMForEscalation,
      })
      break

    case "normal-agent-turn":
      rendered = await renderNormalAgentTurn({
        report,
        userMessage: params.userMessage,
        runLLM:      params.deps.runLLMForNormalTurn,
      })
      break
  }

  // 4. Apply mutations.
  for (const mutation of rendered.stateMutations) {
    await params.deps.applyStateMutation(mutation)
  }

  // 5. Single emission.
  await params.deps.emit(rendered.text)
}
