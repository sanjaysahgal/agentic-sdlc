/**
 * generate-shadow-corpus.ts
 *
 * Phase 0 SKELETON. Reads docs/ROUTING_STATE_MACHINE.md and emits a CSV
 * inventory of every spec row to tests/fixtures/shadow-corpus/inventory.csv.
 *
 * Phase 1/2 deliverable: extend this script to emit one JSON fixture per row
 * to tests/fixtures/shadow-corpus/{phase}-{entry}-{stateHash}.json containing
 * a synthesized Slack event payload + the expected RoutingDecision.kind.
 * That cannot be done in Phase 0 because the RoutingInput type does not
 * exist yet — typing lands in Phase 1.
 *
 * For Phase 0 the inventory CSV is sufficient: it proves the spec parses,
 * shows every row's metadata, and is the input to the Phase 1/2 generator.
 *
 * Usage: npx tsx scripts/generate-shadow-corpus.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const SPEC_PATH = resolve(__dirname, "..", "docs", "ROUTING_STATE_MACHINE.md")
const OUT_DIR = resolve(__dirname, "..", "tests", "fixtures", "shadow-corpus")
const OUT_PATH = resolve(OUT_DIR, "inventory.csv")

type Row = {
  channel: "feature" | "general" | "post-agent"
  phase: string | null  // null for general/post-agent
  cells: string[]       // raw pipe-cell values
  expected: string      // the "→ Decision" cell value
}

function splitPipeRow(line: string): string[] {
  // strip leading/trailing pipe and surrounding whitespace, then split
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map(c => c.trim())
}

function parseTableSection(blockLines: string[], channel: Row["channel"], phase: string | null): Row[] {
  let dividerIdx = -1
  for (let i = 0; i < blockLines.length; i++) {
    if (/^\s*\|\s*-+/.test(blockLines[i])) {
      dividerIdx = i
      break
    }
  }
  if (dividerIdx === -1) return []

  const headers = splitPipeRow(blockLines[dividerIdx - 1])
  const decisionIdx = headers.findIndex(h => /→ Decision/.test(h))

  const rows: Row[] = []
  for (let i = dividerIdx + 1; i < blockLines.length; i++) {
    const line = blockLines[i]
    if (!line.trim()) break
    if (!line.trim().startsWith("|")) break
    const cells = splitPipeRow(line)
    if (cells.length === 0) continue
    rows.push({
      channel,
      phase,
      cells,
      expected: decisionIdx >= 0 && decisionIdx < cells.length ? cells[decisionIdx] : "",
    })
  }
  return rows
}

function parseSpec(): Row[] {
  const text = readFileSync(SPEC_PATH, "utf8")
  const lines = text.split("\n")
  const rows: Row[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const phaseMatch = line.match(/^###\s+8\.\d+\s+Phase:\s+`([^`]+)`/)
    if (phaseMatch) {
      const block: string[] = []
      i += 1
      while (i < lines.length && !/^##/.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      rows.push(...parseTableSection(block, "feature", phaseMatch[1]))
      continue
    }

    if (/^##\s+9\.\s+Decision matrix\s+—\s+general channel/.test(line)) {
      const block: string[] = []
      i += 1
      while (i < lines.length && !/^##/.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      rows.push(...parseTableSection(block, "general", null))
      continue
    }

    if (/^##\s+10\.\s+Post-agent decision matrix/.test(line)) {
      const block: string[] = []
      i += 1
      while (i < lines.length && !/^##/.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      rows.push(...parseTableSection(block, "post-agent", null))
      continue
    }

    i += 1
  }

  return rows
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const rows = parseSpec()

  const lines: string[] = []
  lines.push(["channel", "phase", "expected_decision", "raw_cells"].join(","))
  for (const row of rows) {
    lines.push([
      csvEscape(row.channel),
      csvEscape(row.phase ?? ""),
      csvEscape(row.expected),
      csvEscape(row.cells.join(" | ")),
    ].join(","))
  }

  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8")
  console.log(`Wrote ${rows.length} rows to ${OUT_PATH}`)
  console.log()
  console.log("By channel:")
  const byChannel = new Map<string, number>()
  for (const r of rows) {
    byChannel.set(r.channel, (byChannel.get(r.channel) ?? 0) + 1)
  }
  for (const [k, v] of byChannel.entries()) {
    console.log(`  ${k.padEnd(20)} ${v} rows`)
  }
}

main()
