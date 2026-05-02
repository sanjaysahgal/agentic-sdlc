#!/usr/bin/env tsx
/**
 * [CANONICAL-CONSISTENCY GATE]
 *
 * Pre-commit hook script. Cross-checks that the canonical work-tracking
 * surfaces stay mutually consistent:
 *
 *   1. Every `MT-N` referenced in BACKLOG.md exists as `### MT-N — ...` in
 *      MANUAL_TESTS.md. (Catches the failure mode where MT-N is added to a
 *      Step callout's MT inventory table without creating the scenario.)
 *
 *   2. Every manifest ID (e.g., A4, B13, O1, F2) referenced in BACKLOG.md
 *      exists as an item in docs/cutover-gate-status.json — with two
 *      documented exemptions:
 *        a. Block-N runtime feature names (N, N2, N13, N16-N19) are runtime
 *           code names per BACKLOG line 6 ("permanent secondary identifiers")
 *           not manifest items. Skipped.
 *        b. Future-bug placeholders ("B17, B18, ..." used in prose to mean
 *           "the next bugs to be added") — detected by the literal "B17, B18"
 *           pattern in prose. Skipped.
 *
 * Exits 0 if consistent; exits 1 with a human-readable remediation hint if
 * any gap is found. Wired into .claude/settings.json PreToolUse Bash hook on
 * `git commit` when BACKLOG.md, MANUAL_TESTS.md, MANUAL_TESTS_PENDING.md, or
 * docs/cutover-gate-status.json is staged.
 *
 * Companion to: tests/invariants/manual-test-catalog.test.ts (which enforces
 * MT-IDs are sequential within MANUAL_TESTS.md). This script enforces the
 * cross-document references stay in lockstep.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(__dirname, "..")
const BACKLOG = resolve(REPO_ROOT, "BACKLOG.md")
const CATALOG = resolve(REPO_ROOT, "MANUAL_TESTS.md")
const MANIFEST = resolve(REPO_ROOT, "docs/cutover-gate-status.json")

// Block letters that are RUNTIME feature names (per CLAUDE.md / BACKLOG line 6
// "permanent secondary identifiers"), NOT manifest items. References to these
// in BACKLOG prose are intentional and must not trigger the gate.
//
// "Block N" / "Block N2" / "Block N13" etc. are runtime hedge-gate / stripper /
// classifier features. The manifest uses other letters for these blocks (B for
// bugs, F for new agents, etc.).
const RUNTIME_ONLY_PREFIXES = new Set(["N"])

// Prose patterns where a manifest-shaped token is intentionally NOT a manifest
// reference (e.g., future-bug placeholders, version references).
const PROSE_EXEMPT_PATTERNS = [
  /B17, B18, \.\.\./g,         // "B17, B18, ... (next bugs to be added)" placeholder
  /B11 v1/g,                    // "B11 v1" version label, not a separate item
  /B11 v2/g,                    // future "B11 v2" reference
  /B9b/g,                       // B9b is the cross-agent-parity sibling, tracked under B9 verification_note
  /\bI8\b/g,                    // I8 is a routing-state migration label (not in manifest; tracked under I-block prose)
  /\bI11\b/g,                   // I11 is a routing-types invariant code-name (not in manifest)
  /\bM0\b/g,                    // M0 / M1 are MILESTONE labels (the destination), not manifest items.
  /\bM1\b/g,                    // M1 the milestone is distinct from M1 the manifest entry; both exist by intent.
  /\bM2\b/g,                    // future milestone label
]

function readManifestIds(): Set<string> {
  const raw = readFileSync(MANIFEST, "utf8")
  const data = JSON.parse(raw) as { items: Array<{ id: string }> }
  return new Set(data.items.map((item) => item.id))
}

function extractMtIdsFrom(source: string, kind: "ref" | "header"): Set<string> {
  // For BACKLOG: any `MT-\d+` mention is a reference.
  // For CATALOG: only `### MT-\d+ — ...` headers are scenario definitions.
  const re = kind === "header" ? /^### (MT-\d+) — /gm : /\b(MT-\d+)\b/g
  const ids = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) ids.add(m[1])
  return ids
}

function extractManifestIdsFrom(source: string): Set<string> {
  // Strip prose-exempt patterns BEFORE matching.
  let cleaned = source
  for (const pat of PROSE_EXEMPT_PATTERNS) {
    cleaned = cleaned.replace(pat, "")
  }
  // Manifest IDs are <UPPERCASE_LETTER><1-2 digits>: A4, B13, O1, F2, etc.
  const re = /\b([A-O])(1?\d)\b/g
  const ids = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const prefix = m[1]
    if (RUNTIME_ONLY_PREFIXES.has(prefix)) continue
    ids.add(`${prefix}${m[2]}`)
  }
  return ids
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort()
}

function main(): void {
  const backlog = readFileSync(BACKLOG, "utf8")
  const catalog = readFileSync(CATALOG, "utf8")

  const backlogMts = extractMtIdsFrom(backlog, "ref")
  const catalogMts = extractMtIdsFrom(catalog, "header")
  const missingFromCatalog = diff(backlogMts, catalogMts)

  const backlogManifestIds = extractManifestIdsFrom(backlog)
  const manifestIds = readManifestIds()
  const missingFromManifest = diff(backlogManifestIds, manifestIds)

  const errors: string[] = []
  if (missingFromCatalog.length > 0) {
    errors.push(
      `BACKLOG.md references ${missingFromCatalog.length} MT-N${missingFromCatalog.length === 1 ? "" : "s"} not defined in MANUAL_TESTS.md: ${missingFromCatalog.join(", ")}.\n` +
      `  Fix: add ### ${missingFromCatalog[0]} — <title> section to MANUAL_TESTS.md with all required sections (Why this can't be automated, Setup, Actions, Expected outcome, Failure signatures). Then add a corresponding spot-check or blocking entry to MANUAL_TESTS_PENDING.md.`,
    )
  }
  if (missingFromManifest.length > 0) {
    errors.push(
      `BACKLOG.md references ${missingFromManifest.length} manifest ID${missingFromManifest.length === 1 ? "" : "s"} not in docs/cutover-gate-status.json: ${missingFromManifest.join(", ")}.\n` +
      `  Fix: add the missing item${missingFromManifest.length === 1 ? "" : "s"} to docs/cutover-gate-status.json with all required fields (id, title, block, gates_block_e, status, verification, retired_by_v2_cutover, m0_required) and a verification_note explaining scope.\n` +
      `  If the reference is intentionally not a manifest item (runtime-only feature name, prose placeholder, version label), add the pattern to PROSE_EXEMPT_PATTERNS or RUNTIME_ONLY_PREFIXES in scripts/check-canonical-consistency.ts.`,
    )
  }

  if (errors.length === 0) {
    console.log(`[CANONICAL-CONSISTENCY GATE] ✓ BACKLOG.md ↔ MANUAL_TESTS.md ↔ docs/cutover-gate-status.json consistent (${backlogMts.size} MTs, ${backlogManifestIds.size} manifest refs).`)
    process.exit(0)
  }

  console.error("\n[CANONICAL-CONSISTENCY GATE] cross-reference check FAILED:\n")
  for (const e of errors) console.error(`  • ${e}\n`)
  process.exit(1)
}

main()
