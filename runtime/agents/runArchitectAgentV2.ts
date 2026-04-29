// Block A4 step 2 — V2 architect runner: skeleton + state-query branch.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// and `docs/AGENT_RUNNER_REWRITE_MAP.md`, the V2 runner replaces the legacy
// `runArchitectAgent` (currently at `interfaces/slack/handlers/message.ts:2596`)
// with a single-path runner: one entry, one user-emission return per branch,
// one source of truth for state representation (`buildReadinessReport()`).
//
// Branch classifier maps (state, intent) → branch kind. Each branch has a
// pure renderer (or LLM-orchestrated renderer for the normal-agent branch).
// Every emission is readiness-aware by construction — the B1 invariant test
// enforces this at PR time once productionalized from the A1 spike.
//
// This file ships the skeleton + the state-query branch (the legacy line
// 2731 fast-path that bypassed the readiness directive on the recent
// manual test). Subsequent commits implement the remaining branches:
//   - approval-confirm (legacy 2660 pendingApproval)
//   - decision-review-confirm (legacy 2628 pendingDecisionReview)
//   - stale-spec-error (legacy 2647)
//   - off-topic-redirect (legacy 2677)
//   - escalation-engaged (legacy readOnly path)
//   - normal-agent-turn (legacy main LLM path, lines 3224/3236/3238)
//
// V2 is NOT wired into the dispatcher in this commit. Production traffic
// continues to flow through legacy `runArchitectAgent` unchanged. Shadow-
// mode integration lands in Block A5; cutover lands in Block E.
//
// DESIGN-REVIEWED: V2 single-path runner per Principle 12.
// (1) Scales to 100 features × 10 agents because per-feature state lives in
//     `runtime/conversation-store` (keyed by FeatureKey), the classifier and
//     renderers are pure (O(1) per turn, no per-feature accumulator), and the
//     storage abstraction in Block K1 makes the durable backend the bottleneck
//     — not the runner itself. Adding the Nth agent is a Block M1 scaffold
//     invocation; this runner is the template.
// (2) Ownership: this runner is the SOLE owner of architect response
//     generation post-cutover (Block E). Pre-cutover, the legacy
//     `runArchitectAgent` (interfaces/slack/handlers/message.ts:2596) owns
//     production traffic; V2 is shadow-only. Block F1 deletes the legacy
//     after burn-in. No competing owner for this concern.
// (3) Cross-cutting: yes. The V2 pattern (single-path, report-derived,
//     dep-injected, structural-enforcer-composed) is shared by V2 PM, V2
//     designer, and future V2 Coder/Reviewer. Cross-agent decisions
//     (escalation-engaged readOnly path, post-run enforcer composition,
//     fast-path-vs-slow-path split) are documented in
//     `docs/AGENT_RUNNER_REWRITE_MAP.md` cross-cutting sections, NOT
//     re-decided per agent. Block M1's scaffold script generates new V2
//     runners from this template so the pattern doesn't drift.

import type { ReadinessReport, ReadinessReportInput } from "../readiness-builder"
import { buildReadinessReport } from "../readiness-builder"

// ── Types ─────────────────────────────────────────────────────────────────────

// The kind of response the V2 runner should produce for a given turn. The
// classifier maps inputs to one of these; the dispatch in `runArchitectAgentV2`
// routes to the appropriate renderer. Every kind is readiness-aware — either
// directly (renderers consume `ReadinessReport`) or by construction
// (LLM-orchestrated branches inject the report's `directive`).
export type ArchitectBranchKind =
  | "approval-confirm"          // pendingApproval is set + user said yes
  | "decision-review-confirm"   // pendingDecisionReview is set + user said yes
  | "stale-spec-error"          // pendingApproval was set but spec changed under user
  | "off-topic-redirect"        // user message is off-topic for engineering
  | "state-query-fast-path"     // user message is a check-in / "where are we"
  | "escalation-engaged"        // architect resumes after upstream escalation reply (readOnly)
  | "normal-agent-turn"         // default: run the LLM agent with the readiness directive

// Inputs the classifier needs. Pure — no I/O, no clock.
export type ArchitectClassifierInput = {
  readonly report: ReadinessReport
  readonly intent: ArchitectIntent
  readonly state:  ArchitectStateFlags
}

// Intent classification (already determined by upstream dispatch in production;
// passed in here as data so the classifier stays pure). The legacy path uses
// `CHECK_IN_RE`, `isOffTopicForAgent`, `isSpecStateQuery` to compute these;
// V2 inherits those upstream classifiers and feeds the result here.
export type ArchitectIntent = {
  readonly isAffirmative:  boolean
  readonly isCheckIn:      boolean
  readonly isStateQuery:   boolean
  readonly isOffTopic:     boolean
}

// Per-feature state flags read from the conversation-store before the runner
// is invoked. Passed as data so the classifier stays pure.
export type ArchitectStateFlags = {
  readonly hasPendingApproval:        boolean
  readonly hasPendingDecisionReview:  boolean
  readonly readOnly:                  boolean   // escalation-reply context
}

// ── Branch classifier (pure) ──────────────────────────────────────────────────
//
// Determines which branch the V2 runner should take given the report + intent
// + state flags. Pure function: same input → same output, no I/O. Tested in
// `tests/unit/architect-classifier-v2.test.ts` against every state combo.

export function classifyArchitectBranch(input: ArchitectClassifierInput): ArchitectBranchKind {
  const { intent, state } = input

  // 1. readOnly (escalation-reply) takes precedence over everything else —
  // the architect is being asked to compose an escalation reply, not to
  // serve a normal user turn. The orientation enforcer wraps the LLM run
  // in this branch.
  if (state.readOnly) return "escalation-engaged"

  // 2. Pending decision review (architect resolved open questions with a
  // save_engineering_spec_draft tool call; the platform held the content
  // for human confirmation). User affirmative → confirm. User negative →
  // fall through to normal turn (architect handles the rejection).
  if (state.hasPendingDecisionReview && intent.isAffirmative) return "decision-review-confirm"

  // 3. Pending engineering-spec approval. Same shape as the design / PM
  // approval flow: affirmative → save approved, post handoff message;
  // negative → fall through to normal turn.
  // Stale-spec-error sub-branch handled inside the renderer (the renderer
  // checks if the spec content changed since approval was offered and
  // emits the warning instead of saving). The classifier doesn't need to
  // know; the renderer reads the current draft fresh.
  if (state.hasPendingApproval && intent.isAffirmative) return "approval-confirm"

  // 4. Off-topic redirect. Architect doesn't answer general questions —
  // it points the user at the concierge. Renderer surfaces the current
  // readiness state alongside the redirect (per AGENT_RUNNER_REWRITE_MAP
  // row 4) so the user sees both the routing hint and the spec status.
  if (intent.isOffTopic) return "off-topic-redirect"

  // 5. State-query fast-path. Check-ins ("hi", "where are we") and explicit
  // state queries ("what's the status") get a deterministic summary
  // rendered from the readiness report. Zero LLM calls. THIS is the
  // branch that retires the legacy line 2731 bug — V2's state-query
  // calls `buildReadinessReport()` and emits `report.summary`, so the
  // upstream-aware data is always surfaced.
  if (intent.isStateQuery || intent.isCheckIn) return "state-query-fast-path"

  // 6. Default: run the LLM agent with the readiness directive injected.
  // This is the slow path — full context load, history, system prompt,
  // tool calls, post-run enforcers. Same source of truth (the report)
  // as the fast paths; just wrapped in an LLM invocation.
  return "normal-agent-turn"
}

// ── Branch renderers ──────────────────────────────────────────────────────────
//
// One renderer per branch. Pure where possible (no I/O); LLM-orchestrated
// branches take a `runFn` dependency for the model call. Every renderer
// returns a `RenderedResponse` carrying the text to post + optional state
// mutations (the legacy handlers mixed text emission and state writes
// inline; V2 separates them so the runner can execute them in defined
// order with full visibility for the structural enforcers).

export type RenderedResponse = {
  readonly text:           string
  readonly stateMutations: readonly StateMutation[]
}

// State mutations are data, not closures. The runner applies them in fixed
// order after the renderer returns. Test mocks verify the right mutations
// fire for each branch.
export type StateMutation =
  | { kind: "clear-pending-approval" }
  | { kind: "clear-pending-decision-review" }
  | { kind: "save-approved-engineering-spec";   filePath: string; content: string }
  | { kind: "save-draft-engineering-spec";      filePath: string; content: string }
  | { kind: "append-message";                   role: "user" | "assistant"; content: string }
  | { kind: "mark-user-oriented";               user:  string }

// Renderer for the state-query fast-path. Pure: takes the report + the user
// message + the feature name, returns the text to emit + the state mutations
// (just the conversation-message append in this branch — no spec writes).
//
// THIS is the branch that fixes the recent manual-test regression. Legacy
// line 2731 hand-built a "Nothing blocking" summary from the engineering
// draft alone; V2 emits `report.summary` which incorporates upstream PM
// findings + design findings + active escalation state.
export function renderStateQueryFastPath(params: {
  report:      ReadinessReport
  userMessage: string
}): RenderedResponse {
  return {
    text:           params.report.summary,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: params.report.summary },
    ],
  }
}

// Stub renderers for the remaining branches. Each throws with a pointer
// at the AGENT_RUNNER_REWRITE_MAP row that owns its V2 implementation.
// Subsequent commits replace these stubs with full implementations + tests.

export function renderApprovalConfirm(): RenderedResponse {
  throw new Error("[V2-NOT-IMPLEMENTED] renderApprovalConfirm — see AGENT_RUNNER_REWRITE_MAP.md row #3 (architect)")
}

export function renderDecisionReviewConfirm(): RenderedResponse {
  throw new Error("[V2-NOT-IMPLEMENTED] renderDecisionReviewConfirm — see AGENT_RUNNER_REWRITE_MAP.md row #1 (architect)")
}

export function renderStaleSpecError(): RenderedResponse {
  throw new Error("[V2-NOT-IMPLEMENTED] renderStaleSpecError — see AGENT_RUNNER_REWRITE_MAP.md row #2 (architect)")
}

export function renderOffTopicRedirect(): RenderedResponse {
  throw new Error("[V2-NOT-IMPLEMENTED] renderOffTopicRedirect — see AGENT_RUNNER_REWRITE_MAP.md row #4 (architect)")
}

export function renderEscalationEngaged(): RenderedResponse {
  throw new Error("[V2-NOT-IMPLEMENTED] renderEscalationEngaged — escalation-reply readOnly path; see AGENT_RUNNER_REWRITE_MAP.md cross-cutting section")
}

export function renderNormalAgentTurn(): Promise<RenderedResponse> {
  throw new Error("[V2-NOT-IMPLEMENTED] renderNormalAgentTurn — main LLM path with readiness directive; see AGENT_RUNNER_REWRITE_MAP.md cross-cutting post-run gates section")
}

// ── Main runner orchestration ─────────────────────────────────────────────────
//
// Entry point. Reads state via dependency-injected `deps`, builds the
// readiness report, classifies the branch, dispatches to the renderer,
// applies state mutations, and emits exactly one Slack response. The deps
// shape lets shadow mode (no-op store/Slack) and production mode (real
// store/Slack) share the same runner code.

export type RunArchV2Deps = {
  // State reads
  readonly loadReport:        () => Promise<ReadinessReportInput>
  // State writes (applied by the runner after the renderer returns)
  readonly applyStateMutation: (m: StateMutation) => Promise<void>
  // Slack emission (single call site per turn)
  readonly emit:              (text: string) => Promise<void>
  // Optional: structured logging hook (for shadow-mode dual-run + observability)
  readonly log?:              (line: string) => void
}

export type RunArchV2Params = {
  readonly userMessage: string
  readonly featureName: string
  readonly intent:      ArchitectIntent
  readonly state:       ArchitectStateFlags
  readonly userId?:     string
  readonly deps:        RunArchV2Deps
}

export async function runArchitectAgentV2(params: RunArchV2Params): Promise<void> {
  const log = params.deps.log ?? ((s: string) => console.log(s))

  // 1. Build the readiness report from current state. Single source of truth.
  const reportInput = await params.deps.loadReport()
  const report      = buildReadinessReport(reportInput)

  // 2. Classify the branch.
  const branch = classifyArchitectBranch({ report, intent: params.intent, state: params.state })

  log(`[V2-ARCHITECT] feature=${params.featureName} branch=${branch} aggregate=${report.aggregate} totalFindings=${report.totalFindingCount}`)

  // 3. Dispatch to the renderer.
  let rendered: RenderedResponse
  switch (branch) {
    case "state-query-fast-path":
      rendered = renderStateQueryFastPath({ report, userMessage: params.userMessage })
      break
    case "approval-confirm":
      rendered = renderApprovalConfirm()
      break
    case "decision-review-confirm":
      rendered = renderDecisionReviewConfirm()
      break
    case "stale-spec-error":
      rendered = renderStaleSpecError()
      break
    case "off-topic-redirect":
      rendered = renderOffTopicRedirect()
      break
    case "escalation-engaged":
      rendered = renderEscalationEngaged()
      break
    case "normal-agent-turn":
      rendered = await renderNormalAgentTurn()
      break
  }

  // 4. Apply state mutations in fixed order.
  for (const mutation of rendered.stateMutations) {
    await params.deps.applyStateMutation(mutation)
  }

  // 5. Single emission. Readiness-aware by construction.
  await params.deps.emit(rendered.text)
}
