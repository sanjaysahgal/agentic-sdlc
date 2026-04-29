// Block A7 — V2 PM runner.
//
// Mechanical replication of `runDesignAgentV2` per the same rewrite-map
// contract (`docs/AGENT_RUNNER_REWRITE_MAP.md` runPmAgent rows). PM is
// structurally simpler than designer because PM is the head of the spec
// chain: there is no upstream agent, so `upstreamAudits` is always
// empty. The aggregate state therefore reflects PM's own product-spec
// audit only — `ready`, `dirty-own`, `escalation-active` (rare for PM —
// only happens if a downstream agent escalated to PM during their phase),
// or `ready-pending-approval`.
//
// PM differs from designer in:
//   - Owns the product spec (specType: "product"); upstreamAudits is []
//   - Off-topic redirect identifies as "Product Manager" not "UX Designer"
//   - Approval-confirm hands off to UX Designer (next phase) not Architect
//   - Save mutation kind is `save-approved-product-spec`
//
// Per AGENT_RUNNER_REWRITE_MAP, legacy PM has 3 not-readiness-aware
// emissions (stale-spec, approval-confirm, main response). V2 adds two
// more branches (off-topic-redirect, state-query-fast-path) for cross-
// agent parity per Principle 15 — same single-path discipline + same
// bug-class retirement (state-query fast-path) for PM as for the other
// two agents.
//
// DESIGN-REVIEWED: same V2 single-path-runner pattern as architect +
// designer per Principle 12. (1) Scales: per-feature state via FeatureKey,
// classifier + renderers pure, storage abstracted in K1. (2) Owned by
// this file post-cutover (Block E); legacy `runPmAgent` deleted in Block
// F1. (3) Cross-cutting: same shape as architect + designer runners;
// future Coder/Reviewer agents scaffolded by Block M1 follow the same
// pattern, with PM's empty-upstream variant being the simplest template.

import type { ReadinessReport, ReadinessReportInput } from "../readiness-builder"
import { buildReadinessReport } from "../readiness-builder"

// ── Types ─────────────────────────────────────────────────────────────────────

// PM has 6 branches (same shape as designer; no decision-review which is
// architect-only). Cross-agent contract test in B2 will assert the
// classifier output set across PM/designer/architect.
export type PmBranchKind =
  | "approval-confirm"          // pendingApproval + affirmative
  | "stale-spec-error"          // approval cached content !== current draft
  | "off-topic-redirect"        // user message off-topic for PM
  | "state-query-fast-path"     // check-in / "where are we"
  | "escalation-engaged"        // readOnly resume after downstream agent's reply
  | "normal-agent-turn"         // default: full LLM run

export type PmClassifierInput = {
  readonly report: ReadinessReport
  readonly intent: PmIntent
  readonly state:  PmStateFlags
}

export type PmIntent = {
  readonly isAffirmative: boolean
  readonly isCheckIn:     boolean
  readonly isStateQuery:  boolean
  readonly isOffTopic:    boolean
}

// DESIGN-REVIEWED: state flags + optional context payload mirror the
// designer/architect shape per Principle 12. Per-feature scope, owned by
// conversation-store, cross-cutting across V2 runners that have pending-
// state branches. PM has no pendingDecisionReview (architect-only).
export type PmStateFlags = {
  readonly hasPendingApproval: boolean
  readonly readOnly:           boolean

  readonly pendingApprovalContext?: {
    readonly filePath:    string
    readonly specContent: string
  }
}

// ── Branch classifier (pure) ──────────────────────────────────────────────────

export function classifyPmBranch(input: PmClassifierInput): PmBranchKind {
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

// PM-side mutations. Distinct from designer/architect's union (each agent
// saves its own spec). Block M1's scaffold may unify these into a
// polymorphic shape if 3+ agents share the same shape.
export type StateMutation =
  | { kind: "clear-pending-approval" }
  | { kind: "save-approved-product-spec"; filePath: string; content: string }
  | { kind: "append-message";             role: "user" | "assistant"; content: string }
  | { kind: "mark-user-oriented";         user: string }

// State-query fast-path. Same pattern as architect/designer: emit
// `report.summary` directly. Cross-agent parity (Principle 15) — retires
// the same class of bug for PM as the architect/designer fast-paths.
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

// Off-topic redirect. Identifies as Product Manager; surfaces the readiness
// summary alongside the redirect.
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
    `I'm the Product Manager — I'm here when you're ready to work on user stories, acceptance criteria, or product decisions.`,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Approval-confirm. PM hands off to UX Designer (next phase per
// AGENT_REGISTRY phase ownership), distinct from designer's hand-off to
// architect.
export function renderApprovalConfirm(params: {
  report:           ReadinessReport
  userMessage:      string
  featureName:      string
  filePath:         string
  specContent:      string
  mainChannelName:  string
}): RenderedResponse {
  const text = [
    `The *${params.featureName}* product spec is saved and approved. :white_check_mark:`,
    ``,
    `*What happens next:*`,
    `A UX designer produces the screens and user flows before any engineering begins. If you're wearing the designer hat on this one, just say so right here and the design phase will begin.`,
    ``,
    `To confirm the approved state or check where any feature stands, go to *#${params.mainChannelName}* and ask.`,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "clear-pending-approval" },
      { kind: "save-approved-product-spec", filePath: params.filePath, content: params.specContent },
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Stale-spec-error. Same shape as designer/architect's; the warning
// surfaces the readiness summary alongside the staleness signal.
export function renderStaleSpecError(params: {
  report:      ReadinessReport
  userMessage: string
}): RenderedResponse {
  const text = [
    `The product spec has been modified since the approval was offered. Please review the current version and say *approve* again when ready.`,
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

// Escalation-engaged. PM resumes after a downstream agent (designer or
// architect) escalated to PM and the user has replied. Same dep-injection
// pattern as architect/designer.
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

// Normal-agent-turn. Same dep-injection pattern as architect/designer;
// report.directive is injected into the LLM prompt upfront.
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

export type RunPmV2Deps = {
  readonly loadReport:         () => Promise<ReadinessReportInput>
  readonly applyStateMutation: (m: StateMutation) => Promise<void>
  readonly emit:               (text: string) => Promise<void>
  readonly mainChannelName:    string
  readonly fetchCurrentDraft:  (filePath: string, branchName: string) => Promise<string | null>
  readonly runLLMForEscalation: (input: { brief: string; report: ReadinessReport }) => Promise<string>
  readonly runLLMForNormalTurn: (input: { directive: string; userMessage: string; report: ReadinessReport }) => Promise<string>
  readonly log?:               (line: string) => void
}

export type RunPmV2Params = {
  readonly userMessage: string
  readonly featureName: string
  readonly intent:      PmIntent
  readonly state:       PmStateFlags
  readonly userId?:     string
  readonly deps:        RunPmV2Deps
}

export async function runPmAgentV2(params: RunPmV2Params): Promise<void> {
  const log = params.deps.log ?? ((s: string) => console.log(s))

  // 1. Build report.
  const reportInput = await params.deps.loadReport()
  const report      = buildReadinessReport(reportInput)

  // 2. Classify branch.
  const branch = classifyPmBranch({ report, intent: params.intent, state: params.state })

  log(`[V2-PM] feature=${params.featureName} branch=${branch} aggregate=${report.aggregate} totalFindings=${report.totalFindingCount}`)

  // 3. Dispatch.
  let rendered: RenderedResponse
  switch (branch) {
    case "state-query-fast-path":
      rendered = renderStateQueryFastPath({ report, userMessage: params.userMessage })
      break

    case "approval-confirm": {
      const ctx = params.state.pendingApprovalContext
      if (!ctx) {
        throw new Error("[V2-PM] approval-confirm classified but pendingApprovalContext missing")
      }
      const branchName = `spec/${params.featureName}-product`
      const freshDraft = await params.deps.fetchCurrentDraft(ctx.filePath, branchName)
      const isStale    = freshDraft !== null && freshDraft !== ctx.specContent
      if (isStale) {
        rendered = renderStaleSpecError({ report, userMessage: params.userMessage })
        log(`[V2-PM] feature=${params.featureName} branch=stale-spec-error (was approval-confirm; staleness detected)`)
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
      throw new Error("[V2-PM] stale-spec-error must be reached via approval-confirm staleness flip, not direct classification")

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
