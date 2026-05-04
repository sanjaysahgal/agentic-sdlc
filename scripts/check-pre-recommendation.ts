#!/usr/bin/env tsx
/**
 * [PRE-RECOMMENDATION AUDIT] — Manifest item B19.
 *
 * Read-only audit script that surfaces, for any source file under
 * `runtime/`, `interfaces/`, `agents/`, the three things that MUST be
 * considered before recommending or making any change to that file:
 *
 *   A. Prior decisions
 *      - All `DESIGN-REVIEWED:` comments in the file (with rationale)
 *      - Last 10 commits touching the file (with full commit message)
 *      - Every section in SYSTEM_ARCHITECTURE.md / AGENTS.md /
 *        DECISIONS.md / CLAUDE.md that mentions the file by name
 *
 *   B. Test coverage
 *      - All test files (`tests/**\/*.test.ts`) that import this file
 *      - Per-export grep against test bodies (which exports have how
 *        many test assertions)
 *
 *   C. Caller blast-radius
 *      - All call sites of this file's exported symbols (across
 *        runtime/, interfaces/, agents/, tests/)
 *      - Per-export count: which exports are most depended on
 *
 * Why this exists: during Step 1 verification the assistant proposed
 * B17 (lane-scoped context) without checking git history, specs, or
 * tests — would have undone 4 prior decisions and broken integration
 * tests. Memory + cognitive discipline failed. The script is the
 * structural backstop that future PreToolUse hooks call automatically
 * (auto-inject on Edit/Write; gate on git commit).
 *
 * Usage:
 *   npx tsx scripts/check-pre-recommendation.ts <file-path> [<file-path> ...]
 *
 * Exits 0 always — this is an informational tool, not a gate. The
 * companion pre-commit hook is the gate (`[PRE-RECOMMENDATION GATE]`
 * in .claude/settings.json).
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"

const REPO_ROOT = resolve(__dirname, "..")
const SPEC_FILES = [
  "SYSTEM_ARCHITECTURE.md",
  "AGENTS.md",
  "DECISIONS.md",
  "CLAUDE.md",
  "BACKLOG.md",
]

function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

interface FileAudit {
  filePath: string
  designReviewed: string[]      // each: a DESIGN-REVIEWED comment with surrounding context
  recentCommits: string[]       // each: short hash + subject + body (truncated)
  specMentions: { spec: string; lines: string[] }[]
  testFiles: string[]           // each: relative path to a test file referencing this source
  testAssertionsByExport: { exportName: string; testCount: number }[]
  callerSites: { exportName: string; callerCount: number; sampleCallers: string[] }[]
}

function auditOne(filePath: string): FileAudit {
  const absPath = resolve(REPO_ROOT, filePath)
  if (!existsSync(absPath)) {
    return {
      filePath,
      designReviewed: [`(file not found: ${filePath})`],
      recentCommits: [],
      specMentions: [],
      testFiles: [],
      testAssertionsByExport: [],
      callerSites: [],
    }
  }

  const source = readFileSync(absPath, "utf8")

  // A. DESIGN-REVIEWED comments
  const designReviewed: string[] = []
  const drRe = /\/\/\s*DESIGN-REVIEWED:[^\n]*(?:\n\/\/[^\n]*)*/g
  let m: RegExpExecArray | null
  while ((m = drRe.exec(source)) !== null) {
    designReviewed.push(m[0])
  }

  // A. Recent commits (last 10) touching this file
  const log = sh(`git log -10 --format="%h %s%n%b%n--END--" -- "${filePath}"`)
  const recentCommits = log
    .split("--END--")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.split("\n").slice(0, 4).join("\n"))  // first line + up to 3 body lines

  // A. Spec mentions
  const baseName = basename(filePath)
  const specMentions: { spec: string; lines: string[] }[] = []
  for (const spec of SPEC_FILES) {
    const specPath = resolve(REPO_ROOT, spec)
    if (!existsSync(specPath)) continue
    const specSource = readFileSync(specPath, "utf8")
    const specLines = specSource.split("\n")
    const matches: string[] = []
    for (let i = 0; i < specLines.length; i++) {
      const line = specLines[i]
      if (line.includes(filePath) || line.includes(baseName)) {
        matches.push(`L${i + 1}: ${line.trim()}`)
      }
    }
    if (matches.length > 0) {
      specMentions.push({ spec, lines: matches.slice(0, 5) })  // cap per-spec
    }
  }

  // Get exported symbols
  const exportRe = /^export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
  const exports = new Set<string>()
  while ((m = exportRe.exec(source)) !== null) {
    exports.add(m[1])
  }

  // B. Test files importing this file (by relative path or filename)
  const fileNameNoExt = basename(filePath, ".ts")
  const testFiles = sh(`grep -rl --include="*.test.ts" -E "from \\".*${fileNameNoExt}\\"|from \\".*${baseName}\\"" tests/ 2>/dev/null`)
    .split("\n")
    .filter((s) => s.length > 0)
    .map((p) => p.replace(REPO_ROOT + "/", ""))

  // B. Per-export test count (how many test files reference each export)
  const testAssertionsByExport: { exportName: string; testCount: number }[] = []
  for (const exp of exports) {
    const count = sh(`grep -rl --include="*.test.ts" -E "\\b${exp}\\b" tests/ 2>/dev/null`).split("\n").filter((s) => s.length > 0).length
    if (count > 0) testAssertionsByExport.push({ exportName: exp, testCount: count })
  }
  testAssertionsByExport.sort((a, b) => b.testCount - a.testCount)

  // C. Caller blast-radius — per-export call sites
  const callerSites: { exportName: string; callerCount: number; sampleCallers: string[] }[] = []
  for (const exp of exports) {
    const callerLines = sh(`grep -rln --include="*.ts" --exclude-dir=node_modules --exclude-dir=tests -E "\\b${exp}\\b" runtime/ interfaces/ agents/ scripts/ 2>/dev/null`)
      .split("\n")
      .filter((s) => s.length > 0)
      .filter((p) => !p.endsWith(filePath))  // exclude the source file itself
    if (callerLines.length > 0) {
      callerSites.push({
        exportName: exp,
        callerCount: callerLines.length,
        sampleCallers: callerLines.slice(0, 5).map((p) => p.replace(REPO_ROOT + "/", "")),
      })
    }
  }
  callerSites.sort((a, b) => b.callerCount - a.callerCount)

  return {
    filePath,
    designReviewed,
    recentCommits,
    specMentions,
    testFiles,
    testAssertionsByExport,
    callerSites,
  }
}

function renderAudit(audit: FileAudit): string {
  const sections: string[] = []
  sections.push(`# Pre-recommendation audit: ${audit.filePath}`)
  sections.push("")

  // A. Prior decisions
  sections.push("## A. Prior decisions")
  sections.push("")
  sections.push(`### DESIGN-REVIEWED comments (${audit.designReviewed.length})`)
  if (audit.designReviewed.length === 0) {
    sections.push("_(none — no inline DESIGN-REVIEWED rationale in this file)_")
  } else {
    for (const dr of audit.designReviewed) {
      sections.push("```")
      sections.push(dr)
      sections.push("```")
    }
  }
  sections.push("")
  sections.push(`### Recent commits touching this file (last ${audit.recentCommits.length})`)
  if (audit.recentCommits.length === 0) {
    sections.push("_(none found)_")
  } else {
    for (const c of audit.recentCommits) {
      sections.push("```")
      sections.push(c)
      sections.push("```")
    }
  }
  sections.push("")
  sections.push(`### Spec mentions (by file)`)
  if (audit.specMentions.length === 0) {
    sections.push("_(no mentions in SYSTEM_ARCHITECTURE.md / AGENTS.md / DECISIONS.md / CLAUDE.md / BACKLOG.md)_")
  } else {
    for (const sm of audit.specMentions) {
      sections.push(`**${sm.spec}** (${sm.lines.length} mention${sm.lines.length === 1 ? "" : "s"}, capped at 5):`)
      for (const line of sm.lines) sections.push(`- ${line}`)
      sections.push("")
    }
  }
  sections.push("")

  // B. Test coverage
  sections.push("## B. Test coverage")
  sections.push("")
  sections.push(`### Test files importing this file (${audit.testFiles.length})`)
  if (audit.testFiles.length === 0) {
    sections.push("_(no test files import this file directly — caution: low test coverage)_")
  } else {
    for (const tf of audit.testFiles) sections.push(`- ${tf}`)
  }
  sections.push("")
  sections.push(`### Per-export test references`)
  if (audit.testAssertionsByExport.length === 0) {
    sections.push("_(no exports referenced in test files)_")
  } else {
    sections.push("| Export | Test files referencing it |")
    sections.push("|---|---|")
    for (const e of audit.testAssertionsByExport) {
      sections.push(`| ${e.exportName} | ${e.testCount} |`)
    }
  }
  sections.push("")

  // C. Caller blast-radius
  sections.push("## C. Caller blast-radius")
  sections.push("")
  sections.push(`### Per-export call sites (across runtime/ + interfaces/ + agents/ + scripts/)`)
  if (audit.callerSites.length === 0) {
    sections.push("_(no callers found — file may be entry-point only or unused)_")
  } else {
    sections.push("| Export | Caller files | Sample callers |")
    sections.push("|---|---|---|")
    for (const c of audit.callerSites) {
      sections.push(`| ${c.exportName} | ${c.callerCount} | ${c.sampleCallers.join(", ")} |`)
    }
  }
  sections.push("")

  // Summary
  const totalCommits = audit.recentCommits.length
  const totalDR = audit.designReviewed.length
  const totalSpec = audit.specMentions.reduce((sum, sm) => sum + sm.lines.length, 0)
  const totalTests = audit.testFiles.length
  const totalCallers = audit.callerSites.reduce((sum, c) => sum + c.callerCount, 0)
  sections.push("---")
  sections.push(`**Summary for ${audit.filePath}:** ${totalDR} DESIGN-REVIEWED comment(s), ${totalCommits} recent commit(s), ${totalSpec} spec mention(s), ${totalTests} test file(s), ${totalCallers} caller call-site(s) across exports. **Read all sections above before proposing or making any change to this file.**`)

  return sections.join("\n")
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error("Usage: npx tsx scripts/check-pre-recommendation.ts <file-path> [<file-path> ...]")
    process.exit(2)
  }

  const reports: string[] = []
  for (const filePath of args) {
    const audit = auditOne(filePath)
    reports.push(renderAudit(audit))
  }

  console.log(reports.join("\n\n=====\n\n"))
  process.exit(0)
}

main()
