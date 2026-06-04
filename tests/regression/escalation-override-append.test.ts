import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * B33 — regression catalog bug #20.
 *
 * Catastrophic Step 2a observations #50/#51: the post-run escalation override
 * at `interfaces/slack/handlers/message.ts` for BOTH the designer and architect
 * agents REPLACED the agent's substantive prose with a structured CTA. The
 * architect's gap analysis (e.g. "Good to have you back. I found 40 gaps across
 * the spec chain...") was silently discarded; user saw only the CTA. After
 * stale-state TTL eviction this produced a loop UX — same CTA appeared twice
 * with no acknowledgment of the prior "yes".
 *
 * Fix: change both override sites from REPLACE to APPEND with a markdown
 * horizontal rule separator. Substantive content preserved; platform CTA still
 * surfaces alongside.
 *
 * Behavioral assertions live in tests/integration/workflows.test.ts (N23, N24,
 * N88) — they drive `handleFeatureChannelMessage` and inspect the rendered
 * output. This regression file pins the STRUCTURAL invariant: both override
 * sites in the source file use APPEND semantics, not REPLACE.
 */

describe("bug #20 — B33 escalation override appends agent prose instead of replacing it", () => {
  const HANDLER_PATH = resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts")
  const source = readFileSync(HANDLER_PATH, "utf8")

  it("designer override site (around line 2680) constructs finalResponse via APPEND, not REPLACE", () => {
    // The B33 fix builds the appended response with `${response}\n\n---\n\n${ctaBlock}`.
    // The structural marker is the `response.trim().length > 0` empty-prose guard
    // paired with the APPEND assignment.
    expect(source).toMatch(/finalResponse\s*=\s*response\.trim\(\)\.length\s*>\s*0[\s\S]{0,200}\$\{response\}\\n\\n---\\n\\n/)
  })

  it("architect override site (around line 3387) constructs finalArchResponse via APPEND, not REPLACE", () => {
    expect(source).toMatch(/finalArchResponse\s*=\s*response\.trim\(\)\.length\s*>\s*0[\s\S]{0,200}\$\{response\}\\n\\n---\\n\\n/)
  })

  it("both sites log the APPEND outcome with the new marker text (not the old 'override applied')", () => {
    // Designer log line:
    expect(source).toMatch(/\[ESCALATION\] Override APPENDED for/)
    // Architect log line:
    expect(source).toMatch(/\[ESCALATION\] architect assertive override APPENDED for/)
    // No code path should still log the legacy "Override applied" wording — that
    // verb implies replacement. Allow it only inside comments (still informative
    // history-wise) but not in console.log strings.
    const replacedLogLines = source.match(/console\.log\([^)]*Override applied[^)]*\)/g) ?? []
    expect(replacedLogLines, "no console.log should use the legacy 'Override applied' wording").toEqual([])
  })

  it("DESIGN-REVIEWED comment at each override site cites B33 and #50", () => {
    // Pre-commit hook enforces DESIGN-REVIEWED on routing/handler changes per Principle 12.
    // We pin both sites carry it.
    const designReviewedB33 = source.match(/DESIGN-REVIEWED:\s*B33/g) ?? []
    expect(designReviewedB33.length).toBeGreaterThanOrEqual(2)
    // Each one should reference observation #50 (the catastrophic UX trigger).
    const designReviewedWithFifty = source.match(/DESIGN-REVIEWED:\s*B33[^\n]*#50/g) ?? []
    expect(designReviewedWithFifty.length).toBeGreaterThanOrEqual(2)
  })

  it("empty-prose fallback: if agent produces no prose, CTA is shown alone (no leading '---' separator)", () => {
    // The conditional `response.trim().length > 0 ? ${response}\n\n---\n\n${ctaBlock} : ctaBlock`
    // ensures that an empty agent response doesn't produce a dangling separator. The structural
    // marker is the ternary with `ctaBlock` as the false branch.
    expect(source).toMatch(/response\.trim\(\)\.length\s*>\s*0[\s\S]{0,200}:\s*ctaBlock/g)
  })
})
