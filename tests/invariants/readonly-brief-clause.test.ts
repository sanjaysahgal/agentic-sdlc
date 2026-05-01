// CLAUDE.md Principle 8 (platform enforcement first) + Principle 15 (cross-agent
// parity) + manifest B7 (regression catalog bug #15).
//
// When the platform invokes PM/Designer/Architect with `readOnly: true`, the
// agent has no spec-writing tools. The brief must declare that constraint up
// front so the agent does not write prose like "Applying the patch to AC 10
// now" — the very claim is a contract violation, since no patch can happen
// (no tools provided).
//
// Cross-agent parity rule: every brief that runs an agent in `readOnly: true`
// mode must inject the shared constant `READONLY_AGENT_BRIEF_CLAUSE` from
// `runtime/readonly-brief-clause.ts`. This invariant pins both halves of the
// contract:
//   1. Every `readOnly: true` invocation in production handlers is paired
//      with a brief that contains the marker.
//   2. The shared constant exists, is non-empty, and includes the marker
//      substring used for detection.
//
// Adding a new readOnly brief site requires injecting the clause AND
// extending the EXPECTED_BRIEF_LABELS list below.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  READONLY_AGENT_BRIEF_CLAUSE,
  READONLY_BRIEF_MARKER,
} from "../../runtime/readonly-brief-clause"

const REPO_ROOT = resolve(__dirname, "..", "..")
const MESSAGE_TS = resolve(REPO_ROOT, "interfaces/slack/handlers/message.ts")

describe("READONLY_AGENT_BRIEF_CLAUSE — module-level sanity", () => {
  it("the clause is non-empty and contains the marker substring", () => {
    expect(READONLY_AGENT_BRIEF_CLAUSE.length).toBeGreaterThan(100)
    expect(READONLY_AGENT_BRIEF_CLAUSE).toContain(READONLY_BRIEF_MARKER)
  })

  it("the clause names the contract: agent has no spec-writing tools", () => {
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/no spec-writing tools/i)
  })

  it("the clause forbids action-claim phrasing (the actual prose-vs-state mismatch class)", () => {
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/Applying the patch/i)
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/I'll update the (product|design|engineering)? ?spec/i)
  })

  it("the clause names the contract resolution: human says yes, platform applies", () => {
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/after the human says yes/i)
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/recommend.*platform applies/i)
  })
})

// ── Production-handler enforcement (Principle 15 cross-agent parity) ────────
//
// The pinned set of brief variable identifiers in interfaces/slack/handlers/
// message.ts that are passed to runPmAgent/runArchitectAgent/handleDesignPhase
// with `readOnly: true`. Each must contain the marker substring.
//
// Adding a new brief site requires extending this list AND injecting the
// constant at the brief-construction site.

interface BriefSite {
  /** Human-readable name for failure messages. */
  label:    string
  /** A unique substring that identifies the brief's heading in source — used
   *  to locate the brief body in message.ts. */
  heading:  string
}

const EXPECTED_BRIEF_LABELS: BriefSite[] = [
  { label: "Path A — designer→PM brief (DESIGN TEAM ESCALATION — PM RECOMMENDATIONS)",        heading: "DESIGN TEAM ESCALATION — PM RECOMMENDATIONS NEEDED" },
  { label: "Path A — designer→architect brief (DESIGN TEAM ESCALATION — ARCHITECT RECOMMENDATIONS)", heading: "DESIGN TEAM ESCALATION — ARCHITECT RECOMMENDATIONS NEEDED" },
  { label: "Path B — architect→designer brief (ARCHITECT ESCALATION — Design revision)",      heading: "ARCHITECT ESCALATION — Design revision needed" },
  { label: "Path B — architect→PM brief (ARCHITECT ESCALATION — PM decision)",                heading: "ARCHITECT ESCALATION — PM decision needed" },
]

describe("readOnly brief clause is injected at every production brief site (B7 cross-agent parity)", () => {
  const source = readFileSync(MESSAGE_TS, "utf-8")

  it.each(EXPECTED_BRIEF_LABELS)("$label injects the READONLY_AGENT_BRIEF_CLAUSE constant via template interpolation", ({ label, heading }) => {
    // Locate the brief body by its unique heading. The body extends from the
    // heading to roughly the next 2000 chars (more than enough for any brief;
    // no brief is longer than ~1500 chars including the clause).
    //
    // The brief in source uses template literal interpolation
    // (`${READONLY_AGENT_BRIEF_CLAUSE}`), so the marker substring won't appear
    // literally — we check for the variable name as the structural signal that
    // the constant was injected. This is the right thing to assert: the
    // variable rename will fail-loudly here, and the actual clause content is
    // pinned by the module-level test above.
    const idx = source.indexOf(heading)
    if (idx === -1) {
      throw new Error(
        `Brief site '${label}' not found in interfaces/slack/handlers/message.ts. ` +
        `Either the heading was renamed (update EXPECTED_BRIEF_LABELS) or the brief was removed.`,
      )
    }
    const body = source.slice(idx, idx + 2000)
    if (!/\$\{READONLY_AGENT_BRIEF_CLAUSE\}/.test(body)) {
      throw new Error(
        `[B7 / Principle 15] Brief site '${label}' is missing the \${READONLY_AGENT_BRIEF_CLAUSE} interpolation. ` +
        `Inject the clause constant into the brief template, OR if this brief is ` +
        `legitimately NOT readOnly (the agent has spec-writing tools), remove it from EXPECTED_BRIEF_LABELS ` +
        `with a one-line justification in the comment above the list.`,
      )
    }
  })

  it("structural assertion: every readOnly: true call site for runPmAgent / runArchitectAgent in message.ts has a paired brief with the clause (cross-check via heading proximity)", () => {
    // Defense-in-depth check: locate every `readOnly: true` occurrence in source
    // and assert that within a 4000-char window BEFORE the call, one of the
    // expected brief headings appears. This catches the "added a new readOnly
    // call without a brief" failure mode that the per-brief test above misses.
    const readOnlyCallRe = /readOnly:\s*true/g
    const expectedHeadings = EXPECTED_BRIEF_LABELS.map((b) => b.heading)
    let m: RegExpExecArray | null
    let visitedCount = 0
    while ((m = readOnlyCallRe.exec(source)) !== null) {
      const callIdx = m.index
      // Skip occurrences inside type/property declarations (e.g. function signatures,
      // option-bag destructures); only count CALL sites where readOnly: true is
      // passed as an argument (preceded within ~50 chars by `runPmAgent(` / etc).
      const window = source.slice(Math.max(0, callIdx - 200), callIdx)
      const isCallSite = /(runPmAgent|runArchitectAgent|runDesignAgent|handleDesignPhase)\s*\(/.test(window) ||
                         /readOnly:\s*slashOverrideReadOnly/.test(window)
      if (!isCallSite) continue
      visitedCount++

      // Look back up to 4000 chars to find the brief heading.
      const lookbackStart = Math.max(0, callIdx - 4000)
      const lookback = source.slice(lookbackStart, callIdx)
      const hasMatchingHeading = expectedHeadings.some((h) => lookback.includes(h))
      if (!hasMatchingHeading) {
        // Some readOnly call sites are continuations (e.g. the architect
        // upstream-continuation branch where the userMessage is the human's
        // reply, not a fresh brief). Those don't have a brief heading
        // immediately upstream — they rely on conversation history carrying
        // the original brief's clause forward. We allow this by checking for
        // an explicit "// readOnly continuation" marker in the surrounding
        // source. See arch-upstream-continuation branch.
        const isContinuation = /readOnly[^\n]*continuation|continuation[^\n]*readOnly|escalation continuation/i.test(
          source.slice(Math.max(0, callIdx - 500), callIdx + 200),
        )
        if (isContinuation) continue
        throw new Error(
          `[B7 / Principle 8] Found readOnly: true call site at char index ${callIdx} in message.ts ` +
          `with no brief heading from EXPECTED_BRIEF_LABELS in the preceding 4000 chars. ` +
          `Either (a) add the brief heading + READONLY_AGENT_BRIEF_CLAUSE for this site and extend ` +
          `EXPECTED_BRIEF_LABELS, or (b) annotate the call with a comment explaining it's a ` +
          `continuation (history-carried clause): "// readOnly continuation: ...".`,
        )
      }
    }
    expect(visitedCount, "expected at least the 3 readOnly call sites we know about (Path A PM, Path A architect, Path B PM); if 0, the regex stopped working").toBeGreaterThanOrEqual(3)
  })
})
