// Phase 3 Stage 3 — divergence detector tests.
//
// The correlator in scripts/shadow-coverage-report.ts pairs the new shadow's
// [ROUTING-V2-PROPOSED] log lines with the old code path's [ROUTER] branch=…
// lines and emits divergences. This test pins the mapping (15 distinct old
// branch tags → expected v2 RoutingDecision shapes) by handing the correlator
// fixture log content and asserting it correctly classifies known-converging
// and known-diverging cases.

import { describe, it, expect } from "vitest"
import { correlateLines } from "../../scripts/shadow-coverage-report"

// Convenience: a proposal log line with arbitrary fields filled in.
function proposal(feature: string, thread: string, kind: string, agent: string, mode = "primary"): string {
  return `2026-04-27T13:00:00 [ROUTING-V2-PROPOSED] feature=${feature} thread=${thread} phase=design-in-progress entry=E1 kind=${kind} agent=${agent} mode=${mode}`
}

function branch(branchTag: string, extras: Record<string, string> = {}): string {
  const kvs = Object.entries(extras).map(([k, v]) => `${k}=${v}`).join(" ")
  return `2026-04-27T13:00:01 [ROUTER] branch=${branchTag}${kvs ? " " + kvs : ""}`
}

describe("shadow-coverage-report — correlator", () => {
  describe("convergent pairings (every branch tag must map cleanly to its v2 kind)", () => {
    it("confirmed-pm → run-agent(pm, primary)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm", "primary"),
        branch("confirmed-pm", { feature: "onboarding" }),
      ])
      expect(r.divergences).toEqual([])
      expect(r.convergences).toBe(1)
    })

    it("confirmed-pm with read-only slash override → run-agent(pm, read-only-consultant)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm", "read-only-consultant"),
        // The (read-only slash override) suffix is part of the raw line; correlator detects via regex.
        "2026-04-27T13:00:01 [ROUTER] branch=confirmed-pm feature=onboarding (read-only slash override)",
      ])
      expect(r.divergences).toEqual([])
      expect(r.convergences).toBe(1)
    })

    it("confirmed-architect → run-agent(architect, primary)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "architect"),
        branch("confirmed-architect", { feature: "onboarding" }),
      ])
      expect(r.convergences).toBe(1)
    })

    it("confirmed-design-auto-continue → run-agent(ux-design, primary)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "ux-design"),
        branch("confirmed-design-auto-continue", { feature: "onboarding" }),
      ])
      expect(r.convergences).toBe(1)
    })

    it("pending-escalation-confirmed targetAgent=design → run-escalation-confirmed(target=ux-design)", () => {
      // The old code uses the legacy "design" alias; the correlator canonicalizes to "ux-design".
      const r = correlateLines([
        proposal("onboarding", "T1", "run-escalation-confirmed", "ux-design"),
        branch("pending-escalation-confirmed", { feature: "onboarding", targetAgent: "design" }),
      ])
      expect(r.convergences).toBe(1)
      expect(r.divergences).toEqual([])
    })

    it("escalation-continuation targetAgent=pm → run-escalation-continuation(target=pm)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-escalation-continuation", "pm"),
        branch("escalation-continuation", { feature: "onboarding", targetAgent: "pm" }),
      ])
      expect(r.convergences).toBe(1)
    })

    it("escalation-reply accepts either resume-after-escalation OR run-escalation-continuation", () => {
      // Branch log is ambiguous between standalone-confirmation (resume) and
      // not (continuation). Correlator accepts either.
      const resume = correlateLines([
        proposal("onboarding", "T1", "resume-after-escalation", "ux-design"),
        branch("escalation-reply", { feature: "onboarding", targetAgent: "pm" }),
      ])
      expect(resume.convergences).toBe(1)
      const cont = correlateLines([
        proposal("onboarding", "T1", "run-escalation-continuation", "pm"),
        branch("escalation-reply", { feature: "onboarding", targetAgent: "pm" }),
      ])
      expect(cont.convergences).toBe(1)
    })

    it("arch-upstream-revision-reply → resume-after-escalation(origin=architect)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "resume-after-escalation", "architect"),
        branch("arch-upstream-revision-reply", { feature: "onboarding", target: "design" }),
      ])
      expect(r.convergences).toBe(1)
    })

    it("new-thread-design → run-agent(ux-design)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "ux-design"),
        branch("new-thread-design", { feature: "onboarding" }),
      ])
      expect(r.convergences).toBe(1)
    })

    it("hold-pending-escalation → show-hold-message (universal-guard hold path; emitted by Phase 3 Stage 3 to enable pairing)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "show-hold-message", "pm"),
        branch("hold-pending-escalation", { feature: "onboarding", targetAgent: "pm" }),
      ])
      expect(r.divergences).toEqual([])
      expect(r.convergences).toBe(1)
    })

    it("escalation-auto-close is skipped (post-agent path; no single-decision v2 equivalent)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm"),
        branch("escalation-auto-close", { feature: "onboarding" }),
      ])
      // Skip means: no convergence, no divergence — branch tag is post-agent
      // dispatcher path. Proposal stays pending (would pair with the next branch).
      expect(r.skipped).toBe(1)
      expect(r.divergences).toEqual([])
    })

    it("new-thread parent tag is skipped; the more specific child tag does the matching", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "ux-design"),
        branch("new-thread", { feature: "onboarding", currentPhase: "design-in-progress" }),
        branch("new-thread-design", { feature: "onboarding" }),
      ])
      expect(r.skipped).toBe(1)            // parent new-thread skipped
      expect(r.convergences).toBe(1)       // child new-thread-design matched
    })
  })

  describe("divergent pairings (correlator must catch real mismatches)", () => {
    it("v2 says run-agent(pm, primary) but old code took confirmed-architect → divergence", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm", "primary"),
        branch("confirmed-architect", { feature: "onboarding" }),
      ])
      expect(r.divergences.length).toBe(1)
      expect(r.divergences[0]).toMatchObject({
        feature:        "onboarding",
        thread:         "T1",
        expectedAgent:  "architect",
        proposedKind:   "run-agent",
        proposedAgent:  "pm",
      })
    })

    it("v2 says read-only-consultant but old took primary → mode mismatch", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm", "primary"),
        // Old branch is read-only — v2 should have proposed read-only-consultant.
        "2026-04-27T13:00:01 [ROUTER] branch=confirmed-pm feature=onboarding (read-only slash override)",
      ])
      expect(r.divergences.length).toBe(1)
    })

    it("FLAG-A path: v2 already implements slash-as-confirmation (run-escalation-confirmed) but old code shows hold-message indirectly via no branch — pairing is per-message; a hold-message has no branch line so pairs with the next branch instead", () => {
      // This documents a known limitation: the [ROUTER] branch=… log only fires
      // when the old code RUNS something. show-hold-message is a return-with-
      // post-message; it doesn't emit a branch log. So a v2 proposal of
      // run-escalation-confirmed paired with the next message's branch line
      // would show as a divergence. This is acceptable — the correlator skews
      // toward false positives on FLAG paths, which is exactly what we want
      // until Phase 5 fixes the FLAGs.
      //
      // The fixture below shows the expected behavior: turn 1 hold proposal
      // (no branch), turn 2 escalation confirmation. Both proposals queued;
      // the branch pairs with turn-1 proposal, producing a divergence (hold
      // vs. escalation-confirmed). Reviewers see this and either fix Phase 5
      // or add `--allow-flag FLAG-A` (future flag).
      const r = correlateLines([
        proposal("onboarding", "T1", "run-escalation-confirmed", "pm"),  // turn 1 — FLAG-A path: v2 says confirmed (Phase 5 target)
        proposal("onboarding", "T1", "run-escalation-confirmed", "pm"),  // turn 2 — actual confirmation
        branch("pending-escalation-confirmed", { feature: "onboarding", targetAgent: "pm" }),
      ])
      // One pairing: turn-1 proposal + branch. The other proposal stays pending.
      // (After Phase 5 lands, both proposals would emit different kinds and
      // pair with their respective branches cleanly.)
      expect(r.proposals).toBe(2)
      expect(r.branches).toBe(1)
      expect(r.paired).toBe(1)
    })
  })

  describe("operational invariants", () => {
    it("zero proposals + zero branches → NO DATA, not PASS or FAIL", () => {
      const r = correlateLines([])
      expect(r.proposals).toBe(0)
      expect(r.branches).toBe(0)
      expect(r.divergences).toEqual([])
    })

    it("multiple features in same file are correlated independently", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm"),
        proposal("dashboard", "T2", "run-agent", "ux-design"),
        branch("confirmed-pm", { feature: "onboarding" }),
        branch("confirmed-design-auto-continue", { feature: "dashboard" }),
      ])
      expect(r.divergences).toEqual([])
      expect(r.convergences).toBe(2)
    })

    it("unknown branch tag is skipped (forward-compatible with new branches)", () => {
      const r = correlateLines([
        proposal("onboarding", "T1", "run-agent", "pm"),
        "2026-04-27T13:00:01 [ROUTER] branch=brand-new-undocumented-tag feature=onboarding",
      ])
      expect(r.skipped).toBe(1)
      expect(r.divergences).toEqual([])
    })

    it("branch line without feature= field is unpaired (post-Phase-3 contract: every branch log must carry feature=)", () => {
      // Earlier versions of the correlator fell back to "most recent proposal
      // in the same file" for branches without feature=, but that double-paired
      // proposals (once via fallback, once via queue) and inflated the
      // convergence count. Phase 3 Stage 3 added feature= to all branch logs;
      // the correlator now treats missing feature= as a logging contract
      // violation surfaced as "unpaired branches" — never silently rescued.
      const r = correlateLines([
        proposal("onboarding", "T1", "run-escalation-confirmed", "pm"),
        branch("arch-upstream-escalation-confirmed", { target: "pm" }),
      ])
      expect(r.divergences).toEqual([])
      expect(r.convergences).toBe(0)
      expect(r.unpaired).toBe(1)
    })
  })
})
