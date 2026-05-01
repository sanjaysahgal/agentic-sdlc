import { describe, it, expect } from "vitest"
import {
  verifyAcReferences,
  formatHallucinations,
  extractAcMap,
} from "../../runtime/spec-content-verifier"

// Regression test for B11 v1 (was Bug G): PM agent in escalation-resume mode
// hallucinated AC numbers — cited "AC 27" when the product spec only has 25
// ACs. Without a deterministic content verifier, the wrong AC number flowed
// straight into the spec patcher and corrupted the spec; the user was the
// only line of defense, which violates Principle 7 (zero human errors of
// omission).
//
// Fix: pure deterministic verifier (`runtime/spec-content-verifier.ts`) wired
// log-only into the PM escalation-resume response site at
// `interfaces/slack/handlers/message.ts`. v1 is detection + log; v2 will
// add a re-prompt loop and downstream patcher gating. Detection alone is
// enough to (a) stop silent corruption (operator can intervene on log
// signal) and (b) provide the regression bedrock for v2.

describe("bug #12 — PM citing nonexistent AC numbers in escalation-resume mode (manifest B11, was Bug G)", () => {
  it("detects the canonical Bug-G scenario: PM cites AC 27 when spec has only 25 ACs", () => {
    const productSpec = `# Onboarding Product Spec

## Goal
Sign-up flow for new users.

## Acceptance Criteria
${Array.from({ length: 25 }, (_, i) => `${i + 1}. AC body number ${i + 1} describing the requirement.`).join("\n")}

## Out of Scope
Anything else.
`
    const pmResponse =
      `My recommendation: tighten AC 27 — "a clear sign-up call-to-action" is too vague. ` +
      `I'd replace it with "a button labeled 'Create account' rendered above the fold on first visit."`

    const findings = verifyAcReferences(pmResponse, productSpec)
    expect(findings).toHaveLength(1)
    expect(findings[0].citedAcNumber).toBe(27)
    expect(findings[0].reason).toBe("ac-does-not-exist")
    expect(findings[0].claimedWording).toContain("a clear sign-up call-to-action")

    const formatted = formatHallucinations(findings)
    expect(formatted).toContain("AC 27 does NOT exist")
  })

  it("detects wording-mismatch hallucination: PM cites AC 5 with phrasing not in AC 5", () => {
    // Subtle hallucination: AC exists, but the agent claims it says something it doesn't.
    // This is the higher-frequency failure mode — the AC number is real, so a quick scan
    // by the user passes; the wording lie sneaks through.
    const productSpec = `## Acceptance Criteria
1. The user can sign up.
2. Email confirmation is required.
3. Login uses email and password.
4. Sessions expire after 24 hours.
5. The user can request a password reset link via email.
`
    const pmResponse = `My read on AC 5 — "two-factor authentication via SMS" — that needs to be sharpened.`
    const findings = verifyAcReferences(pmResponse, productSpec)
    expect(findings).toHaveLength(1)
    expect(findings[0].citedAcNumber).toBe(5)
    expect(findings[0].reason).toBe("claimed-wording-not-in-ac")
    expect(findings[0].claimedWording).toContain("two-factor authentication")
    expect(findings[0].actualWording).toContain("password reset link")
  })

  it("does NOT flag a faithful PM response where the cited AC and quoted wording are real", () => {
    // Negative case: same shape as the bug (PM response with AC# citation + quoted wording),
    // but everything checks out. Verifier must produce zero findings.
    const productSpec = `## Acceptance Criteria
1. The user can sign up with email and password.
2. The user receives a confirmation email after sign up.
`
    const pmResponse =
      `My recommendation on AC 1 — "sign up with email and password" — is to clarify ` +
      `the required password complexity.`
    const findings = verifyAcReferences(pmResponse, productSpec)
    expect(findings).toEqual([])
  })

  it("structural assertion: extractAcMap is the deterministic ground truth (no LLM in the verifier path)", async () => {
    // Per Principle 11 (all audits must be deterministic), the verifier
    // must be a pure function — same input always returns the same output,
    // no LLM call, no I/O. Run the same input twice and assert identical
    // outputs (object-equal).
    const productSpec = `## Acceptance Criteria
1. First.
2. Second.
3. Third.
`
    const map1 = extractAcMap(productSpec)
    const map2 = extractAcMap(productSpec)
    expect(map1.size).toBe(map2.size)
    for (const [k, v] of map1) expect(map2.get(k)).toBe(v)

    const pmResponse = `Per AC 99 — "wrong text" — ...`
    const f1 = verifyAcReferences(pmResponse, productSpec)
    const f2 = verifyAcReferences(pmResponse, productSpec)
    expect(f1).toEqual(f2)
  })

  it("structural assertion: the verifier is wired into the PM escalation-resume response site", async () => {
    // Per Principle 7 (zero human errors of omission), the verifier must
    // actually be called from the path that exhibited Bug G. The PM
    // escalation-resume site lives in `interfaces/slack/handlers/message.ts`
    // — specifically the `arch-upstream-escalation-confirmed` branch where
    // PM is invoked via `runPmAgent` with `readOnly: true`. v1 wiring is
    // log-only: detect and emit a `[CONTENT-VERIFIER]` log line.
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )

    // The verifier must be imported.
    expect(source).toMatch(/from\s+["'](?:\.\.\/){2,}runtime\/spec-content-verifier["']/)

    // The verifier function must be called.
    expect(source).toMatch(/verifyAcReferences\s*\(/)

    // A `[CONTENT-VERIFIER]` log line must be present (the v1 contract is log-only).
    expect(source).toMatch(/\[CONTENT-VERIFIER\]/)
  })
})
