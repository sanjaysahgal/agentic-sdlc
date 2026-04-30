// CLI for managing MANUAL_TESTS_PENDING.md.
//
// Usage:
//   npx tsx scripts/mt.ts list        — show pending MT-N entries (one line each)
//   npx tsx scripts/mt.ts next        — print full instructions for the first pending MT-N
//   npx tsx scripts/mt.ts done MT-N   — mark MT-N as done (removes the entry)
//   npx tsx scripts/mt.ts count       — print count of pending entries (for hooks)
//
// MANUAL_TESTS_PENDING.md format: one heading per pending MT, named `### MT-N — title`.
// `done` removes the heading and its body up to the next `###` or end of file.

import * as fs from "node:fs"
import * as path from "node:path"

const REPO_ROOT = path.join(__dirname, "..")
const PENDING_FILE = path.join(REPO_ROOT, "MANUAL_TESTS_PENDING.md")
const CATALOG_FILE = path.join(REPO_ROOT, "MANUAL_TESTS.md")

interface PendingEntry {
  id:     string  // e.g. "MT-7"
  title:  string  // text after the em-dash
  body:   string  // full body up to next heading
}

function readPending(): PendingEntry[] {
  if (!fs.existsSync(PENDING_FILE)) return []
  const source = fs.readFileSync(PENDING_FILE, "utf-8")
  const entries: PendingEntry[] = []
  const re = /^### (MT-\d+) — (.+?)$([\s\S]*?)(?=^### MT-\d+|$(?![\r\n]))/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    entries.push({ id: m[1], title: m[2].trim(), body: m[3] })
  }
  return entries
}

function findFullScenario(id: string): string | null {
  if (!fs.existsSync(CATALOG_FILE)) return null
  const source = fs.readFileSync(CATALOG_FILE, "utf-8")
  const re = new RegExp(`^### ${id} — (.+?)$([\\s\\S]*?)(?=^### MT-|^## )`, "m")
  const m = source.match(re)
  if (!m) return null
  return `### ${id} — ${m[1].trim()}\n${m[2]}`
}

function cmdList(): void {
  const pending = readPending()
  if (pending.length === 0) {
    console.log("[mt] no pending manual tests — clear to push.")
    return
  }
  console.log(`[mt] ${pending.length} pending manual test(s):`)
  for (const e of pending) {
    console.log(`  - ${e.id} — ${e.title}`)
  }
}

function cmdCount(): void {
  console.log(readPending().length)
}

function cmdNext(): void {
  const pending = readPending()
  if (pending.length === 0) {
    console.log("[mt] no pending manual tests.")
    return
  }
  const first = pending[0]
  const scenario = findFullScenario(first.id)
  if (!scenario) {
    console.log(`[mt] ${first.id} not found in MANUAL_TESTS.md.`)
    console.log(`Title: ${first.title}`)
    console.log(`Pending entry body:\n${first.body}`)
    return
  }
  console.log(`[mt] next pending: ${first.id}\n`)
  console.log(scenario)
  console.log(`\n[mt] when done: npx tsx scripts/mt.ts done ${first.id}`)
}

function cmdDone(id: string): void {
  if (!/^MT-\d+$/.test(id)) {
    console.error(`[mt] invalid id "${id}" (expected MT-N).`)
    process.exit(1)
  }
  if (!fs.existsSync(PENDING_FILE)) {
    console.log(`[mt] ${PENDING_FILE} does not exist — nothing to remove.`)
    return
  }
  const source = fs.readFileSync(PENDING_FILE, "utf-8")
  // Remove `### <ID> — …\n\n…\n` up to the next `###` (or end-of-file).
  const re = new RegExp(`^### ${id} — [\\s\\S]*?(?=^### MT-|$(?![\\r\\n]))`, "m")
  if (!re.test(source)) {
    console.log(`[mt] ${id} not found in MANUAL_TESTS_PENDING.md — already done?`)
    return
  }
  const next = source.replace(re, "").replace(/\n{3,}/g, "\n\n")
  fs.writeFileSync(PENDING_FILE, next)
  console.log(`[mt] ${id} marked done. Remaining: ${readPending().length}`)
}

function main() {
  const cmd = process.argv[2]
  switch (cmd) {
    case "list":  return cmdList()
    case "next":  return cmdNext()
    case "count": return cmdCount()
    case "done":  return cmdDone(process.argv[3] ?? "")
    default:
      console.log("Usage: npx tsx scripts/mt.ts <list|next|done MT-N|count>")
      process.exit(1)
  }
}

if (require.main === module) {
  main()
}

export { readPending, findFullScenario }
