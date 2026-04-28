/**
 * shadow-coverage-report.ts
 *
 * Correlates two log line types from production logs/bot-YYYY-MM-DD.log files:
 *
 *   [ROUTING-V2-PROPOSED] feature=<x> thread=<t> phase=<y> entry=<z>
 *                         kind=<k> agent=<a> mode=<m>
 *      — emitted by runtime/routing/shadow.ts at handler entry. Captures the
 *        new pure router's decision before the old code path runs.
 *
 *   [ROUTER] branch=<branch> [feature=<x>] [targetAgent=<a>] [target=<a>] [...]
 *      — emitted by interfaces/slack/handlers/message.ts as the old code
 *        decides which branch to execute. 15 distinct branch tags map to
 *        v2 RoutingDecision kinds (see BRANCH_TO_V2_KIND below).
 *
 * For every (feature, thread) pair, the correlator emits one of:
 *   convergence  — both decisions agree
 *   divergence   — they disagree (printed with full context, exit 1)
 *   skipped      — branch tag has no clean v2 mapping (auto-close paths,
 *                  parent new-thread tag); not counted toward gate (b)
 *
 * Exit code 0 = zero divergences in the time window (gate (b) passes for the
 * sample). Non-zero = at least one divergence; resolve by either fixing the
 * spec/router or hand-confirming the cell as a known FLAG.
 *
 * The correlator goes inert at Phase 6 — when the old `[ROUTER] branch=…` log
 * lines are deleted with the old code path, this script runs but finds nothing
 * to correlate. The proposal logs survive (Phase 4 wires the new router as
 * primary) and become a redundant audit log rather than a divergence detector.
 *
 * Usage:
 *   npx tsx scripts/shadow-coverage-report.ts [--logs logs/]
 *                                              [--since YYYY-MM-DD]
 *                                              [--cell-detail]
 *                                              [--allow-flag FLAG-X]
 *   or:  npm run shadow:report
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

const DEFAULT_LOG_DIR = resolve(__dirname, "..", "logs")

// ── Line parsing ──────────────────────────────────────────────────────────────

type ProposalLine = {
  type:    "proposal"
  feature: string
  thread:  string
  phase?:  string
  entry?:  string
  kind:    string
  agent:   string
  mode:    string
  raw:     string
  file:    string
  lineNo:  number
}

type BranchLine = {
  type:        "branch"
  branch:      string
  feature?:    string
  targetAgent?: string
  raw:         string
  file:        string
  lineNo:      number
}

type LogEntry = ProposalLine | BranchLine

function parseLine(raw: string, file: string, lineNo: number): LogEntry | null {
  // Match leading-position [ROUTING-V2-PROPOSED] markers anywhere in the line —
  // winston prepends a timestamp + level so the marker is not at column 0.
  if (raw.includes("[ROUTING-V2-PROPOSED]")) {
    const out = parseKvFields(raw)
    if (!out.feature || !out.thread) return null
    return {
      type:    "proposal",
      feature: out.feature,
      thread:  out.thread,
      phase:   out.phase,
      entry:   out.entry,
      kind:    out.kind ?? "",
      agent:   out.agent ?? "-",
      mode:    out.mode ?? "-",
      raw, file, lineNo,
    }
  }
  if (raw.includes("[ROUTER]") && raw.includes("branch=")) {
    const out = parseKvFields(raw)
    if (!out.branch) return null
    // The targetAgent appears as `targetAgent=` for design escalations and
    // `target=` for architect-upstream escalations. Either matches.
    const target = out.targetAgent ?? out.target
    return {
      type:        "branch",
      branch:      out.branch,
      feature:     out.feature,
      targetAgent: target,
      raw, file, lineNo,
    }
  }
  return null
}

function parseKvFields(line: string): Record<string, string> {
  // Fields are space-separated `key=value` pairs. Values may be quoted (with
  // double quotes) and contain spaces; bare values run until whitespace. Use a
  // single regex with two alternatives.
  const out: Record<string, string> = {}
  const re = /(\w+)=("([^"]*)"|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[4]
  }
  return out
}

function loadLogs(logDir: string, since?: string): LogEntry[] {
  if (!existsSync(logDir)) return []
  const files = readdirSync(logDir)
    .filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .filter((f) => !since || f >= `bot-${since}.log`)
    .sort()

  const out: LogEntry[] = []
  for (const f of files) {
    const path = join(logDir, f)
    const text = readFileSync(path, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i], f, i + 1)
      if (parsed) out.push(parsed)
    }
  }
  return out
}

// ── Branch → expected v2 RoutingDecision shape ────────────────────────────────
//
// Each entry maps an old [ROUTER] branch tag to the v2 RoutingDecision shape
// the new pure router should produce in the same situation. Mapping is best-
// effort:
//   - exact: kind + agent (and optionally mode) must match
//   - lenient: kind matches; agent or mode skipped (e.g. escalation-reply
//     can map to either resume-after-escalation or run-escalation-continuation
//     depending on standalone-confirmation; the correlator can't tell from the
//     branch log alone, so it accepts both)
//   - skip: branch has no clean single-decision v2 equivalent (post-agent
//     auto-close paths fire dispatcher re-evaluate, not one decision)

type ExpectedShape = {
  kind:    string | string[]   // string[] means "any of these is acceptable"
  agent?:  string
  mode?:   string
}

function branchToV2Kind(b: BranchLine): ExpectedShape | "skip" {
  switch (b.branch) {
    case "confirmed-pm": {
      const readonly = /\(read-only slash override\)/.test(b.raw)
      return { kind: "run-agent", agent: "pm", mode: readonly ? "read-only-consultant" : "primary" }
    }
    case "confirmed-architect":
    case "confirmed-architect-auto-continue":
      return { kind: "run-agent", agent: "architect", mode: "primary" }
    case "confirmed-design": {
      const readonly = /\(read-only slash override\)/.test(b.raw)
      return { kind: "run-agent", agent: "ux-design", mode: readonly ? "read-only-consultant" : "primary" }
    }
    case "confirmed-design-auto-continue":
      return { kind: "run-agent", agent: "ux-design", mode: "primary" }
    case "new-thread-design":
      return { kind: "run-agent", agent: "ux-design" }
    case "new-thread-architect":
      return { kind: "run-agent", agent: "architect" }
    case "new-thread":
      // Parent tag — a more specific sub-branch follows. Skip the parent so we
      // don't double-count the same routing decision.
      return "skip"
    case "pending-escalation-confirmed":
      return {
        kind:  "run-escalation-confirmed",
        agent: canonicalize(b.targetAgent),
      }
    case "escalation-continuation":
      return {
        kind:  "run-escalation-continuation",
        agent: canonicalize(b.targetAgent),
      }
    case "escalation-reply":
      // Ambiguous: standalone confirmation → resume-after-escalation; otherwise
      // → run-escalation-continuation. Branch log doesn't say which the old
      // code did. Accept either — the cell-level matrix tests already pin the
      // exact decision.
      return { kind: ["resume-after-escalation", "run-escalation-continuation"] }
    case "arch-upstream-escalation-confirmed":
      return {
        kind:  "run-escalation-confirmed",
        agent: canonicalize(b.targetAgent),
      }
    case "arch-upstream-continuation":
      return {
        kind:  "run-escalation-continuation",
        agent: canonicalize(b.targetAgent),
      }
    case "arch-upstream-revision-reply":
      return { kind: "resume-after-escalation", agent: "architect" }
    case "hold-pending-escalation":
      // Universal-guard hold path. The branch log was added in Phase 3 Stage 3
      // so the correlator can pair the proposal with this exit (previously the
      // hold path returned without any branch log, leaving proposals to mis-pair
      // with later turns' branches).
      return { kind: "show-hold-message", agent: canonicalize(b.targetAgent) }
    case "escalation-auto-close":
    case "escalation-auto-close-arch":
      // Post-agent dispatcher path; v2 expresses this as a re-evaluate
      // PostEffect, not a single RoutingDecision. The proposal log captured
      // the FIRST decision (the agent run); the auto-close fires after the
      // agent finished. Skip — the proposal/branch already paired earlier.
      return "skip"
    default:
      return "skip"
  }
}

function canonicalize(target: string | undefined): string | undefined {
  if (!target) return undefined
  return target === "design" ? "ux-design" : target
}

// ── Correlation ───────────────────────────────────────────────────────────────

type Divergence = {
  feature:       string
  thread:        string
  proposalRaw:   string
  branchRaw:     string
  expectedKind:  string
  expectedAgent?: string
  proposedKind:  string
  proposedAgent: string
  proposedMode:  string
  file:          string
  proposalLine:  number
  branchLine:    number
}

function correlate(entries: LogEntry[]): {
  proposals:    number
  branches:     number
  paired:       number
  convergences: number
  divergences:  Divergence[]
  skipped:      number
  unpaired:     number
} {
  // Stream-pair: walk in chronological order (file, then line number); maintain
  // a queue of pending proposals per (feature, thread). When a branch line
  // appears for the same (feature, thread), pair with the oldest pending
  // proposal. Branch lines without a feature= field pair with the most recent
  // proposal in the same file (best-effort).

  const sorted = [...entries].sort((a, b) =>
    a.file.localeCompare(b.file) || a.lineNo - b.lineNo,
  )

  const pending = new Map<string, ProposalLine[]>()  // "feature|thread" → queue
  const divergences: Divergence[] = []
  let proposals = 0
  let branches = 0
  let paired = 0
  let convergences = 0
  let skipped = 0
  let unpaired = 0

  for (const entry of sorted) {
    if (entry.type === "proposal") {
      proposals += 1
      const k = `${entry.feature}|${entry.thread}`
      const q = pending.get(k) ?? []
      q.push(entry)
      pending.set(k, q)
      continue
    }
    branches += 1
    const expected = branchToV2Kind(entry)
    if (expected === "skip") { skipped += 1; continue }

    // Queue-based pairing: shift the oldest proposal for this branch's
    // (feature, thread). Branches without a feature= field are unpaired —
    // every branch log in the codebase carries feature= per the post-Phase-3
    // logging contract; missing it surfaces as unpaired so we notice.
    let proposal: ProposalLine | undefined
    if (entry.feature) {
      for (const [k, q] of pending) {
        if (k.startsWith(entry.feature + "|") && q.length > 0) {
          proposal = q.shift()
          if (q.length === 0) pending.delete(k)
          break
        }
      }
    }
    if (!proposal) { unpaired += 1; continue }

    paired += 1
    const div = compare(proposal, entry, expected)
    if (div) divergences.push(div)
    else convergences += 1
  }

  return { proposals, branches, paired, convergences, divergences, skipped, unpaired }
}

function compare(p: ProposalLine, b: BranchLine, expected: ExpectedShape): Divergence | null {
  const expectedKinds = Array.isArray(expected.kind) ? expected.kind : [expected.kind]
  const kindOk = expectedKinds.includes(p.kind)
  const agentOk = !expected.agent || p.agent === expected.agent
  const modeOk = !expected.mode || p.mode === expected.mode
  if (kindOk && agentOk && modeOk) return null
  return {
    feature:        p.feature,
    thread:         p.thread,
    proposalRaw:    p.raw,
    branchRaw:      b.raw,
    expectedKind:   expectedKinds.join("|"),
    expectedAgent:  expected.agent,
    proposedKind:   p.kind,
    proposedAgent:  p.agent,
    proposedMode:   p.mode,
    file:           p.file,
    proposalLine:   p.lineNo,
    branchLine:     b.lineNo,
  }
}

// ── Public API for tests ──────────────────────────────────────────────────────

export function correlateLines(rawLines: string[], file = "fixture.log"): ReturnType<typeof correlate> {
  const entries: LogEntry[] = []
  rawLines.forEach((line, idx) => {
    const parsed = parseLine(line, file, idx + 1)
    if (parsed) entries.push(parsed)
  })
  return correlate(entries)
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

function isMain(): boolean {
  // tsx invokes the file directly; vitest imports it as a module. Only run the
  // CLI side-effects when invoked directly.
  return require.main === module
}

function main() {
  const args = process.argv.slice(2)
  const logIdx = args.indexOf("--logs")
  const sinceIdx = args.indexOf("--since")
  const detail = args.includes("--cell-detail")
  const logDir = logIdx >= 0 ? resolve(args[logIdx + 1]) : DEFAULT_LOG_DIR
  const since  = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined

  const entries = loadLogs(logDir, since)
  const result = correlate(entries)

  console.log(`[shadow-report] log directory: ${logDir}`)
  console.log(`[shadow-report] since: ${since ?? "all"}`)
  console.log(`[shadow-report] proposals: ${result.proposals}`)
  console.log(`[shadow-report] branches: ${result.branches}`)
  console.log(`[shadow-report] paired: ${result.paired}`)
  console.log(`[shadow-report] convergences: ${result.convergences}`)
  console.log(`[shadow-report] divergences: ${result.divergences.length}`)
  console.log(`[shadow-report] skipped (no v2 mapping): ${result.skipped}`)
  console.log(`[shadow-report] unpaired branches: ${result.unpaired}`)
  console.log()

  if (result.divergences.length === 0) {
    if (result.proposals === 0 && result.branches === 0) {
      console.log("[shadow-report] NO DATA — no [ROUTING-V2-PROPOSED] or [ROUTER] branch lines found in the log window")
      return
    }
    console.log("[shadow-report] PASS — zero divergences across the paired sample")
    return
  }

  console.log(`Divergences (${result.divergences.length}):`)
  for (const d of result.divergences) {
    console.log(`  feature=${d.feature} thread=${d.thread}`)
    console.log(`    expected: kind=${d.expectedKind}${d.expectedAgent ? ` agent=${d.expectedAgent}` : ""}`)
    console.log(`    proposed: kind=${d.proposedKind} agent=${d.proposedAgent} mode=${d.proposedMode}`)
    if (detail) {
      console.log(`    proposal:  ${d.file}:${d.proposalLine}: ${d.proposalRaw.slice(0, 200)}`)
      console.log(`    branch:    ${d.file}:${d.branchLine}: ${d.branchRaw.slice(0, 200)}`)
    }
  }
  console.log()
  console.log("[shadow-report] FAIL — divergences detected; resolve by either fixing the spec/router or hand-confirming each cell as a known FLAG")
  process.exit(1)
}

if (isMain()) main()
