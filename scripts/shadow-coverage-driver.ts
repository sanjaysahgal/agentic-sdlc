/**
 * shadow-coverage-driver.ts
 *
 * Replays every fixture in tests/fixtures/shadow-corpus/ through the new pure
 * routers and asserts:
 *   (a) every fixture produces a RoutingDecision whose kind matches the
 *       expected kind from the spec row that generated it
 *   (b) for run-agent fixtures, the agent + mode match
 *   (c) every spec row in docs/ROUTING_STATE_MACHINE.md has a corresponding
 *       fixture (no spec drift)
 *
 * Exit code 0 = all green. Non-zero = at least one divergence; stdout lists
 * each divergence with the spec line, the produced decision, and the expected
 * decision so authors can resolve in one click.
 *
 * This is the Phase 3 coverage gate (a) — "synthesized corpus exercises 100%
 * of spec rows and produces zero divergences". The CI nightly action invokes
 * this directly; gates (b) "zero divergences over 48h of real production
 * traffic" and (c) "nightly action green for 3 consecutive nights" are
 * scored over time, not by this script.
 *
 * Usage: npx tsx scripts/shadow-coverage-driver.ts
 *        or:  npm run shadow:coverage
 */

import { readdirSync, readFileSync } from "node:fs"
import { resolve, join } from "node:path"
import {
  buildFeatureRoutingInputFromRow,
  buildGeneralRoutingInputFromRow,
} from "../runtime/routing/snapshot"
import { routeFeatureMessage } from "../runtime/routing/route-feature-message"
import { routeGeneralMessage } from "../runtime/routing/route-general-message"
import { parseSpecTables, type SpecRow } from "../runtime/routing/spec-parser"
import type { RoutingDecision } from "../runtime/routing/types"

const SPEC_PATH = resolve(__dirname, "..", "docs", "ROUTING_STATE_MACHINE.md")
const FIXTURE_DIR = resolve(__dirname, "..", "tests", "fixtures", "shadow-corpus")

type Fixture = {
  id: string
  channel: "feature" | "general" | "post-agent"
  specLine: number
  phase?: string
  entry?: string
  stateSetup: Record<string, string>
  expectedKind: string
  expectedArgs: Record<string, string>
  slackEvent: { channel: string; threadTs: string; userId: string; text: string; entryHint: string }
  flag?: string
  invariants: string[]
}

type Divergence = {
  fixtureId:  string
  specLine:   number
  expected:   { kind: string; args: Record<string, string> }
  produced:   RoutingDecision
  reason:     string
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture)
}

// Re-construct the SpecRow that produced this fixture so we can re-use the
// existing snapshot.ts hydrators. Reading the spec doc once and indexing by
// line number is O(rows) per run (fine; the spec is < 500 lines).
function buildRowIndex(): Map<number, SpecRow> {
  const parsed = parseSpecTables(SPEC_PATH)
  const all = [...parsed.feature, ...parsed.general, ...parsed.postAgent]
  const idx = new Map<number, SpecRow>()
  for (const row of all) idx.set(row.lineNumber, row)
  return idx
}

function compareKinds(produced: string, expected: string): boolean {
  // Mirrors the relaxations in tests/invariants/routing-matrix.test.ts so the
  // driver's pass/fail decision is identical to the matrix test's. A drift
  // between this list and the matrix-test's matcher would surface as a green
  // matrix run + a red shadow run (or vice versa) — flagrantly visible.
  if (expected === "undefined-behavior")                    return produced === "invalid-state"
  if (expected === "confirm-decision-review-item-or-complete") {
    return produced === "confirm-decision-review-item" || produced === "complete-decision-review"
  }
  return produced === expected
}

function checkArgs(decision: RoutingDecision, expected: { kind: string; args: Record<string, string> }): string | null {
  if (decision.kind === "run-agent" && expected.kind === "run-agent") {
    if (expected.args.agent && decision.agent !== expected.args.agent) {
      return `agent mismatch: produced=${decision.agent} expected=${expected.args.agent}`
    }
    const expectedMode =
      (expected.args.mode === "primary" && expected.args.modeQualifier === "product-level") ? "primary-product-level" :
      expected.args.mode === "primary, product-level"     ? "primary-product-level" :
      (expected.args.mode ?? "").startsWith("orientation") ? "orientation" :
      expected.args.mode
    if (expectedMode && decision.mode !== expectedMode) {
      return `mode mismatch: produced=${decision.mode} expected=${expectedMode}`
    }
  }
  if (decision.kind === "approve-spec" && expected.kind === "approve-spec") {
    if (expected.args._0 && decision.specType !== expected.args._0) {
      return `specType mismatch: produced=${decision.specType} expected=${expected.args._0}`
    }
  }
  if (decision.kind === "show-hold-message" && expected.kind === "show-hold-message" && expected.args.heldAgent) {
    const want = expected.args.heldAgent === "design" ? "ux-design" : expected.args.heldAgent
    if (decision.heldAgent !== want) return `heldAgent mismatch: produced=${decision.heldAgent} expected=${want}`
  }
  return null
}

function main() {
  const fixtures = loadFixtures()
  const rowIndex = buildRowIndex()

  // Coverage check: every spec row must have a fixture (skipping composite
  // entries that the generator deliberately omits).
  const fixtureLines = new Set(fixtures.map((f) => f.specLine))
  const missing: SpecRow[] = []
  for (const [, row] of rowIndex) {
    if (typeof row.entry === "string" && row.entry.includes("/")) continue
    if (!fixtureLines.has(row.lineNumber)) missing.push(row)
  }

  const divergences: Divergence[] = []

  for (const fixture of fixtures) {
    const row = rowIndex.get(fixture.specLine)
    if (!row) {
      divergences.push({
        fixtureId: fixture.id,
        specLine:  fixture.specLine,
        expected:  { kind: fixture.expectedKind, args: fixture.expectedArgs },
        produced:  { kind: "invalid-state", reason: "spec row not found", preEffects: [], postEffects: [] } as RoutingDecision,
        reason:    `fixture references line ${fixture.specLine} but spec doc has no row there — regenerate corpus`,
      })
      continue
    }

    if (row.channel === "post-agent") continue  // post-agent fixtures have no router; they round-trip via depth=1 in the dispatcher.

    let decision: RoutingDecision
    try {
      decision = row.channel === "general"
        ? routeGeneralMessage(buildGeneralRoutingInputFromRow(row))
        : routeFeatureMessage(buildFeatureRoutingInputFromRow(row))
    } catch (err) {
      divergences.push({
        fixtureId: fixture.id,
        specLine:  fixture.specLine,
        expected:  { kind: fixture.expectedKind, args: fixture.expectedArgs },
        produced:  { kind: "invalid-state", reason: String(err), preEffects: [], postEffects: [] } as RoutingDecision,
        reason:    `router threw: ${err}`,
      })
      continue
    }

    if (!compareKinds(decision.kind, fixture.expectedKind)) {
      divergences.push({
        fixtureId: fixture.id,
        specLine:  fixture.specLine,
        expected:  { kind: fixture.expectedKind, args: fixture.expectedArgs },
        produced:  decision,
        reason:    `kind mismatch: produced=${decision.kind} expected=${fixture.expectedKind}`,
      })
      continue
    }
    const argError = checkArgs(decision, { kind: fixture.expectedKind, args: fixture.expectedArgs })
    if (argError) {
      divergences.push({
        fixtureId: fixture.id,
        specLine:  fixture.specLine,
        expected:  { kind: fixture.expectedKind, args: fixture.expectedArgs },
        produced:  decision,
        reason:    argError,
      })
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`[shadow-coverage] fixtures: ${fixtures.length}`)
  console.log(`[shadow-coverage] spec rows: ${rowIndex.size}`)
  console.log(`[shadow-coverage] missing-fixture spec rows: ${missing.length}`)
  console.log(`[shadow-coverage] divergences: ${divergences.length}`)
  console.log()

  if (missing.length > 0) {
    console.log("Spec rows without a fixture:")
    for (const r of missing) console.log(`  L${r.lineNumber}  ${r.channel}/${r.entry}  →  ${r.expected.kind}`)
    console.log()
  }

  if (divergences.length > 0) {
    console.log("Divergences:")
    for (const d of divergences) {
      console.log(`  ${d.fixtureId} (L${d.specLine}): ${d.reason}`)
      console.log(`    expected: ${JSON.stringify(d.expected)}`)
      console.log(`    produced: ${JSON.stringify({ kind: d.produced.kind })}`)
    }
    console.log()
  }

  if (divergences.length > 0 || missing.length > 0) {
    console.log("[shadow-coverage] FAIL")
    process.exit(1)
  }
  console.log("[shadow-coverage] PASS — every fixture's router output matches its spec row")
}

main()
