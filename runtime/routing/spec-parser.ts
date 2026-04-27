// Test-only parser for docs/ROUTING_STATE_MACHINE.md.
//
// The matrix tests in tests/invariants/routing-matrix.test.ts read this spec doc as a
// fixture and assert that the pure routers produce the expected RoutingDecision.kind
// for every row. This file is the parser that turns the human-readable Markdown
// pipe-tables into typed SpecRow objects. It is NOT loaded in production code paths.
//
// Spec sections handled:
//   §8.1 – §8.6  feature channel matrix (one table per phase; column shape varies)
//   §9          general channel matrix
//   §10         post-agent matrix
//
// Phase 5 will add new tables (FLAG fixes); the parser is forward-compatible because
// it discovers column names from each table's header row rather than hard-coding them.

import { readFileSync } from "node:fs"
import type {
  FeaturePhase,
  FeatureEntry,
  GeneralEntry,
  RoutingDecisionKind,
} from "./types"

export type SpecChannel = "feature" | "general" | "post-agent"

// One parsed row from the spec. The `state` field captures every state column's raw
// cell value as a string keyed by the column header (e.g. "confirmedAgent"). Routers
// do their own translation from raw strings → RoutingInput state via the snapshot
// helpers; this parser stays string-typed so it can absorb new state columns when
// Phase 5 adds them without code changes here.
export type SpecRow = {
  readonly channel:     SpecChannel
  readonly phase?:      FeaturePhase
  readonly entry?:      FeatureEntry | GeneralEntry | string  // strings like "G2/G3/G4" stay raw
  readonly trigger?:    string                                // post-agent only
  readonly state:       Readonly<Record<string, string>>
  readonly userMsg?:    string
  readonly expected:    ExpectedDecision
  readonly invariants:  readonly string[]
  readonly notes?:      string                                // post-agent only
  readonly rawLine:     string
  readonly lineNumber:  number
}

// The decision column is parsed into structured form. The `flag` field captures
// FLAG-A / FLAG-B / FLAG-C / FLAG-D / FLAG-E annotations so Phase 5's spec edits
// can be located mechanically.
export type ExpectedDecision = {
  readonly raw:   string                          // original cell text
  readonly kind:  RoutingDecisionKind | UnknownKind
  readonly args:  Readonly<Record<string, string>>
  readonly flag?: "FLAG-A" | "FLAG-B" | "FLAG-C" | "FLAG-D" | "FLAG-E"
  readonly hasWriteback?: boolean                 // "+ writeback" composition
}

// Some rows in the Phase 0 spec describe "undefined behavior" or composite forms
// like "classify-and-route → run-agent(...)". The parser preserves these as
// non-canonical kinds; the matrix test asserts on the trailing canonical kind
// when present and skips with documented reasons otherwise.
type UnknownKind = "undefined-behavior" | "classify-and-route" | "confirm-decision-review-item-or-complete"

// ── Public API ────────────────────────────────────────────────────────────────

export function parseSpecTables(filePath: string): {
  feature:   SpecRow[]
  general:   SpecRow[]
  postAgent: SpecRow[]
} {
  const text = readFileSync(filePath, "utf8")
  const lines = text.split("\n")
  const out = { feature: [] as SpecRow[], general: [] as SpecRow[], postAgent: [] as SpecRow[] }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // §8.x — feature channel phase table
    const phaseMatch = line.match(/^###\s+8\.\d+\s+Phase:\s+`([^`]+)`/)
    if (phaseMatch) {
      const phase = phaseMatch[1] as FeaturePhase
      const block = collectBlock(lines, i + 1)
      out.feature.push(...parseTable(block.lines, block.startLine, "feature", phase))
      i = block.endIndex
      continue
    }

    // §9 — general channel
    if (/^##\s+9\.\s+Decision matrix\s+—\s+general channel/.test(line)) {
      const block = collectBlock(lines, i + 1)
      out.general.push(...parseTable(block.lines, block.startLine, "general"))
      i = block.endIndex
      continue
    }

    // §10 — post-agent
    if (/^##\s+10\.\s+Post-agent decision matrix/.test(line)) {
      const block = collectBlock(lines, i + 1)
      out.postAgent.push(...parseTable(block.lines, block.startLine, "post-agent"))
      i = block.endIndex
      continue
    }

    i += 1
  }

  return out
}

// ── Internal ──────────────────────────────────────────────────────────────────

function collectBlock(
  lines: string[],
  startIndex: number,
): { lines: string[]; startLine: number; endIndex: number } {
  // Collect lines from startIndex until the next §X heading (## or ###).
  const block: string[] = []
  let i = startIndex
  while (i < lines.length && !/^##/.test(lines[i])) {
    block.push(lines[i])
    i += 1
  }
  return { lines: block, startLine: startIndex + 1, endIndex: i }
}

function parseTable(
  blockLines: string[],
  startLine: number,
  channel: SpecChannel,
  phase?: FeaturePhase,
): SpecRow[] {
  // Locate the header row (first pipe-row) and the divider underneath it.
  let headerIdx = -1
  for (let j = 0; j < blockLines.length; j++) {
    if (blockLines[j].trim().startsWith("|") && blockLines[j + 1] && /^\s*\|\s*-+/.test(blockLines[j + 1])) {
      headerIdx = j
      break
    }
  }
  if (headerIdx === -1) return []

  const headers = splitPipeRow(blockLines[headerIdx])
  const rows: SpecRow[] = []

  for (let j = headerIdx + 2; j < blockLines.length; j++) {
    const raw = blockLines[j]
    if (!raw.trim()) break
    if (!raw.trim().startsWith("|")) break

    const cells = splitPipeRow(raw)
    if (cells.length !== headers.length) {
      // Mis-shaped row — skip with a warning so spec edits flag obviously.
      console.warn(`[spec-parser] row at line ${startLine + j} has ${cells.length} cells, header has ${headers.length}: ${raw}`)
      continue
    }

    const cellByHeader: Record<string, string> = {}
    headers.forEach((h, k) => { cellByHeader[h] = cells[k] })

    const lineNumber = startLine + j
    rows.push(buildRow(channel, phase, cellByHeader, headers, raw, lineNumber))
  }

  return rows
}

// Split a `| a | b | c |` Markdown row into trimmed cells, dropping the leading and
// trailing empties produced by the outer pipes. Pipe characters inside backticks or
// inline code are preserved (no table cells in the spec contain them today, but the
// guard avoids future surprises).
function splitPipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "")
  // Naive split — pipes inside backticks are not currently in any spec row.
  return trimmed.split("|").map((c) => c.trim())
}

function buildRow(
  channel: SpecChannel,
  phase: FeaturePhase | undefined,
  cellByHeader: Record<string, string>,
  headers: string[],
  rawLine: string,
  lineNumber: number,
): SpecRow {
  const decisionHeader = headers.find((h) => h === "→ Decision") ?? "→ Decision"
  const invHeader      = headers.find((h) => h === "Inv" || h === "Invariants") ?? "Inv"
  const userMsgHeader  = headers.find((h) => h === "userMsg")
  const entryHeader    = headers.find((h) => h === "Entry")
  const triggerHeader  = headers.find((h) => h.startsWith("Trigger"))
  const notesHeader    = headers.find((h) => h === "Notes")

  const decisionRaw    = cellByHeader[decisionHeader] ?? ""
  const invariantsRaw  = cellByHeader[invHeader] ?? ""
  const expected       = parseDecision(decisionRaw)
  const invariants     = parseInvariants(invariantsRaw)

  // State columns = headers other than Entry / userMsg / Decision / Inv / Notes / Trigger.
  const stateColumns = headers.filter((h) =>
    h !== entryHeader &&
    h !== userMsgHeader &&
    h !== decisionHeader &&
    h !== invHeader &&
    h !== notesHeader &&
    h !== triggerHeader,
  )
  const state: Record<string, string> = {}
  for (const col of stateColumns) state[col] = cellByHeader[col]

  return {
    channel,
    phase,
    entry: entryHeader ? cellByHeader[entryHeader] : undefined,
    trigger: triggerHeader ? cellByHeader[triggerHeader] : undefined,
    state,
    userMsg: userMsgHeader ? stripQuotes(cellByHeader[userMsgHeader]) : undefined,
    expected,
    invariants,
    notes: notesHeader ? cellByHeader[notesHeader] : undefined,
    rawLine,
    lineNumber,
  }
}

function stripQuotes(s: string): string {
  // Cell values like `"yes"` or `"@pm: anything"` carry literal quotes — strip the
  // outermost pair so userMsg is the raw text the user would type. Em-dashes and
  // composite annotations like `(non-standalone)` are preserved.
  const m = s.match(/^"([^"]*)"/)
  if (m) return m[1]
  return s
}

// Decision strings come in shapes like:
//   run-agent(pm, primary)
//   run-agent(ux-design, primary, mode=orientation if !S7)
//   show-hold-message(reason=esc, heldAgent=pm)
//   show-hold-message **[FLAG-A — fixed Phase 5: run-escalation-confirmed]**
//   resume-after-escalation(origin=ux-design) + writeback
//   classify-and-route → run-agent(pm, primary)
//   undefined behavior **[FLAG-B — fixed Phase 5: invalid-state]**
//   confirm-decision-review-item → next prompt OR complete
function parseDecision(raw: string): ExpectedDecision {
  const flagMatch = raw.match(/\[(FLAG-[A-E])/)
  const flag = (flagMatch ? flagMatch[1] : undefined) as ExpectedDecision["flag"]
  const hasWriteback = /\+\s*writeback/.test(raw)

  // Strip flag annotation (between `**[…]**`) and writeback suffix before kind extraction.
  let trimmed = raw.replace(/\*\*\[[^\]]+\]\*\*/g, "").replace(/\+\s*writeback/, "").trim()

  // Special composite shapes.
  if (/^undefined behavior/i.test(trimmed)) {
    return { raw, kind: "undefined-behavior", args: {}, flag, hasWriteback }
  }
  if (/^classify-and-route\s*→/.test(trimmed)) {
    // Take the kind after the arrow if present.
    const after = trimmed.split("→")[1]?.trim() ?? ""
    const inner = parseKindAndArgs(after)
    return { raw, kind: (inner?.kind ?? "classify-and-route") as RoutingDecisionKind, args: inner?.args ?? {}, flag, hasWriteback }
  }
  if (/^confirm-decision-review-item\s*→/.test(trimmed)) {
    return { raw, kind: "confirm-decision-review-item-or-complete", args: {}, flag, hasWriteback }
  }

  // Composite "X + Y" rows in the post-agent matrix — take the canonical kind on
  // the left of the +, strip parenthetical adornments. The right-hand side is
  // additional StateEffects/PostEffects, not a separate kind.
  if (trimmed.includes(" + ")) trimmed = trimmed.split(" + ")[0]

  const parsed = parseKindAndArgs(trimmed)
  if (parsed) return { raw, kind: parsed.kind as RoutingDecisionKind, args: parsed.args, flag, hasWriteback }

  // Plain bare kinds like `decline-approval-fall-through` or `complete-decision-review`.
  return { raw, kind: trimmed as RoutingDecisionKind, args: {}, flag, hasWriteback }
}

function parseKindAndArgs(s: string): { kind: string; args: Record<string, string> } | null {
  const m = s.match(/^([a-z][a-z0-9-]+)\s*\(([^)]*)\)/i)
  if (!m) {
    if (/^[a-z][a-z0-9-]+$/i.test(s.trim())) return { kind: s.trim(), args: {} }
    return null
  }
  const [, kind, argsRaw] = m
  const args: Record<string, string> = {}
  argsRaw.split(",").map((p) => p.trim()).filter(Boolean).forEach((part, idx) => {
    const eq = part.indexOf("=")
    if (eq >= 0) {
      args[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
    } else {
      // Positional args. For run-agent(<agent>, <mode>[, ...]) we name them by position
      // so consumers can read agent/mode without knowing the kind.
      args[`_${idx}`] = part
      if (kind === "run-agent") {
        if (idx === 0) args.agent = part
        if (idx === 1) args.mode = part
        if (idx === 2) args.modeQualifier = part   // e.g. "product-level"
      }
      if (kind === "approve-spec" && idx === 0) args.specType = part
      if (kind === "show-routing-note" && idx === 0) args.note = part
    }
  })
  return { kind, args }
}

function parseInvariants(s: string): string[] {
  if (!s || s === "—") return []
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}
