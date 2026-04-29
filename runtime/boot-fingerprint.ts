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
//   v2-architect-shadow (Block A5) — adds [V2-ARCHITECT-SHADOW] log on every
//     architect-bound message; legacy production behavior unchanged. Shadow
//     wrapper is observation-only (no Slack posts, no state mutations, no
//     LLM calls). 48h burn-in gates A6 (designer V2).
//   readiness-directive+prose-state-fix — adds [READINESS] log in architect
//     + designer paths, [DISMISS-CLASSIFIER] log in dismiss classifier,
//     PM-first conversational override.
export const CODE_MARKER = "v2-architect-shadow"

export function bootFingerprint(): BootFingerprint {
  let commit = "unknown"
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    // git unavailable or not a repo — keep "unknown"
  }
  return { commit, codeMarker: CODE_MARKER }
}
