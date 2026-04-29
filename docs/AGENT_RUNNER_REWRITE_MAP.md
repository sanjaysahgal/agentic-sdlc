# AGENT_RUNNER_REWRITE_MAP — legacy exits → V2 single-path strategies

## Context

Block A2 deliverable of the approved system-wide plan
(`~/.claude/plans/rate-this-plan-zesty-tiger.md`). This map enumerates every
user-visible response-emitting call (`update(arg)` /
`client.chat.postMessage(...)`) inside the three legacy agent handlers
(`runPmAgent`, `runDesignAgent`, `runArchitectAgent` in
`interfaces/slack/handlers/message.ts`) and names the V2 single-path
implementation strategy for each.

The line numbers and snippets come from the Block A1 spike snapshot at
`tests/invariants/__snapshots__/response-path-coverage.test.ts.snap`. The
spike is the structural ground truth; this doc is the human-readable
rewrite plan that A4 (architect V2), A6 (designer V2), and A7 (PM V2)
implement against.

## V2 architecture invariant

Every V2 runner has exactly one entry, one return statement that emits
to the user, and one source of truth for state representation:

```
async function run<Agent>AgentV2(params): Promise<void> {
  // 1. Load state + spec content + escalation state (deterministic, no decisions)
  // 2. Build readiness report (single call to buildReadinessReport)
  // 3. Decide rendering branch from report.aggregate and intent classification
  //    (state-query / off-topic / pending-confirmation / escalation-engaged / normal)
  // 4. Render: either deterministic summary from the report OR run the LLM
  //    with the readiness directive injected
  // 5. Emit response (single update() call) — readiness-aware by construction
}
```

The B1 invariant test (productionalized from A1) asserts every V2 runner
has zero not-readiness-aware emissions. Branch logic lives in pure
functions (`buildReadinessSummary(report)`, `buildEscalationCTA(report,
decision)`, etc.) — the runner orchestrates, the renderers produce the
text.

## Status placeholders (excluded from coverage by convention)

`update("_X is thinking..._")` calls (italics-wrapped markdown) are
spinners, not user-visible responses. They communicate progress, not
content. The A1 spike's `isStatusPlaceholder` filter excludes them; V2
runners may continue to emit placeholders without readiness coverage.

## A3 — Fast-path decision

**Decision: V2 preserves a deterministic fast-path for state-query
check-ins ("hi", "where are we", etc.), BUT the fast-path renders user-
facing summary from `buildReadinessReport()` — never from spec content
alone.**

Rationale:
- Always-LLM increases token cost on a routine cadence (check-ins are
  frequent). Unacceptable.
- Skipping the readiness builder is what created the bug we just fixed
  (the legacy state-query fast-path bypassed the readiness directive).
  The fix is not to delete the fast-path — it's to make the fast-path
  call the readiness builder.
- Single-path discipline is preserved because `buildReadinessReport()`
  is the single source of truth. Fast-path = deterministic rendering
  branch. Slow-path = LLM rendering branch. Both consume the same
  report.

Implementation: add `renderReadinessUserSummary(report)` to
`runtime/readiness-builder.ts` that produces user-facing prose from the
report's `aggregate` state. The fast-path branch in each V2 runner calls
this helper and emits the result. The slow-path branch injects the
report's `directive` into the LLM prompt (existing behavior).

## runArchitectAgent → runArchitectAgentV2

Source range: `interfaces/slack/handlers/message.ts:2596–~3245`.

Five not-readiness-aware emissions found by A1 spike. Each row is a V2
requirement.

**STATUS: 7 of 7 branches implemented in `runtime/agents/runArchitectAgentV2.ts` (Block A4 step 5 — all stubs gone).** State-write branches (rows #1–#3) are pure renderers + orchestrator-side staleness check. State-query (row #5) emits `report.summary` directly. Off-topic (row #4) interleaves redirect with summary. Cross-cutting LLM branches (escalation-engaged + normal-agent-turn) call `deps.runLLMForEscalation` / `deps.runLLMForNormalTurn`; production wiring (Block E) injects enforcer-wrapped runFns. V2 is NOT yet wired into the dispatcher — production traffic continues through legacy `runArchitectAgent`. Block A5 wires shadow-mode dual-run; Block E cuts over.

| # | Legacy line | Behavior | V2 strategy |
|---|---|---|---|
| 1 | 2628 | `pendingDecisionReview` confirm → spec saved, confirmation message posted | V2 emits via main path. The runner detects `state.pendingDecisionReview && isAffirmative(msg)`, performs the writeback, then calls `buildReadinessReport()` (the spec just changed; report reflects new state), renders an aggregate-aware confirmation including any newly-surfaced upstream findings if the post-save audit reveals them. Response is readiness-aware by construction. |
| 2 | 2647 | Stale-spec error after `pendingApproval` was offered → spec changed under the user; warning posted | V2 keeps the stale-spec check (state-corruption recovery — Block D2 territory) but emits the warning AFTER calling `buildReadinessReport()` so the warning includes current upstream + own-spec status. Wraps the warning text in the readiness summary so the user sees both: "Spec changed since approval was offered. Current state: [readiness summary]." Tag-eligible (`@readiness-irrelevant`) only if D2 confirms the stale-spec path is purely a recovery branch and never the user's primary information channel. |
| 3 | 2660 | `pendingApproval` confirm → spec approved, handoff message posted | V2 emits via main path. After the approval write succeeds, `buildReadinessReport()` reflects the now-approved-on-main state. The handoff message is rendered from the report's `aggregate=ready` branch via `renderApprovalHandoff(report)`. |
| 4 | 2677 | Off-topic redirect → "ask the concierge" message posted | V2 keeps the off-topic detection (it's a routing concern, not a content concern) but the redirect message is `renderOffTopicRedirect(report)` which surfaces "the engineering spec for `<feature>` is currently [aggregate state]; for status, ask the concierge." Surface state alongside the redirect so the user sees both. |
| 5 | **2731** | **State-query fast-path** ← the manual-test bug | V2 implements per A3 decision: fast-path calls `buildReadinessReport()` and emits `renderReadinessUserSummary(report)`. No LLM call. Aggregate state drives the prose ("Engineering spec is internally complete. PM has 4 unresolved findings + Design has 26 — resolve those first."). **This single change retires the bug that motivated the entire system-wide plan.** |

Plus the post-readiness emissions (lines 3224, 3236, 3238 — the main
LLM-agent response variants). These are already readiness-aware in the
legacy code because the readiness directive is injected into the LLM
prompt. V2 keeps this behavior but replaces the post-run override
(commit `959c604`) with structurally-equivalent inline rendering: the
runner builds the CTA from `report.activeEscalation` directly, not as a
post-hoc patch over the agent's prose.

## runDesignAgent → runDesignAgentV2

Source range: `interfaces/slack/handlers/message.ts:1286–~1850`.

Five not-readiness-aware emissions found by A1 spike.

**STATUS: 6 of 6 branches implemented in `runtime/agents/runDesignAgentV2.ts` (Block A6 — all designer branches complete).** Designer differs from architect in: no `pendingDecisionReview` branch (architect-only concern), off-topic redirect identifies as "UX Designer" not "Architect", approval-confirm handoff names the architect (next phase per `agent-registry.ts`) instead of engineer agents, save mutation type is `save-approved-design-spec` (distinct from architect's engineering-spec save), upstream audits are PM only. Same single-path invariant: one entry, one user-emission return per branch, `buildReadinessReport()` is the single source of truth. V2 is NOT yet wired into the dispatcher — production traffic continues through legacy `runDesignAgent`. Block A6 shadow wiring follows the runner commit; cutover is Block E.

| # | Legacy line | Behavior | V2 strategy | Status |
|---|---|---|---|---|
| 1 | 1310 | Stale-spec error after `pendingApproval` was offered | Same shape as architect #2: warning includes current readiness summary; tag-eligible only after D2 review. | DONE — `renderStaleSpecError` |
| 2 | 1324 | `pendingApproval` confirm → design spec approved, handoff to architect | V2 emits via `renderApprovalConfirm`; handoff text names "software architect" as the next-phase agent (resolved from `agent-registry.ts`'s phase ownership; not hardcoded). | DONE — `renderApprovalConfirm` |
| 3 | 1346 | Off-topic redirect | Same shape as architect #4 — surfaces `report.summary` alongside the redirect; identifies as "UX Designer". | DONE — `renderOffTopicRedirect` |
| 4 | 1560 | State-query fast-path → `buildDesignStateResponse()` + `stateActionMenu` | V2 fast-path emits `report.summary` directly (single source of truth); action-menu rendering moved to a deps-injected post-render hook in production wiring (suppressed in `escalation-active` aggregate). | DONE — `renderStateQueryFastPath` |
| 5 | 1580 | Summarization-warning notice → "Context from earlier was summarized" | This is a **non-content notice**, analogous to a status placeholder. V2 emits it tagged `@readiness-irrelevant` because the message is a meta-system advisory, not a state report. The B1 gate honors the tag. | DEFERRED to production wiring — emitted from the wrapper that detects context-window summarization, tagged `@readiness-irrelevant`, NOT inside the V2 runner |

## runPmAgent → runPmAgentV2

Source range: `interfaces/slack/handlers/message.ts:1142–~1290`.

Three not-readiness-aware emissions found by A1 spike. **PM has no
upstream spec, so `buildReadinessReport()` is called with `upstreamAudits:
[]`. The report's `aggregate` reflects PM's own product-spec audit only:
`ready` (clean), `dirty-own` (PM's own findings), `escalation-active`
(rare for PM — only happens if the architect or designer escalated to PM
during their phase), or `ready-pending-approval`.**

**STATUS: 6 of 6 branches implemented in `runtime/agents/runPmAgentV2.ts` (Block A7 — all PM branches complete).** PM differs from designer in: callingAgent is `"pm"`, ownSpec specType `"product"`, upstreamAudits always `[]` (PM is head of chain), save mutation kind is `save-approved-product-spec`, approval-confirm handoff names "UX designer" as next-phase agent (resolved via `agent-registry.ts`), off-topic redirect identifies as "Product Manager". **Cross-agent parity (Principle 15):** legacy PM had no off-topic-redirect or state-query-fast-path branches; V2 adds them so the same single-path discipline + same bug-class retirement (state-query fast-path) holds for PM as for the other two agents. V2 is NOT yet wired into the dispatcher — production traffic continues through legacy `runPmAgent`. Subsequent commit wires PM shadow-mode dual-run; Block E cuts over.

| # | Legacy line | Behavior | V2 strategy | Status |
|---|---|---|---|---|
| 1 | 1230 | Stale-spec error after `pendingApproval` was offered | Same shape as architect #2 / designer #1. Warning includes current readiness summary (PM's own product-spec audit findings if any). | DONE — `renderStaleSpecError` |
| 2 | 1244 | `pendingApproval` confirm → product spec approved, handoff to designer | V2 emits via `renderApprovalConfirm`; handoff text names "UX designer" as the next-phase agent (resolved from `agent-registry.ts`'s phase ownership; not hardcoded). | DONE — `renderApprovalConfirm` |
| 3 | 1345 | Main response post-LLM-run | Already after the LLM run; readiness-aware in V2 because V2's PM runner calls `buildReadinessReport()` upfront and injects the directive into `renderNormalAgentTurn`. The A1 spike flagged this as not-aware because the legacy PM handler doesn't call `buildReadinessReport()` at all. V2 fixes this structurally. | DONE — `renderNormalAgentTurn` |
| Added by V2 | (n/a) | Off-topic redirect | Added per Principle 15 cross-agent parity — legacy PM had no off-topic branch; V2 adds one to retire the same bug class for PM as for architect/designer. Identifies as "Product Manager"; surfaces `report.summary` alongside the redirect. | DONE — `renderOffTopicRedirect` |
| Added by V2 | (n/a) | State-query fast-path | Added per Principle 15 — legacy PM routed all check-ins through the LLM. V2 fast-path emits `report.summary` directly (single source of truth, retires the same class of bug as architect/designer state-query fast-paths). | DONE — `renderStateQueryFastPath` |

## Cross-cutting: escalation-engaged readOnly path

Architect/designer/PM can run in `readOnly=true` mode when invoked via
the escalation-reply path (the upstream agent was @-mentioned, the user
replied; the dispatcher injects a brief and runs the originating agent
in resume mode). Today this skips most of the response-path logic
(`escalationBeforeRun` snapshot, the post-run hedge gate, etc.).

V2 unifies this: the escalation-engaged path is just the
`escalation-active` aggregate state of the readiness report. The runner
sees `report.aggregate === "escalation-active"` and renders the
escalation brief + invokes the LLM with the orientation enforcer
(`runtime/orientation-enforcer.ts`) wrapping the `runFn`. The brief +
orientation directive together replace the legacy readOnly bespoke
logic.

This collapses the architect-readiness directive's `readOnly`
suppression rule into a clean aggregate-state branch — no special-case
gating.

## Cross-cutting: post-run gates

Legacy post-run logic includes: hedge detection (`detectHedgeLanguage`),
verifyActionClaims, prose-state-mismatch override (`959c604`), action-
menu rendering, platform-status-line prefix, escalation auto-trigger
(`offer_pm_escalation` / `offer_upstream_revision`).

V2 strategy: each of these becomes a structural enforcer (same shape as
`runtime/orientation-enforcer.ts`) wrapping the LLM `runFn`. The
runner's pseudocode:

```ts
const enforcedRun = compose(
  enforceOrientationOnResume,
  enforceProseStateAlignment,
  enforceActionClaimsVerified,
  enforceHedgeFreeProse,
  enforceEscalationDirectiveContract,
)(rawRunFn, ctx)

const response = await enforcedRun(null)
await update(renderFinal(response, report))  // single emission, readiness-aware via report
```

Each enforcer is a pure detector + override builder + bounded retry
orchestrator (the pattern from I21). They compose because they share
the same `runFn` shape. None mutate state directly.

This retires the legacy post-run override at line ~3115 (the prose-
state mismatch fix from `959c604`) — replaced by
`enforceProseStateAlignment`, a proper structural enforcer.

## Verification (Block A4–A7 entry criteria)

Before each V2 runner is considered ready for shadow verification:
1. The B1 invariant test (productionalized from A1) reports zero
   not-readiness-aware emissions in the V2 runner's source file.
2. Every legacy emission row in this map has a corresponding V2
   implementation.
3. All MT-N scenarios in `MANUAL_TESTS.md` for that agent pass against
   the V2 runner in shadow mode (legacy still active in production).
4. 48h of production dual-run logs zero behavior divergences (per
   Block A4/A6/A7's shadow-verification gate).

If any row above doesn't match the implemented V2 runner, the
implementation is incomplete. The map is the contract.
