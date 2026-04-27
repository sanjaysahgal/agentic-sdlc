/**
 * shadow-coverage-report.ts
 *
 * Parses production logs for [ROUTING-V2-DIVERGENCE] lines emitted by the dual-run
 * shadow mode in interfaces/slack/handlers/message.ts and general.ts (Phase 3,
 * stage 2). Aggregates by (entry × state × phase) cell and reports cells with a
 * non-zero divergence count.
 *
 * This is the Phase 3 coverage gate (b) — "zero divergences over 48h of real
 * production traffic" — measured by running this report against the most recent
 * 48h of logs/bot-YYYY-MM-DD.log files and asserting zero divergences.
 *
 * Log line shape (emitted by the shadow comparator):
 *   [ROUTING-V2-DIVERGENCE] feature=onboarding phase=design-in-progress entry=E5
 *     oldKind=show-hold-message newKind=run-escalation-confirmed
 *     userMsg="@pm: actually..." reason="<freeform>"
 *
 * Usage:
 *   npx tsx scripts/shadow-coverage-report.ts [--logs logs/]
 *                                              [--since YYYY-MM-DD]
 *                                              [--cell-detail]
 *
 * Exit code 0 = zero divergences (gate passes). Non-zero = at least one
 * divergence found in the time window.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

const DEFAULT_LOG_DIR = resolve(__dirname, "..", "logs")

type DivergenceLine = {
  feature?: string
  phase?:   string
  entry?:   string
  oldKind?: string
  newKind?: string
  userMsg?: string
  reason?:  string
  raw:      string
  file:     string
  line:     number
}

function parseDivergenceLine(line: string): Record<string, string> | null {
  if (!line.includes("[ROUTING-V2-DIVERGENCE]")) return null
  const out: Record<string, string> = {}
  // Fields are space-separated key=value pairs except userMsg/reason which may
  // contain spaces and are quoted with double quotes. Parse defensively so a
  // malformed line doesn't take down the report.
  const re = /(\w+)=("([^"]*)"|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[4]
  }
  return out
}

function loadLogs(logDir: string, since?: string): DivergenceLine[] {
  if (!existsSync(logDir)) {
    console.log(`[shadow-report] log directory ${logDir} does not exist — no production traffic to analyze`)
    return []
  }
  const files = readdirSync(logDir)
    .filter((f) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .filter((f) => !since || f >= `bot-${since}.log`)
    .sort()

  const out: DivergenceLine[] = []
  for (const f of files) {
    const path = join(logDir, f)
    const lines = readFileSync(path, "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseDivergenceLine(lines[i])
      if (!parsed) continue
      out.push({
        feature: parsed.feature,
        phase:   parsed.phase,
        entry:   parsed.entry,
        oldKind: parsed.oldKind,
        newKind: parsed.newKind,
        userMsg: parsed.userMsg,
        reason:  parsed.reason,
        raw:     lines[i],
        file:    f,
        line:    i + 1,
      })
    }
  }
  return out
}

function cellKey(d: DivergenceLine): string {
  return `${d.phase ?? "?"}/${d.entry ?? "?"}/${d.oldKind ?? "?"}→${d.newKind ?? "?"}`
}

function main() {
  const args = process.argv.slice(2)
  const logIdx = args.indexOf("--logs")
  const sinceIdx = args.indexOf("--since")
  const detail = args.includes("--cell-detail")
  const logDir = logIdx >= 0 ? resolve(args[logIdx + 1]) : DEFAULT_LOG_DIR
  const since  = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined

  const divergences = loadLogs(logDir, since)
  console.log(`[shadow-report] log directory: ${logDir}`)
  console.log(`[shadow-report] since: ${since ?? "all"}`)
  console.log(`[shadow-report] divergence lines: ${divergences.length}`)
  console.log()

  if (divergences.length === 0) {
    console.log("[shadow-report] PASS — zero production divergences in the time window")
    return
  }

  // Aggregate by cell.
  const byCell = new Map<string, DivergenceLine[]>()
  for (const d of divergences) {
    const k = cellKey(d)
    const list = byCell.get(k) ?? []
    list.push(d)
    byCell.set(k, list)
  }

  console.log(`Divergent cells (${byCell.size}):`)
  for (const [k, list] of [...byCell.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${list.length.toString().padStart(4)}× ${k}`)
    if (detail) {
      for (const d of list.slice(0, 3)) {
        console.log(`         feature=${d.feature} userMsg="${(d.userMsg ?? "").slice(0, 60)}" (${d.file}:${d.line})`)
      }
      if (list.length > 3) console.log(`         …and ${list.length - 3} more`)
    }
  }
  console.log()
  console.log("[shadow-report] FAIL — divergences detected; resolve by either fixing the spec/router or hand-confirming each cell")
  process.exit(1)
}

main()
