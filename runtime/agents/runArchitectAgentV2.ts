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
// is invoked. Passed as data so the classifier stays pure. Optional context
// payloads carry the data needed by approval-confirm and decision-review-
// confirm renderers; populated by the caller (production wiring or test
// fixture) when the corresponding flag is true.
export type ArchitectStateFlags = {
  readonly hasPendingApproval:        boolean
  readonly hasPendingDecisionReview:  boolean
  readonly readOnly:                  boolean   // escalation-reply context

  // When hasPendingApproval is true, the cached spec content + path the
  // user originally approved. The orchestrator re-fetches the current
  // draft from the branch to detect stale cached content (per legacy
  // line 2643). If current !== cached → stale-spec-error branch.
  //
  // DESIGN-REVIEWED: optional context payloads on the state struct per
  // Principle 12. (1) Scales to 1000s of features per tenant because each
  // pending state is keyed by FeatureKey in conversation-store; the
  // payload carries only the cached cell, not the whole feature graph.
  // (2) Owned by conversation-store's pendingApprovals / pendingDecision-
  // Reviews maps; the runner reads the cell, doesn't store it. (3)
  // Cross-cutting: every V2 runner with pending-state branches uses this
  // same shape (PM has pendingApproval, designer has pendingApproval,
  // architect has both); Block M1's scaffold reuses the type.
  readonly pendingApprovalContext?: {
    readonly filePath:    string
    readonly specContent: string
  }

  // When hasPendingDecisionReview is true, the resolved-questions content
  // the architect held for human confirmation (per legacy line 2616).
  // V2 saves this as a draft (not approved) on user affirmation.
  readonly pendingDecisionReviewContext?: {
    readonly filePath:    string
    readonly specContent: string
  }
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

// Renderer for the approval-confirm branch (legacy line 2660, rewrite-map
// row #3). Pure renderer of the post-approval handoff prose. The orchestrator
// is responsible for the staleness check (re-fetching current draft and
// comparing to params.specContent) before invoking this — staleness flips
// the dispatch to renderStaleSpecError instead.
export function renderApprovalConfirm(params: {
  report:           ReadinessReport
  userMessage:      string
  featureName:      string
  filePath:         string
  specContent:      string
  mainChannelName:  string
}): RenderedResponse {
  const text = [
    `The *${params.featureName}* engineering spec is saved and approved. :white_check_mark:`,
    ``,
    `*What happens next:*`,
    `The engineer agents will use this spec to implement the feature — data model, APIs, and UI components.`,
    ``,
    `To confirm the approved state or check where any feature stands, go to *#${params.mainChannelName}* and ask.`,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "clear-pending-approval" },
      { kind: "save-approved-engineering-spec", filePath: params.filePath, content: params.specContent },
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Renderer for the decision-review-confirm branch (legacy line 2628,
// rewrite-map row #1). Pure renderer of the "draft saved" confirmation.
// V2 saves the held content as a DRAFT (not approved) on user affirmation —
// matching legacy behavior; subsequent approval flow will go through
// approval-confirm.
export function renderDecisionReviewConfirm(params: {
  report:        ReadinessReport
  userMessage:   string
  featureName:   string
  filePath:      string
  specContent:   string
  githubOwner:   string
  githubRepo:    string
}): RenderedResponse {
  const branchName = `spec/${params.featureName}-engineering`
  const url = `https://github.com/${params.githubOwner}/${params.githubRepo}/blob/${branchName}/${params.filePath}`
  const text = `Decisions confirmed — engineering spec draft saved.\n\n${url}`
  return {
    text,
    stateMutations: [
      { kind: "clear-pending-decision-review" },
      { kind: "save-draft-engineering-spec", filePath: params.filePath, content: params.specContent },
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Renderer for the stale-spec-error branch (legacy line 2647, rewrite-map
// row #2). Triggered as an orchestrator-side runtime adjustment when the
// current draft on the branch differs from the cached pendingApproval
// content. V2 surfaces the readiness summary alongside the warning so the
// user sees both the staleness signal AND the current state.
export function renderStaleSpecError(params: {
  report:      ReadinessReport
  userMessage: string
}): RenderedResponse {
  const text = [
    `The engineering spec has been modified since the approval was offered. Please review the current version and say *approve* again when ready.`,
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

// Renderer for the off-topic redirect. Pure: takes the report, the user
// message, and the workspace's main-channel name (for the concierge
// redirect target). Per AGENT_RUNNER_REWRITE_MAP row #4 (architect), the
// V2 redirect surfaces BOTH the routing hint AND the current readiness
// state — so the user sees what the architect is set up for plus where
// to go for cross-feature status. This is the readiness-aware upgrade
// over the legacy line 2677 redirect, which only contained the routing
// hint.
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
    `I'm the Architect — I'm here when you're ready to work on data models, APIs, or engineering decisions.`,
  ].join("\n")
  return {
    text,
    stateMutations: [
      { kind: "append-message", role: "user",      content: params.userMessage },
      { kind: "append-message", role: "assistant", content: text },
    ],
  }
}

// Renderer for the escalation-engaged branch (legacy readOnly path,
// rewrite-map cross-cutting section). The architect resumes after an
// upstream agent (PM or designer) has replied to its escalation
// (escalationNotification is set). The dispatcher passes a self-
// contained brief in `params.userMessage` (the PM/designer's reply +
// the original escalation context); the architect's job is to integrate
// it and propose next steps.
//
// Structural enforcer composition (orientation, prose-state, etc.) is
// the production-wiring concern: Block E injects enforcer-wrapped
// runFns into `deps.runLLMForEscalation`. The runner just invokes the
// dep and surfaces the response. This keeps the runner testable in
// isolation (mocked LLM dep) and lets A5 / Block E swap in real
// enforcers without changing the runner's code.
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

// Renderer for the normal-agent-turn branch (legacy main LLM path,
// lines 3224 / 3236 / 3238). Default branch: full LLM run with the
// readiness directive injected. Like escalation-engaged, structural
// enforcer composition (hedge / prose-state / action-claims /
// escalation-directive-contract) is the production-wiring concern;
// `deps.runLLMForNormalTurn` receives an enforcer-wrapped runFn.
//
// V2's normal-agent-turn replaces the legacy post-run-override pattern
// (which mutated the agent's prose AFTER the LLM call to align it with
// platform-queued state — the failed prose-vs-state mismatch fix in
// commit 959c604). In V2, the directive is INJECTED into the prompt
// upfront so the LLM produces compliant prose; the structural enforcer
// (when wired via deps in Block E) verifies and re-runs if needed.
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
  // Workspace-derived constants (loaded from WorkspaceConfig at runner
  // construction; passed through here so the runner stays generic and
  // doesn't import workspace-config directly — keeps the runner pure-
  // testable and tenant-agnostic per CLAUDE.md Principle 2 + 3).
  //
  // DESIGN-REVIEWED: workspace-config injection is the right place per
  // Principle 12. (1) Scales to 1000s of tenants because each tenant has
  // its own WorkspaceConfig and the runner reads through deps — no
  // module-level workspace coupling. (2) Owned by the runner-construction
  // call site (Block E cutover wiring), which already loads
  // WorkspaceConfig once per tenant. (3) Cross-cutting: every V2 runner
  // (architect, designer, PM, future Coder/Reviewer) needs the same
  // workspace-derived constants and follows this same deps-injection
  // pattern; Block M1's scaffold script generates it.
  readonly mainChannelName:   string
  readonly githubOwner:       string
  readonly githubRepo:        string
  // Re-fetches the current spec draft from GitHub. Used by the
  // approval-confirm branch to detect stale cached content (legacy
  // line 2643). Returns null if the file isn't found.
  //
  // DESIGN-REVIEWED: I/O via dependency injection per Principle 12.
  // (1) Scales because each call is per-feature-per-turn (no global
  // state, no batching constraint). (2) Owned by github-client.ts in
  // production; tests inject stubs. (3) Cross-cutting: every V2 runner
  // that needs spec re-fetch (approval-confirm staleness check, future
  // re-audit-on-resume flows) accepts this same dep shape; PM and
  // designer V2 runners will follow the same pattern.
  readonly fetchCurrentDraft: (filePath: string, branchName: string) => Promise<string | null>

  // LLM invocation for the escalation-engaged branch (readOnly resume after
  // upstream agent's reply). Production wiring (Block E) injects an
  // enforcer-wrapped runFn here — the orientation enforcer wraps the model
  // call with bounded retry on missing orientation block. Shadow mode
  // (A5) injects a no-op stub. Tests inject a deterministic mock.
  //
  // DESIGN-REVIEWED: LLM dep injection per Principle 12. (1) Scales because
  // each call is per-feature-per-turn; the wrapper enforcers add bounded
  // overhead (max-retries=1 default). (2) Owned by Block E wiring code,
  // which composes the enforcer chain once per call. (3) Cross-cutting:
  // every V2 runner with an LLM branch follows this same dep shape;
  // PM and designer V2 will inject their own runLLMFor* functions.
  readonly runLLMForEscalation: (input: {
    brief:  string
    report: ReadinessReport
  }) => Promise<string>

  // LLM invocation for the normal-agent-turn branch. Receives the readiness
  // directive (built by buildReadinessReport, included in the report) plus
  // the user message. Production wiring composes hedge / prose-state /
  // action-claims / escalation-directive-contract enforcers around the
  // raw model call.
  readonly runLLMForNormalTurn: (input: {
    directive:   string
    userMessage: string
    report:      ReadinessReport
  }) => Promise<string>

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

  // 3. Dispatch to the renderer. For approval-confirm, the orchestrator
  //    performs an I/O staleness check (re-fetch current draft, compare
  //    to cached) and flips the dispatch to stale-spec-error if the
  //    cached content is no longer current. This keeps the renderers
  //    pure (no I/O) while preserving the legacy line 2643 behavior.
  let rendered: RenderedResponse
  switch (branch) {
    case "state-query-fast-path":
      rendered = renderStateQueryFastPath({ report, userMessage: params.userMessage })
      break

    case "approval-confirm": {
      const ctx = params.state.pendingApprovalContext
      if (!ctx) {
        throw new Error("[V2-ARCHITECT] approval-confirm classified but pendingApprovalContext missing")
      }
      const branchName  = `spec/${params.featureName}-engineering`
      const freshDraft  = await params.deps.fetchCurrentDraft(ctx.filePath, branchName)
      const isStale     = freshDraft !== null && freshDraft !== ctx.specContent
      if (isStale) {
        rendered = renderStaleSpecError({ report, userMessage: params.userMessage })
        log(`[V2-ARCHITECT] feature=${params.featureName} branch=stale-spec-error (was approval-confirm; staleness detected)`)
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

    case "decision-review-confirm": {
      const ctx = params.state.pendingDecisionReviewContext
      if (!ctx) {
        throw new Error("[V2-ARCHITECT] decision-review-confirm classified but pendingDecisionReviewContext missing")
      }
      rendered = renderDecisionReviewConfirm({
        report,
        userMessage:  params.userMessage,
        featureName:  params.featureName,
        filePath:     ctx.filePath,
        specContent:  ctx.specContent,
        githubOwner:  params.deps.githubOwner,
        githubRepo:   params.deps.githubRepo,
      })
      break
    }

    case "stale-spec-error":
      // Reachable only if the classifier directly returned this kind, which
      // it currently doesn't — staleness is detected in the approval-confirm
      // case above. Kept here for completeness; throws to make a future
      // direct-dispatch attempt visible.
      throw new Error("[V2-ARCHITECT] stale-spec-error must be reached via approval-confirm staleness flip, not direct classification")

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

  // 4. Apply state mutations in fixed order.
  for (const mutation of rendered.stateMutations) {
    await params.deps.applyStateMutation(mutation)
  }

  // 5. Single emission. Readiness-aware by construction.
  await params.deps.emit(rendered.text)
}
