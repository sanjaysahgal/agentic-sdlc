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
export const CODE_MARKER = "bug-10-origin-agent-routing"

export function bootFingerprint(): BootFingerprint {
  let commit = "unknown"
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    // git unavailable or not a repo — keep "unknown"
  }
  return { commit, codeMarker: CODE_MARKER }
}
