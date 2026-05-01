import { describe, it, expect } from "vitest"
import {
  READONLY_AGENT_BRIEF_CLAUSE,
  READONLY_BRIEF_MARKER,
} from "../../runtime/readonly-brief-clause"

// Regression test for B7 (PM/Designer briefs must declare readOnly to the
// agent). Bug surfaced 2026-04-30: PM in escalation-confirmed mode is
// invoked with `readOnly: true` (no spec-writing tools) but the brief told
// PM to "give recommendations" without naming the readOnly contract. PM
// produced prose like "Applying the patch to AC 10 now" — claiming a tool
// call it cannot make — which contradicted the platform's truthful "say *yes*
// to apply" message that posted right after. Same prose-vs-state mismatch
// class as Block N2 but at the brief-prompt layer.
//
// Fix: shared constant runtime/readonly-brief-clause.ts injected into all 4
// readOnly briefs in interfaces/slack/handlers/message.ts (designer→PM,
// designer→architect, architect→PM, architect→design). Structural invariant
// at tests/invariants/readonly-brief-clause.test.ts pins both halves of the
// contract: the constant exists with the right semantics, and every brief
// site interpolates it. Per Principle 15 (cross-agent parity).

describe("bug #15 — readOnly briefs must declare the no-spec-writing-tools contract (manifest B7)", () => {
  it("structural assertion: shared READONLY_AGENT_BRIEF_CLAUSE constant exists and is non-trivial", () => {
    expect(READONLY_AGENT_BRIEF_CLAUSE.length).toBeGreaterThan(100)
    expect(READONLY_AGENT_BRIEF_CLAUSE).toContain(READONLY_BRIEF_MARKER)
  })

  it("the clause names the canonical action-claim phrasings the agent must avoid (the actual Bug-C phrases)", () => {
    // These are the exact phrases the PM produced when running in readOnly
    // mode without the clause. The clause itself names them as DON'T cases
    // so the agent has explicit instruction.
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/Applying the patch/i)
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/I'll update the (product|design|engineering)? ?spec/i)
  })

  it("the clause names the resolution: human says yes, then platform applies", () => {
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/after the human says yes/i)
    expect(READONLY_AGENT_BRIEF_CLAUSE).toMatch(/recommend.*platform applies/i)
  })

  it("structural assertion: every readOnly brief in message.ts interpolates the shared constant (cross-agent parity per Principle 15)", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    // The shared constant must be imported from the canonical module.
    expect(source).toMatch(/import\s+\{\s*READONLY_AGENT_BRIEF_CLAUSE\s*\}\s+from\s+["']\.\.\/\.\.\/\.\.\/runtime\/readonly-brief-clause["']/)

    // Each of the four production briefs interpolates the constant.
    const briefHeadings = [
      "DESIGN TEAM ESCALATION — PM RECOMMENDATIONS NEEDED",
      "DESIGN TEAM ESCALATION — ARCHITECT RECOMMENDATIONS NEEDED",
      "ARCHITECT ESCALATION — Design revision needed",
      "ARCHITECT ESCALATION — PM decision needed",
    ]
    for (const heading of briefHeadings) {
      const idx = source.indexOf(heading)
      expect(idx, `expected brief heading '${heading}' to be present in message.ts`).toBeGreaterThan(-1)
      const body = source.slice(idx, idx + 2000)
      expect(
        body,
        `[B7 / Principle 15] brief '${heading}' must interpolate \${READONLY_AGENT_BRIEF_CLAUSE}; missing means the agent doesn't know it's in readOnly mode and may produce action-claim prose ('Applying the patch...') that contradicts the platform's follow-up message`,
      ).toMatch(/\$\{READONLY_AGENT_BRIEF_CLAUSE\}/)
    }
  })

  it("structural assertion: CLAUDE.md Principle 8 (platform enforcement first) is the governing principle for this fix", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const claudeMd = fs.readFileSync(path.resolve(__dirname, "..", "..", "CLAUDE.md"), "utf8")
    // The fix is a brief-prompt change, which is "prompt-dependent" by
    // Principle 8's strict definition — so we structurally pin the
    // PRESENCE of the clause via the invariant test (a structural gate),
    // making the prompt rule load-bearing-with-structural-backstop. This
    // assertion just pins the principle exists; the structural backstop
    // is in tests/invariants/readonly-brief-clause.test.ts.
    expect(claudeMd).toMatch(/### 8\. Platform enforcement first/)
  })
})
