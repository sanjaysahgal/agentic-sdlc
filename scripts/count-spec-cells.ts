/**
 * count-spec-cells.ts
 *
 * Reads docs/ROUTING_STATE_MACHINE.md, parses every Markdown pipe-table under
 * sections §8 (feature channel matrix), §9 (general channel matrix), and §10
 * (post-agent matrix), and reports how many decision rows each section
 * contains.
 *
 * Used in Phase 0 to derive the actual cell count empirically (so the plan
 * doesn't rely on hand-waved estimates) and committed as a Vitest snapshot
 * in Phase 2 so future drift fails CI.
 *
 * Usage: npx tsx scripts/count-spec-cells.ts
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const SPEC_PATH = resolve(__dirname, "..", "docs", "ROUTING_STATE_MACHINE.md")

type SectionCounts = {
  featureChannel: { phase: string; rows: number }[]
  generalChannel: number
  postAgent: number
}

function countPipeTableRows(blockLines: string[]): number {
  // A Markdown pipe table starts with a header row and a divider row (e.g.
  // |---|---|). We count the body rows after the divider.
  let dividerIdx = -1
  for (let i = 0; i < blockLines.length; i++) {
    if (/^\s*\|\s*-+/.test(blockLines[i])) {
      dividerIdx = i
      break
    }
  }
  if (dividerIdx === -1) return 0
  let count = 0
  for (let i = dividerIdx + 1; i < blockLines.length; i++) {
    const line = blockLines[i]
    if (!line.trim()) break
    if (line.trim().startsWith("|")) count += 1
    else break
  }
  return count
}

function parseSpec(): SectionCounts {
  const text = readFileSync(SPEC_PATH, "utf8")
  const lines = text.split("\n")

  const counts: SectionCounts = {
    featureChannel: [],
    generalChannel: 0,
    postAgent: 0,
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // §8.x phase tables: "### 8.X Phase: {phase-name}"
    const phaseMatch = line.match(/^###\s+8\.\d+\s+Phase:\s+`([^`]+)`/)
    if (phaseMatch) {
      const phase = phaseMatch[1]
      // collect lines until next ### or ##
      const block: string[] = []
      i += 1
      while (i < lines.length && !/^##/.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      counts.featureChannel.push({ phase, rows: countPipeTableRows(block) })
      continue
    }
    // §9 general channel: "## 9. Decision matrix — general channel"
    if (/^##\s+9\.\s+Decision matrix\s+—\s+general channel/.test(line)) {
      const block: string[] = []
      i += 1
      while (i < lines.length && !/^##/.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      counts.generalChannel = countPipeTableRows(block)
      continue
    }
    // §10 post-agent: "## 10. Post-agent decision matrix"
    if (/^##\s+10\.\s+Post-agent decision matrix/.test(line)) {
      const block: string[] = []
      i += 1
      while (i < lines.length && !/^##/.test(lines[i])) {
        block.push(lines[i])
        i += 1
      }
      counts.postAgent = countPipeTableRows(block)
      continue
    }
    i += 1
  }

  return counts
}

function main() {
  const counts = parseSpec()

  const featureTotal = counts.featureChannel.reduce((s, p) => s + p.rows, 0)
  console.log(`Routing state machine — cell counts (${SPEC_PATH})\n`)
  console.log("Feature channel (§8):")
  for (const { phase, rows } of counts.featureChannel) {
    console.log(`  ${phase.padEnd(48)} ${rows} rows`)
  }
  console.log(`  ${"TOTAL".padEnd(48)} ${featureTotal} rows`)
  console.log()
  console.log(`General channel (§9):  ${counts.generalChannel} rows`)
  console.log(`Post-agent (§10):      ${counts.postAgent} rows`)
  console.log()
  console.log(`GRAND TOTAL:           ${featureTotal + counts.generalChannel + counts.postAgent} rows`)
}

main()
