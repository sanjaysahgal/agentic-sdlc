// Boot fingerprint — the commit currently checked out plus a code marker the
// running process can attest to. Lets manual-test debugging start from
// "is the bot actually on the version you think?" instead of guessing.
//
// `commit` is read from git at startup. If git is unavailable (CI without .git),
// it falls back to "unknown".
//
// `codeMarker` is hand-curated and bumped whenever we ship a production fix
// that introduces a specific log line we want to verify in production. Bumping
// it forces the running bot to attest in its [BOOT] log that it loaded the new
// code — covering the case where `tsx watch` silently fails to reload a module
// (a real footgun observed 2026-04-29).

import { execSync } from "child_process"

export type BootFingerprint = {
  readonly commit:     string
  readonly codeMarker: string
}

// IMPORTANT: bump this every time you ship a production fix that adds a log
// line you want to verify is firing. The marker is the contract between the
// fix author and the manual tester: "if you don't see this marker in [BOOT],
// you're not running the fix yet."
//
// History (most recent first):
//   b9-category-rule-deterministic-application — manifest B9 fix
//     (regression catalog bug #16). Adds runtime/category-rule-extractor.ts —
//     pure deterministic extractor (Principle 11) for universal substitution
//     directives in PM recommendations ("any 'immediately' becomes 'within 1
//     second'"). Wired into runtime/pm-escalation-spec-writer.ts: extracts
//     rules → applies them via word-boundary string replace BEFORE Haiku
//     merge → post-Haiku residual check fires findResidualCategoryViolations
//     and re-applies if Haiku re-introduced any from-word. Eliminates the
//     N-round-trip pattern caused by Haiku's inconsistent application of
//     PM substitution directives. Log markers `[ESCALATION] B9: extracted`
//     and `[ESCALATION] B9: Haiku's merge re-introduced`. MT-23 spot-check.
//   b7-readonly-brief-clause — manifest B7 fix (regression catalog bug #15).
//     Adds runtime/readonly-brief-clause.ts exporting
//     READONLY_AGENT_BRIEF_CLAUSE — the shared constant declaring the
//     no-spec-writing-tools contract for agents invoked with readOnly:true.
//     Wired into all 4 readOnly brief sites in
//     interfaces/slack/handlers/message.ts (designer→PM, designer→architect,
//     architect→PM, architect→design) per Principle 15 cross-agent parity.
//     Structural invariant tests/invariants/readonly-brief-clause.test.ts
//     pins both halves: constant exists with right semantics + every brief
//     interpolates it. Retires the prose-vs-state mismatch class at the
//     brief-prompt layer (Block N2's runtime stripper handles the same
//     class at the response layer; this is the cause-side fix). MT-22.
//   b8-spec-write-ownership — manifest B8 fix (regression catalog bug #14).
//     Codified CLAUDE.md Principle 16 (Spec write ownership — resolved
//     decisions land only in the owner's spec; carve-outs for preseed-
//     open-items and reciprocal cleanup are explicit). Removed the
//     patchEngineeringSpecWithDecision call from the architect's
//     upstream-revision-reply branch in interfaces/slack/handlers/message.ts
//     (PM/designer-authored content was being recorded under
//     `### Architect Decision (pre-engineering)` heading in the
//     architect-owned engineering spec — wrong author, wrong spec, wrong
//     framing, append-only layout). Architect re-reads upstream spec on
//     every run; no information lost. Structural invariant
//     tests/invariants/spec-write-ownership.test.ts AST-greps every
//     writeback callsite and pins to documented allow-list. MT-21 spot-check.
//   b6-architect-escalation-consolidation — manifest B6 fix (regression
//     catalog bug #13). Adds deterministic count helpers
//     (`countPlatformGapItems`, `countAgentGapItems`) to
//     `runtime/upstream-notice-format.ts` and a post-run consolidation
//     gate in the architect path at `interfaces/slack/handlers/message.ts`.
//     When the architect calls `offer_upstream_revision(target=pm|design)`
//     and the agent's question enumerates fewer items than
//     `auditPmSpec`/`auditDesignSpec` detected, the gate overrides
//     `pendingEscalation.question` with the consolidated platform brief.
//     Eliminates the N-round-trip pattern. Both PM and design targets
//     covered per Principle 15. Log marker `[ESCALATION-GATE] B6:`.
//     MT-20 is the spot-check scenario.
//   b11-v1-content-verifier-pm-escalation-resume — manifest B11 v1 fix
//     (was Bug G, regression catalog bug #12). Adds deterministic
//     `runtime/spec-content-verifier.ts` and wires it log-only into the PM
//     escalation-resume site at `interfaces/slack/handlers/message.ts`
//     (both `arch-upstream-escalation-confirmed` and `arch-upstream-continuation`
//     branches). Detects two classes of AC-citation hallucination:
//     `ac-does-not-exist` (PM cites AC# beyond spec count) and
//     `claimed-wording-not-in-ac` (quoted phrase doesn't appear in cited AC).
//     v1 emits `[CONTENT-VERIFIER]` log only — no user-facing change. v2 will
//     re-prompt the agent and gate the downstream patcher. MT-19 is the
//     real-Slack scenario depending on this marker.
//   d5-escalation-notification-survives-restart — manifest D5 (was Bug A) fix:
//     EscalationNotification now carries `timestamp` (set by
//     setEscalationNotification). Startup uses clearStaleEntries with
//     PENDING_STATE_TTL_MS (24h) instead of clear-all. Notifications survive
//     bot restart within TTL. Resolves J3↔D5 collision: CODE_MARKER bump
//     can now happen mid-escalation without losing user state. MT-18
//     verifies end-to-end. Regression catalog bug #11.
//   bug-10-origin-agent-routing — bug #10 fix: PendingEscalation now carries
//     originAgent (required field). Router reads it directly instead of
//     guessing based on targetAgent. Architect→PM escalations now resume
//     correctly to architect (previously routed to designer). MT-17
//     verifies end-to-end against real Slack.
//   block-n+n2-stripper-fixes — Block N replaces the legacy hedge gate
//     with `enforceNoHedging` (3 sites, [HEDGE-GATE] <agent>: rewrote N
//     deferral phrase(s) log line) + injects buildAntiDeferralBlock into
//     PM/Designer/Architect prompts. Block N2 changes the tool-name +
//     platform-commentary strippers in claude-client.ts to sentence-drop
//     instead of token-drop ([AGENT-RESPONSE] dropping sentences ... log
//     lines). MT-7, MT-8, MT-16 are the manual scenarios that depend on
//     this marker.
//   v2-pm-shadow (Block A7) — adds [V2-PM-SHADOW] log on every PM-bound
//     message; legacy production behavior unchanged. Same fire-and-forget
//     observation pattern as the architect/designer shadows. Block A
//     (architect + designer + PM V2 runners) is feature-complete after
//     this commit. 48h burn-ins for all three (MT-4, MT-5, MT-6) must
//     accumulate green before Block E cutover.
//   v2-designer-shadow (Block A6) — adds [V2-DESIGNER-SHADOW] log on every
//     designer-bound message; legacy production behavior unchanged. Same
//     fire-and-forget observation pattern as v2-architect-shadow. 48h
//     burn-in (MT-5) gates A7 (PM V2).
//   v2-architect-shadow (Block A5) — adds [V2-ARCHITECT-SHADOW] log on every
//     architect-bound message; legacy production behavior unchanged. Shadow
//     wrapper is observation-only (no Slack posts, no state mutations, no
//     LLM calls). 48h burn-in gates A6 (designer V2).
//   readiness-directive+prose-state-fix — adds [READINESS] log in architect
//     + designer paths, [DISMISS-CLASSIFIER] log in dismiss classifier,
//     PM-first conversational override.
export const CODE_MARKER = "b9-category-rule-deterministic-application"

export function bootFingerprint(): BootFingerprint {
  let commit = "unknown"
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    // git unavailable or not a repo — keep "unknown"
  }
  return { commit, codeMarker: CODE_MARKER }
}
