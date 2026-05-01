// CLAUDE.md Principle 16 — Spec write ownership.
//
// "Resolved decisions land only in the owner's spec, written by the platform
// as scribe for the authoring agent. Open items can be preseeded by upstream
// agents into the owner's spec, but never resolved content."
//
// Owner table:
//   PM        → product.md     (also: pm-escalation-spec-writer.ts)
//   Designer  → design.md      (also: design-escalation-spec-writer.ts)
//   Architect → engineering.md (also: engineering-spec-decision-writer.ts)
//
// This invariant audits every callsite of the writeback APIs and asserts
// each is in the allowed set: owner-consistent OR an explicitly-documented
// carve-out (preseed-open-items, reciprocal cleanup of transient handoff
// sections). Adding a new writeback that doesn't fit fails at PR time.
//
// Historical violation (manifest B8, regression catalog bug #14):
// `patchEngineeringSpecWithDecision` was called from BOTH the designer's
// escalation reply (correct — architect-authored content into engineering
// spec) AND the architect's upstream-revision-reply (wrong — PM/designer-
// authored content recorded under a `### Architect Decision` heading in the
// engineering spec, with append-only layout that produced N duplicate-heading
// blocks per N escalations). The B8 fix removes the wrong call. This test
// pins the post-fix shape so a future B8-class regression fails at PR time.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(__dirname, "..", "..")
const MESSAGE_TS = resolve(REPO_ROOT, "interfaces/slack/handlers/message.ts")
const TOOL_HANDLERS_TS = resolve(REPO_ROOT, "runtime/tool-handlers.ts")

// ── Allowed-callsite manifest ────────────────────────────────────────────────
//
// Each entry = (writeback function name, file, expected count).
// Counts pin both upper and lower bound — a missing call AND an extra call
// both fail. New legitimate callsites must update this manifest in the same
// commit (and add a comment explaining the new path's owner-consistency).
//
// Owner-consistency rationale embedded in the comments below. Carve-outs are
// labeled CARVE-OUT explicitly.

interface AllowedCallsite {
  fn:        string  // function name as it appears in source
  file:      string  // absolute path
  count:     number  // expected number of CALL occurrences (not import lines, not type lines)
  rationale: string  // why this passes Principle 16
}

const ALLOWED: AllowedCallsite[] = [
  // ── PM tools (PM author → product spec) ──
  { fn: "saveDraftSpec",     file: TOOL_HANDLERS_TS, count: 2, rationale: "PM tool: save_product_spec_draft + apply_product_spec_patch — PM-authored → product spec." },
  { fn: "saveApprovedSpec",  file: TOOL_HANDLERS_TS, count: 1, rationale: "PM tool: finalize_product_spec — PM-authored → product spec." },

  // ── Architect tools (architect author → engineering spec) ──
  { fn: "saveDraftEngineeringSpec",    file: TOOL_HANDLERS_TS, count: 2, rationale: "Architect tools: save_engineering_spec_draft + apply_engineering_spec_patch — architect-authored → engineering spec." },
  { fn: "saveApprovedEngineeringSpec", file: TOOL_HANDLERS_TS, count: 1, rationale: "Architect tool: finalize_engineering_spec — architect-authored → engineering spec." },

  // ── Designer tools (designer author → design spec) ──
  { fn: "saveDraftDesignSpec",    file: TOOL_HANDLERS_TS, count: 1, rationale: "Designer tool: apply_design_spec_patch — designer-authored → design spec." },
  { fn: "saveApprovedDesignSpec", file: TOOL_HANDLERS_TS, count: 1, rationale: "Designer tool: finalize_design_spec — designer-authored → design spec." },

  // ── CARVE-OUT: preseed open items / handoff sections ──
  { fn: "preseedEngineeringSpec", file: TOOL_HANDLERS_TS, count: 2, rationale: "CARVE-OUT: designer's offer_pm_escalation + offer_architect_escalation queue UNRESOLVED architect-scope items as TODOs in the engineering spec for the architect to resolve. Allowed by Principle 16 carve-out." },
  { fn: "seedHandoffSection",     file: TOOL_HANDLERS_TS, count: 1, rationale: "CARVE-OUT: designer's finalize_design_spec seeds `## Design Assumptions To Validate` into engineering spec — explicit transient-state handoff for architect to validate. Allowed by Principle 16 carve-out." },
  { fn: "clearHandoffSection",    file: TOOL_HANDLERS_TS, count: 1, rationale: "CARVE-OUT: architect's finalize_engineering_spec removes `## Design Assumptions` from design spec on main — reciprocal cleanup of section the designer marked transient. Allowed by Principle 16 carve-out." },

  // ── message.ts: escalation-reply writebacks ──
  { fn: "updateApprovedSpecOnMain",            file: MESSAGE_TS, count: 1, rationale: "Escalation auto-close: applies PM-saved branch content to product spec on main. PM-authored → product spec." },
  { fn: "patchEngineeringSpecWithDecision",    file: MESSAGE_TS, count: 1, rationale: "Path A (designer→architect escalation reply): architect-authored content → engineering spec. NOTE: B8 removed the SECOND call (architect's upstream-revision-reply branch) — that wrote PM/designer content into engineering spec. Single allowed call remains." },
  { fn: "patchProductSpecWithRecommendations", file: MESSAGE_TS, count: 2, rationale: "Both escalation paths (designer→PM AND architect→PM): PM-authored content → product spec. Both are owner-consistent." },
  { fn: "patchDesignSpecWithRecommendations",  file: MESSAGE_TS, count: 1, rationale: "Path B (architect→designer escalation reply): designer-authored content → design spec. Owner-consistent." },

  // ── message.ts: pending-approval handlers ──
  { fn: "saveApprovedSpec",            file: MESSAGE_TS, count: 1, rationale: "pendingApproval handler: PM's saved draft promoted to approved on product spec branch. PM-authored → product spec." },
  { fn: "saveApprovedDesignSpec",      file: MESSAGE_TS, count: 1, rationale: "pendingDesignApproval handler: designer's draft promoted. Designer-authored → design spec." },
  { fn: "saveDraftEngineeringSpec",    file: MESSAGE_TS, count: 1, rationale: "pendingReview handler: architect's draft. Architect-authored → engineering spec." },
  { fn: "saveApprovedEngineeringSpec", file: MESSAGE_TS, count: 1, rationale: "pendingEngineeringApproval handler: architect's draft promoted. Architect-authored → engineering spec." },
]

// ── Counter ──────────────────────────────────────────────────────────────────
//
// Counts the number of CALL occurrences of `fn(` in the source — i.e. lines
// where `<fn>(` appears AND that aren't import lines, type alias lines, or
// in-comment references. Greedy enough to catch real calls, tight enough to
// not false-positive on the import.

function countCalls(source: string, fn: string): number {
  let count = 0
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // Skip imports
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) continue
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue
    // Skip TypeScript type-only references in interface bodies (`fn: ...`)
    // — call uses `fn(` whereas type uses `fn:`. The regex below requires
    // an open-paren after the function name with optional whitespace.
    const callRe = new RegExp(`(?<![A-Za-z0-9_])${fn}\\s*\\(`)
    if (callRe.test(line)) count++
  }
  return count
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Principle 16 — spec write ownership (structural invariant)", () => {
  // The MESSAGE_TS source includes the destructured `deps` block in the
  // PmToolDeps construction (e.g. `saveDraftSpec,` as a property shorthand).
  // Those are not call sites — they're function references being passed as
  // dependencies. The `<fn>(` regex correctly excludes them because there's
  // no open-paren immediately after.

  for (const allowed of ALLOWED) {
    it(`${allowed.fn} appears ${allowed.count} time(s) in ${allowed.file.replace(REPO_ROOT + "/", "")} — ${allowed.rationale.slice(0, 80)}`, () => {
      const source = readFileSync(allowed.file, "utf-8")
      const observed = countCalls(source, allowed.fn)
      if (observed !== allowed.count) {
        throw new Error(
          `${allowed.fn} expected ${allowed.count} call(s) in ${allowed.file.replace(REPO_ROOT + "/", "")}, found ${observed}.\n` +
          `Rationale: ${allowed.rationale}\n` +
          `If this change is intentional, update the ALLOWED manifest in this test with a one-sentence rationale explaining why the new callsite is owner-consistent (Principle 16) or fits a documented carve-out.`,
        )
      }
    })
  }

  it("there is exactly ONE patchEngineeringSpecWithDecision callsite in message.ts (B8 retired the second one)", () => {
    // Pinned separately because B8 is the canonical violation. If a future
    // change reintroduces a second call, this test fires with a B8-named
    // error so the regression is unambiguous.
    const source = readFileSync(MESSAGE_TS, "utf-8")
    const count = countCalls(source, "patchEngineeringSpecWithDecision")
    if (count !== 1) {
      throw new Error(
        `[B8 REGRESSION] patchEngineeringSpecWithDecision must appear exactly once in interfaces/slack/handlers/message.ts. ` +
        `Found ${count} call(s). The legitimate call is the designer→architect escalation reply (Path A); the wrong call ` +
        `(architect→PM/designer escalation reply, Path B) was removed by B8 because it wrote PM/designer-authored content ` +
        `into the architect-owned engineering spec — violation of CLAUDE.md Principle 16.`,
      )
    }
  })

  it("the architect's upstream-revision-reply branch does NOT call patchEngineeringSpecWithDecision (B8 retirement assertion)", () => {
    // Locate the "arch-upstream-revision-reply" branch and assert it does
    // not contain the now-retired engineering-spec writeback. This is a
    // structural assertion against the specific code path that violated
    // Principle 16, complementing the count-based assertion above.
    const source = readFileSync(MESSAGE_TS, "utf-8")
    const branchMarker = `branch=arch-upstream-revision-reply`
    const markerIdx = source.indexOf(branchMarker)
    expect(markerIdx, `expected the [ROUTER] log marker ${branchMarker} to be present in message.ts`).toBeGreaterThan(-1)

    // Window: the branch body runs from the marker to the next 3000 chars
    // (the branch is bounded by the next major branch return; 3000 chars
    // is more than enough to cover the writeback block but not bleed into
    // unrelated branches).
    const branchBody = source.slice(markerIdx, markerIdx + 3000)
    expect(branchBody).not.toMatch(
      /patchEngineeringSpecWithDecision\s*\(/,
      "[B8 REGRESSION] arch-upstream-revision-reply branch must NOT call patchEngineeringSpecWithDecision — that was the B8 violation. Upstream's resolved content lands in the upstream spec only (product or design); architect re-reads it from there.",
    )
  })
})
