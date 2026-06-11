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

describe("bug #18 — B21 inference-style citation BLOCKING in PM spec writeback (catastrophic Step 2a #13/#14)", () => {
  it("canonical scenario: PM recommends '200ms matches AC 4 and AC 27' but both ACs use '1 second' — flagged inference-claim-not-in-ac", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")

    const productSpec = `## Acceptance Criteria
1. The user signs up.
2. The user receives confirmation.
3. The user logs in.
4. The system applies the new policy within 1 second of receipt.
5. Some other AC.
6. Another AC.
27. A subsequent guarantee fires within 1 second of access-token expiry detection on the client.
`

    const pmRecommendation = `My recommendation is to set the threshold at 200ms. This matches the threshold used in AC 4 and AC 27 — both already use a tight client-side guarantee.`

    const findings = verifyAcReferences(pmRecommendation, productSpec)
    const inferenceFindings = findings.filter(f => f.reason === "inference-claim-not-in-ac")
    expect(inferenceFindings.length).toBeGreaterThanOrEqual(2)
    expect(inferenceFindings.find(f => f.citedAcNumber === 4)).toBeDefined()
    expect(inferenceFindings.find(f => f.citedAcNumber === 27)).toBeDefined()
  })

  it("structural assertion: verifier is wired as BLOCKING in pm-escalation-spec-writer (returns null when hallucinations present)", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"),
      "utf8",
    )

    // Verifier must be imported into the writer.
    expect(source).toMatch(/from\s+["']\.\/spec-content-verifier["']/)
    expect(source).toMatch(/verifyAcReferences\s*\(/)

    // BLOCKING contract: a [CONTENT-VERIFIER] BLOCKING log line and an early `return null`
    // must appear when hallucinations are detected — NOT just a log line.
    expect(source).toMatch(/\[CONTENT-VERIFIER\]\s+BLOCKING/)

    // The writer must call the verifier BEFORE the Haiku merge in
    // patchProductSpecWithRecommendations. Anchor: verifyAcReferences must
    // appear above the merge-call inside the export. We anchor by source
    // position relative to the function entry rather than indexOf("client.messages.create"),
    // since stripVisualDetailsFromSpec (declared earlier in file scope) also
    // calls client.messages.create.
    const fnEntryIdx = source.indexOf("export async function patchProductSpecWithRecommendations")
    expect(fnEntryIdx).toBeGreaterThan(0)
    const verifierIdx = source.indexOf("verifyAcReferences(", fnEntryIdx)
    expect(verifierIdx).toBeGreaterThan(fnEntryIdx)
    // The Haiku merge call inside the function must appear AFTER the verifier call.
    const haikuMergeIdx = source.indexOf("client.messages.create", verifierIdx)
    expect(haikuMergeIdx).toBeGreaterThan(verifierIdx)
  })
})

describe("bug #22 — B29 verifier precision tightening (catastrophic Step 2a MT-33 false-positives)", () => {
  // Step 2a MT-33 produced 4 catastrophic false-positives that BLOCKED a faithful
  // PM recommendation. The B11 v1 algorithm at that point was: extract every quoted
  // phrase in the ±200 char window around an AC citation, flag any phrase not in
  // the cited AC's body. Bug class: regex over-extracted spans between two
  // apostrophes that were actually contractions; and extracted quoted phrases
  // that legitimately quoted OTHER ACs' bodies (within the same ±200 char window).
  //
  // B29 fix: three-part precision tightening: (a) raise min-length from 8 to 16
  // chars; (b) skip phrases that look like prose fragments (contraction-suffix
  // start, 1st/2nd-person pronouns); (c) skip phrases that appear in ANOTHER
  // AC's body (wrong-attribution, not fabrication).
  //
  // These regression tests use the EXACT phrases from the MT-33 log lines to
  // pin "BLOCKING is safe to keep on at the writeback boundary."

  // Canonical product spec from the onboarding feature where MT-33 was driven.
  // Contains AC 4 / AC 27 / AC 21 with "within 1 second" timings — the substrate
  // for the architect's hallucinated "200ms matches AC 4 and AC 27" brief.
  const ONBOARDING_PRODUCT_SPEC = `## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation.
3. The user can log in.
4. The logged-out indicator disappears within 1 second of valid authentication token receipt, before conversation history loads.
21. If authentication state resolution succeeds during initial load, the logged-out indicator disappears within 1 second of valid token receipt and conversation history becomes visible once loaded.
27. If a user's authentication token expires mid-session, the "Not signed in" indicator reappears within 1 second of access token expiry detection on the client and all chat functionality becomes read-only.
`

  it("MT-33 FP #1 — short phrase 'immediately' (10 chars) extracted from PM prose: NO LONGER flagged (part-a length floor)", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    const pmResponse = `Looking at the spec, "immediately" appears in two places. **AC 4** — "The logged-out indicator disappears within 1 second of valid authentication token receipt" — this one is already numeric.`
    const findings = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    const flagForImmediately = findings.find(f => f.claimedWording.toLowerCase().includes("immediately"))
    expect(flagForImmediately).toBeUndefined()
  })

  it("MT-33 FP #2 — prose fragment 're meaningfully different situations. I' extracted between two contraction apostrophes: NO LONGER flagged (part-b prose-fragment + pronoun)", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    // Regex extracts the span between 'they’re' and 'I’ll', yielding a 39-char prose fragment.
    // Note: using actual apostrophe characters as they would appear in PM's prose.
    const pmResponse = `**AC 4** — they're meaningfully different situations. I'll address each. The logged-out indicator disappears within 1 second.`
    const findings = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    const flagForFragment = findings.find(f => /meaningfully different/.test(f.claimedWording))
    expect(flagForFragment).toBeUndefined()
  })

  it("MT-33 FP #3 — full AC 4 body quoted near AC 27 citation: NO LONGER flagged (part-c intra-spec dedup)", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    // The architect/PM quotes AC 4's text near an AC 27 citation; the ±200 char window
    // attributes the AC 4 quote to AC 27. The phrase IS real spec content — just attributed
    // to the wrong AC. Part-c intra-spec dedup catches this.
    const pmResponse = `AC 27 covers token expiry. For context, "The logged-out indicator disappears within 1 second of valid authentication token receipt" is the AC 4 case.`
    const findings = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    const flagForAttribution = findings.find(f => f.citedAcNumber === 27 && f.claimedWording.includes("logged-out indicator"))
    expect(flagForAttribution).toBeUndefined()
  })

  it("MT-33 FP #4 — same as #1, second instance: NO LONGER flagged (part-a length floor)", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    // AC 21 cited near 'immediately' quote — same length-floor case.
    const pmResponse = `**AC 21** — "immediately" — needs to be addressed.`
    const findings = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    const flagForImmediately = findings.find(f => f.citedAcNumber === 21 && f.claimedWording.toLowerCase().includes("immediately"))
    expect(flagForImmediately).toBeUndefined()
  })

  it("B29 part-a positive control — phrase exactly 15 chars (one under floor) is NOT flagged", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    const productSpec = `## Acceptance Criteria
1. AC body number one.
`
    const pmResponse = `AC 1 contains "fifteen chars X" which is borderline.` // 15-char phrase
    const findings = verifyAcReferences(pmResponse, productSpec)
    const flag = findings.find(f => f.reason === "claimed-wording-not-in-ac")
    expect(flag).toBeUndefined()
  })

  it("B29 part-a positive control — phrase 16+ chars IS flagged when not in AC and passes other filters", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    const productSpec = `## Acceptance Criteria
1. The user can sign up with email and password.
`
    // 33-char phrase, contains no contraction-start, no pronouns, not in any other AC.
    const pmResponse = `Per AC 1 — "two-factor authentication via SMS" — that needs work.`
    const findings = verifyAcReferences(pmResponse, productSpec)
    const flag = findings.find(f => f.reason === "claimed-wording-not-in-ac" && f.claimedWording.includes("two-factor"))
    expect(flag).toBeDefined()
  })

  it("B29 part-b positive control — phrase with 1st-person pronoun 'I' is NOT flagged", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    const productSpec = `## Acceptance Criteria
1. The user can sign up.
`
    const pmResponse = `AC 1 — "I think this should require something more substantial" — needs work.`
    const findings = verifyAcReferences(pmResponse, productSpec)
    const flag = findings.find(f => f.reason === "claimed-wording-not-in-ac")
    expect(flag).toBeUndefined()
  })

  it("B29 part-c positive control — phrase in another AC's body is NOT flagged when attributed to wrong AC", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    const productSpec = `## Acceptance Criteria
1. The user can sign up with two-factor authentication via SMS.
2. The user receives an email confirmation.
`
    // PM cites AC 2 but quotes AC 1's content. The phrase IS real spec content; just attributed to the wrong AC.
    const pmResponse = `AC 2 — "two-factor authentication via SMS" — should be addressed.`
    const findings = verifyAcReferences(pmResponse, productSpec)
    const flag = findings.find(f => f.reason === "claimed-wording-not-in-ac" && f.citedAcNumber === 2)
    expect(flag).toBeUndefined()
  })

  it("B29 determinism — same input ⇒ same findings across three runs (Principle 11)", async () => {
    const { verifyAcReferences } = await import("../../runtime/spec-content-verifier")
    const pmResponse = `Looking at the spec, "immediately" appears in two places. **AC 4** — they're meaningfully different. I'll address each.`
    const a = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    const b = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    const c = verifyAcReferences(pmResponse, ONBOARDING_PRODUCT_SPEC)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})

describe("bug #23 — B28 BLOCKING writeback produces a user-facing message (catastrophic Step 2a #32)", () => {
  it("B28 buildBlockedWritebackMessage — contains platform prefix, role, finding count, formatted findings, and re-author CTA", async () => {
    const { buildBlockedWritebackMessage } = await import("../../runtime/spec-content-verifier")
    const hallucinations = [
      { citedAcNumber: 4, claimedWording: "fake claim about AC 4", actualWording: "real AC 4 text", reason: "claimed-wording-not-in-ac" as const },
    ]
    const msg = buildBlockedWritebackMessage(hallucinations, "PM")
    expect(msg).toContain("*Platform —*")
    expect(msg).toContain("PM's recommendation")
    expect(msg).toContain("1 citation issue")  // singular wording
    expect(msg).toContain("AC 4")
    expect(msg).toContain("Reply with a revised recommendation")
    expect(msg).toContain("spec on main is unchanged")
  })

  it("B28 buildBlockedWritebackMessage — pluralizes 'issues' for N > 1, lists each finding", async () => {
    const { buildBlockedWritebackMessage } = await import("../../runtime/spec-content-verifier")
    const hallucinations = [
      { citedAcNumber: 4, claimedWording: "first fake", actualWording: "real 4", reason: "claimed-wording-not-in-ac" as const },
      { citedAcNumber: 7, claimedWording: "second fake", actualWording: "real 7", reason: "claimed-wording-not-in-ac" as const },
    ]
    const msg = buildBlockedWritebackMessage(hallucinations, "Architect")
    expect(msg).toContain("Architect's recommendation")
    expect(msg).toContain("2 citation issues")
    expect(msg).toContain("AC 4")
    expect(msg).toContain("AC 7")
  })

  it("B28 structural — pm-escalation-spec-writer returns { blocked, hallucinations } on hallucination, not null", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "runtime/pm-escalation-spec-writer.ts"),
      "utf8",
    )
    // Type exported
    expect(source).toMatch(/export type ProductSpecWritebackBlocked\b/)
    // BLOCKING path returns { blocked: true, hallucinations }
    expect(source).toMatch(/return\s+\{\s*blocked:\s*true\s*,\s*hallucinations\s*\}/)
  })

  it("B28 structural — message.ts wires buildBlockedWritebackMessage at BOTH writeback call sites (Principle 15)", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "interfaces/slack/handlers/message.ts"),
      "utf8",
    )
    expect(source).toMatch(/import\s+\{[^}]*buildBlockedWritebackMessage[^}]*\}\s+from\s+["'][^"']*spec-content-verifier/)
    // Both call sites must post the BLOCKED message.
    const builderCalls = source.match(/buildBlockedWritebackMessage\(/g) ?? []
    expect(builderCalls.length).toBeGreaterThanOrEqual(2)
    // Both must include a DESIGN-REVIEWED comment referencing B28.
    const designReviewedB28 = source.match(/DESIGN-REVIEWED:\s*B28/g) ?? []
    expect(designReviewedB28.length).toBeGreaterThanOrEqual(2)
  })
})
