// CLI for managing MANUAL_TESTS_PENDING.md.
//
// Usage:
//   npx tsx scripts/mt.ts list        — show pending MT-N entries (both tiers, labeled)
//   npx tsx scripts/mt.ts next        — print full instructions for the first BLOCKING pending MT-N
//   npx tsx scripts/mt.ts done MT-N   — mark MT-N as done (removes the entry from either tier)
//   npx tsx scripts/mt.ts count       — print count of BLOCKING pending entries (for push gate hooks)
//   npx tsx scripts/mt.ts count-all   — print count of pending entries across BOTH tiers
//
// MANUAL_TESTS_PENDING.md format:
//   - Two `## ` sections: `## Blocking pre-push` and `## Spot-check during integration walk`
//   - One `### MT-N — title` heading per pending MT inside each section
// Pre-push hook gates on the BLOCKING tier only. Spot-check entries are tracked but
// don't block push — they're done opportunistically during the next integration walk.
// `done` removes the heading and its body up to the next `###` or `## ` or end of file.

import * as fs from "node:fs"
import * as path from "node:path"

const REPO_ROOT = path.join(__dirname, "..")
const PENDING_FILE = path.join(REPO_ROOT, "MANUAL_TESTS_PENDING.md")
const CATALOG_FILE = path.join(REPO_ROOT, "MANUAL_TESTS.md")

type Tier = "blocking" | "spot-check"

interface PendingEntry {
  id:     string  // e.g. "MT-7"
  title:  string  // text after the em-dash
  body:   string  // full body up to next heading
  tier:   Tier
}

function readPending(): PendingEntry[] {
  if (!fs.existsSync(PENDING_FILE)) return []
  const source = fs.readFileSync(PENDING_FILE, "utf-8")
  const entries: PendingEntry[] = []
  // Split source into per-section chunks keyed by `## <Section>`. Anything
  // before the first `## ` heading is treated as preamble (no entries).
  const sectionRe = /^## (.+?)$([\s\S]*?)(?=^## |$(?![\r\n]))/gm
  let s: RegExpExecArray | null
  while ((s = sectionRe.exec(source)) !== null) {
    const sectionTitle = s[1].trim().toLowerCase()
    const sectionBody = s[2]
    let tier: Tier
    if (sectionTitle.startsWith("blocking")) tier = "blocking"
    else if (sectionTitle.startsWith("spot-check")) tier = "spot-check"
    else continue  // unknown section header, ignore
    const entryRe = /^### (MT-\d+) — (.+?)$([\s\S]*?)(?=^### MT-\d+|$(?![\r\n]))/gm
    let m: RegExpExecArray | null
    while ((m = entryRe.exec(sectionBody)) !== null) {
      entries.push({ id: m[1], title: m[2].trim(), body: m[3], tier })
    }
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
  const blocking = pending.filter((e) => e.tier === "blocking")
  const spotCheck = pending.filter((e) => e.tier === "spot-check")
  if (pending.length === 0) {
    console.log("[mt] no pending manual tests — clear to push.")
    return
  }
  console.log(`[mt] ${blocking.length} blocking, ${spotCheck.length} spot-check pending:`)
  if (blocking.length > 0) {
    console.log("  Blocking pre-push (must run before push):")
    for (const e of blocking) console.log(`    - ${e.id} — ${e.title}`)
  }
  if (spotCheck.length > 0) {
    console.log("  Spot-check during integration walk (does NOT block push):")
    for (const e of spotCheck) console.log(`    - ${e.id} — ${e.title}`)
  }
}

function cmdCount(): void {
  // Push-gate count: blocking tier only. Spot-check entries don't block push.
  console.log(readPending().filter((e) => e.tier === "blocking").length)
}

function cmdCountAll(): void {
  console.log(readPending().length)
}

function cmdNext(): void {
  // `next` walks the user through BLOCKING tier first — those are what
  // gate the push. Spot-check entries are run opportunistically, not
  // queued through this command.
  const pending = readPending().filter((e) => e.tier === "blocking")
  if (pending.length === 0) {
    console.log("[mt] no blocking pending manual tests.")
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
  console.log(`[mt] next blocking pending: ${first.id}\n`)
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
  // Remove `### <ID> — …\n\n…\n` up to the next `###`, the next `## `
  // section header, or end-of-file. Stopping at `## ` keeps section
  // boundaries intact when the last entry of a section is removed.
  const re = new RegExp(`^### ${id} — [\\s\\S]*?(?=^### MT-|^## |$(?![\\r\\n]))`, "m")
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
    case "list":      return cmdList()
    case "next":      return cmdNext()
    case "count":     return cmdCount()
    case "count-all": return cmdCountAll()
    case "done":      return cmdDone(process.argv[3] ?? "")
    default:
      console.log("Usage: npx tsx scripts/mt.ts <list|next|done MT-N|count|count-all>")
      process.exit(1)
  }
}

if (require.main === module) {
  main()
}

export { readPending, findFullScenario }
