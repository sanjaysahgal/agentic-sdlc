/**
 * generate-shadow-corpus.ts
 *
 * Reads docs/ROUTING_STATE_MACHINE.md, parses every spec row, and emits one JSON
 * fixture per row to tests/fixtures/shadow-corpus/. The fixtures are the input
 * payload for scripts/shadow-coverage-driver.ts (Phase 3 of the routing state
 * machine refactor).
 *
 * Each fixture captures:
 *   - the synthesized Slack event payload (channel, threadTs, text, userId)
 *   - the state setup needed before the message is processed (set-pending-*,
 *     set-confirmed-*, etc.) so the driver can replay it deterministically
 *   - the expected RoutingDecision.kind / args (sourced from the spec row)
 *   - the line number in the spec doc (so divergence reports point at the
 *     authoritative cell)
 *
 * Usage: npx tsx scripts/generate-shadow-corpus.ts [--out tests/fixtures/shadow-corpus]
 *
 * Idempotent: running it on an unchanged spec doc produces unchanged JSON.
 * Hand-edits to message text in fixtures are preserved unless the spec row
 * itself changes — see preserveMessageText() below.
 *
 * Phase 0 used this same path to write inventory.csv. The CSV is replaced by
 * the JSON-per-row corpus in Phase 3 — it served its purpose (proof the spec
 * parsed) and the matrix test + driver now own that responsibility.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { resolve, join } from "node:path"
import { parseSpecTables, type SpecRow } from "../runtime/routing/spec-parser"

const SPEC_PATH = resolve(__dirname, "..", "docs", "ROUTING_STATE_MACHINE.md")
const DEFAULT_OUT_DIR = resolve(__dirname, "..", "tests", "fixtures", "shadow-corpus")

type ShadowFixture = {
  /** Stable id of the form `{channel}-L{lineNumber}` so reports cross-link to the spec. */
  readonly id: string
  /** Channel the row came from. */
  readonly channel: "feature" | "general" | "post-agent"
  /** Spec doc line number — clickable in divergence reports. */
  readonly specLine: number
  /** Phase (feature rows only). */
  readonly phase?: string
  /** Entry point id (E1..E8 / G1..G5). Some rows use composite entries like "G2/G3/G4". */
  readonly entry?: string
  /** State setup: which conv-store keys to seed before replaying the message. */
  readonly stateSetup: Readonly<Record<string, string>>
  /** Expected RoutingDecision.kind for this row. */
  readonly expectedKind: string
  /** Expected RoutingDecision args (subset; the matrix matcher decides which to enforce). */
  readonly expectedArgs: Readonly<Record<string, string>>
  /** Synthesized Slack event payload. */
  readonly slackEvent: {
    readonly channel:   string                 // e.g. "feature-onboarding" or "general"
    readonly threadTs:  string
    readonly userId:    string
    readonly text:      string
    readonly entryHint: string                 // E2/E3/E4/G2/G3/G4 prefix or "" for direct
  }
  /** FLAG marker if this row encodes a known bug fixed in Phase 5. */
  readonly flag?: string
  /** Inv labels copied from the spec row. */
  readonly invariants: readonly string[]
}

function fixtureIdForRow(row: SpecRow): string {
  // Stable across regenerations; line-number-driven so reordering the spec
  // changes ids — the right signal that fixtures need re-review.
  return `${row.channel}-L${row.lineNumber}`
}

// Translate spec-cell userMsg meta-text to a concrete Slack message text. Mirrors
// runtime/routing/snapshot.ts#rawTextFromCell — kept in sync by hand. The matrix
// test (tests/invariants/routing-matrix.test.ts) verifies the runtime version
// produces the right routing decisions, so divergence between this and that
// surfaces in the shadow driver, not silently.
function userTextFromCell(cell: string | undefined): string {
  if (!cell) return ""
  const t = cell.trim()
  if (t === "non-affirmative")                     return "no"
  if (/^\(any except affirm\/decline\)$/i.test(t)) return "tell me more"
  if (/^any\s*\(new thread\)$/i.test(t))           return "hi"
  if (/^any$/i.test(t))                            return "any input"
  return cell
}

// Some entry points (E2-E7, G2-G4) encode a slash command or @-prefix that the
// production code path detects to set addressedAgent. The driver replays the
// fixture as if Slack had delivered it that way.
function entryHintFor(entry: string | undefined): string {
  switch (entry) {
    case "E2": case "G2": return "/pm"
    case "E3": case "G3": return "/design"
    case "E4": case "G4": return "/architect"
    case "E5":            return "@pm:"
    case "E6":            return "@design:"
    case "E7":            return "@architect:"
    default:              return ""
  }
}

function fixtureFor(row: SpecRow, channelName: string, threadTs: string, userId: string): ShadowFixture {
  const text = userTextFromCell(row.userMsg)
  const entryHint = entryHintFor(typeof row.entry === "string" ? row.entry : undefined)
  return {
    id:           fixtureIdForRow(row),
    channel:      row.channel,
    specLine:     row.lineNumber,
    phase:        row.phase,
    entry:        row.entry as string | undefined,
    stateSetup:   row.state,
    expectedKind: row.expected.kind,
    expectedArgs: row.expected.args,
    slackEvent:   { channel: channelName, threadTs, userId, text, entryHint },
    flag:         row.expected.flag,
    invariants:   row.invariants,
  }
}

// Preserve human-edited Slack text when present. The plan calls for hand-edits
// when realistic message text matters more than the spec's meta-token (e.g.
// "tell me more" → "what about the export format?"). We detect a hand-edit by
// reading the existing fixture and keeping its slackEvent.text if the spec
// row's expected kind/args/line haven't drifted.
function preserveMessageText(existing: ShadowFixture | null, fresh: ShadowFixture): ShadowFixture {
  if (!existing) return fresh
  const sameRow =
    existing.specLine     === fresh.specLine &&
    existing.expectedKind === fresh.expectedKind &&
    JSON.stringify(existing.expectedArgs) === JSON.stringify(fresh.expectedArgs)
  if (!sameRow) return fresh
  return { ...fresh, slackEvent: { ...fresh.slackEvent, text: existing.slackEvent.text } }
}

function readExistingFixture(path: string): ShadowFixture | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ShadowFixture
  } catch {
    return null
  }
}

function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf("--out")
  const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : DEFAULT_OUT_DIR

  mkdirSync(outDir, { recursive: true })

  const parsed = parseSpecTables(SPEC_PATH)
  const all: SpecRow[] = [...parsed.feature, ...parsed.general, ...parsed.postAgent]

  // Synthesize stable channel + thread + user ids. Feature rows go to
  // #feature-shadow-{phase}; general rows to #general; post-agent rows reuse
  // the feature channel since they're a second-pass on a feature-channel input.
  function synthesize(row: SpecRow) {
    if (row.channel === "general") {
      return { channelName: "general", threadTs: `T_GEN_${row.lineNumber}`, userId: "U_SHADOW" }
    }
    const phaseSlug = (row.phase ?? "post-agent").replace(/[^a-z0-9]/gi, "-")
    return { channelName: `feature-shadow-${phaseSlug}`, threadTs: `T_FEA_${row.lineNumber}`, userId: "U_SHADOW" }
  }

  const written = new Set<string>()
  for (const row of all) {
    // Skip composite entries like "G2/G3/G4" — the per-channel rows already cover
    // each branch individually.
    if (typeof row.entry === "string" && row.entry.includes("/")) continue

    const { channelName, threadTs, userId } = synthesize(row)
    const fresh = fixtureFor(row, channelName, threadTs, userId)
    const path  = join(outDir, `${fresh.id}.json`)
    const existing = readExistingFixture(path)
    const final = preserveMessageText(existing, fresh)
    writeFileSync(path, JSON.stringify(final, null, 2) + "\n")
    written.add(`${fresh.id}.json`)
  }

  // Remove stale fixtures whose corresponding spec row was deleted or merged.
  // Without this step, the driver would assert against rows that no longer exist
  // and report false negatives.
  const existingFiles = readdirSync(outDir).filter((f) => f.endsWith(".json"))
  let removed = 0
  for (const f of existingFiles) {
    if (!written.has(f)) {
      unlinkSync(join(outDir, f))
      removed += 1
    }
  }

  // Phase 0 wrote inventory.csv to the same directory; remove it on first run
  // of Phase 3 so the corpus directory contains JSON fixtures only.
  const legacyCsv = join(outDir, "inventory.csv")
  if (existsSync(legacyCsv)) unlinkSync(legacyCsv)

  console.log(`[shadow-corpus] wrote ${written.size} fixture(s) to ${outDir}`)
  if (removed > 0) console.log(`[shadow-corpus] removed ${removed} stale fixture(s)`)
}

main()
