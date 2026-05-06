import { describe, it, expect } from "vitest"
import {
  extractAcMap,
  findAcReferences,
  extractQuotedPhrasesNear,
  extractTimingValues,
  verifyAcReferences,
  formatHallucinations,
} from "../../runtime/spec-content-verifier"

/**
 * B11 v1 — unit tests for the deterministic spec-content verifier.
 *
 * Companion regression test (bug #12) at tests/regression/spec-content-hallucination-detection.test.ts
 * covers the canonical Bug-G scenario in narrative form. These unit tests cover
 * the building blocks: parsing, citation detection, quoted-phrase extraction,
 * and the verifier-end-to-end shape.
 */

describe("extractAcMap — parses numbered AC items from a product spec", () => {
  it("extracts a flat list of single-line ACs under the canonical heading", () => {
    const spec = `
# Some Spec

## Acceptance Criteria
1. The user can sign up with email and password.
2. The user receives a confirmation email after sign up.
3. The user can log in.

## Out of Scope
Whatever
`
    const map = extractAcMap(spec)
    expect(map.size).toBe(3)
    expect(map.get(1)).toBe("The user can sign up with email and password.")
    expect(map.get(2)).toBe("The user receives a confirmation email after sign up.")
    expect(map.get(3)).toBe("The user can log in.")
  })

  it("is case-insensitive on the heading", () => {
    const spec = `## ACCEPTANCE CRITERIA\n1. First.\n2. Second.\n`
    const map = extractAcMap(spec)
    expect(map.size).toBe(2)
  })

  it("collapses multi-line AC bodies into a single line", () => {
    const spec = `## Acceptance Criteria
1. The user can sign up
   and the system stores their hashed password.
2. The next AC.
`
    const map = extractAcMap(spec)
    expect(map.get(1)).toBe("The user can sign up and the system stores their hashed password.")
    expect(map.get(2)).toBe("The next AC.")
  })

  it("returns an empty map when the heading is absent", () => {
    const spec = `## Goals\n- something\n## Other\n- thing\n`
    expect(extractAcMap(spec).size).toBe(0)
  })

  it("returns an empty map for empty input", () => {
    expect(extractAcMap("").size).toBe(0)
  })

  it("stops at the next ## heading", () => {
    const spec = `## Acceptance Criteria
1. First.
2. Second.

## Open Questions
1. Should this be a thing?
`
    const map = extractAcMap(spec)
    expect(map.size).toBe(2)
    expect(map.has(1)).toBe(true)
    expect(map.has(2)).toBe(true)
  })
})

describe("findAcReferences — detects AC# citations in agent prose", () => {
  it("finds 'AC N' citations", () => {
    const refs = findAcReferences("The fix requires updating AC 10 to clarify timing.")
    expect(refs).toHaveLength(1)
    expect(refs[0].acNumber).toBe(10)
  })

  it("finds 'AC #N' citations", () => {
    const refs = findAcReferences("Per AC #27, this is a required check.")
    expect(refs).toHaveLength(1)
    expect(refs[0].acNumber).toBe(27)
  })

  it("finds 'AC#N' (no spaces) citations", () => {
    const refs = findAcReferences("AC#5 says otherwise.")
    expect(refs).toHaveLength(1)
    expect(refs[0].acNumber).toBe(5)
  })

  it("is case-insensitive", () => {
    const refs = findAcReferences("ac 3 and Ac 4 and AC 5")
    expect(refs.map(r => r.acNumber)).toEqual([3, 4, 5])
  })

  it("returns empty when no AC citations are present", () => {
    expect(findAcReferences("This response says nothing about acceptance criteria.")).toEqual([])
  })

  it("captures surrounding context for claim extraction", () => {
    const text = "Looking at AC 27, it says 'a clear sign-up call-to-action' which is vague."
    const refs = findAcReferences(text)
    expect(refs).toHaveLength(1)
    expect(refs[0].surroundingText).toContain("a clear sign-up call-to-action")
  })
})

describe("extractQuotedPhrasesNear — extracts quoted claims about AC content", () => {
  it("extracts double-quoted phrases", () => {
    const phrases = extractQuotedPhrasesNear(`AC 10 says "the user must verify their email" before proceeding.`)
    expect(phrases).toContain("the user must verify their email")
  })

  it("extracts single-quoted phrases", () => {
    const phrases = extractQuotedPhrasesNear(`AC 10 says 'verify their email' before proceeding.`)
    expect(phrases).toContain("verify their email")
  })

  it("extracts smart-quoted phrases (left/right)", () => {
    const phrases = extractQuotedPhrasesNear(`AC 10 says “verify their email” before proceeding.`)
    expect(phrases).toContain("verify their email")
  })

  it("ignores too-short quoted strings (< 3 chars)", () => {
    const phrases = extractQuotedPhrasesNear(`The user said "ok" then proceeded.`)
    expect(phrases).toEqual([])
  })

  it("returns empty when there are no quotes", () => {
    expect(extractQuotedPhrasesNear("AC 10 says nothing in particular.")).toEqual([])
  })
})

describe("verifyAcReferences — main entry point", () => {
  const productSpec = `## Acceptance Criteria
1. The user can sign up with email and password.
2. The user receives a confirmation email after sign up.
3. The user can log in with the same credentials they signed up with.
`

  it("returns no hallucinations when the agent doesn't cite any ACs", () => {
    const findings = verifyAcReferences("Looks good, no concerns.", productSpec)
    expect(findings).toEqual([])
  })

  it("returns no hallucinations when the agent cites an AC without quoting wording", () => {
    const findings = verifyAcReferences("AC 1 covers this case.", productSpec)
    expect(findings).toEqual([])
  })

  it("flags an ac-does-not-exist hallucination when AC N is not in the spec", () => {
    const response = `Per AC 27 — "should require email verification" — this needs work.`
    const findings = verifyAcReferences(response, productSpec)
    expect(findings).toHaveLength(1)
    expect(findings[0].citedAcNumber).toBe(27)
    expect(findings[0].reason).toBe("ac-does-not-exist")
    expect(findings[0].actualWording).toBeNull()
    expect(findings[0].claimedWording).toContain("should require email verification")
  })

  it("flags a claimed-wording-not-in-ac hallucination when the quoted phrase isn't in the cited AC", () => {
    const response = `Per AC 1 — "the user must verify their email before proceeding" — this is the rule.`
    const findings = verifyAcReferences(response, productSpec)
    expect(findings).toHaveLength(1)
    expect(findings[0].citedAcNumber).toBe(1)
    expect(findings[0].reason).toBe("claimed-wording-not-in-ac")
    expect(findings[0].claimedWording).toContain("the user must verify their email")
    expect(findings[0].actualWording).toContain("sign up with email and password")
  })

  it("does NOT flag a quoted phrase that actually appears in the cited AC", () => {
    const response = `AC 1 says "sign up with email and password" — this is what we have.`
    const findings = verifyAcReferences(response, productSpec)
    expect(findings).toEqual([])
  })

  it("matches phrases case-insensitively and tolerates whitespace differences", () => {
    const response = `AC 1 says "SIGN UP WITH   EMAIL AND PASSWORD".`
    const findings = verifyAcReferences(response, productSpec)
    expect(findings).toEqual([])
  })

  it("ignores very short quoted phrases (< 8 chars) to avoid false positives", () => {
    const response = `AC 1 says "user".`
    const findings = verifyAcReferences(response, productSpec)
    expect(findings).toEqual([])
  })

  it("Bug-G canonical scenario: PM cites AC 27 in escalation-resume but spec has only 25 ACs", () => {
    const spec25 = `## Acceptance Criteria
${Array.from({ length: 25 }, (_, i) => `${i + 1}. AC body number ${i + 1}.`).join("\n")}
`
    const response = `Looking at AC 27 — "a clear sign-up call-to-action" — this is the gap I'd close.`
    const findings = verifyAcReferences(response, spec25)
    expect(findings).toHaveLength(1)
    expect(findings[0].citedAcNumber).toBe(27)
    expect(findings[0].reason).toBe("ac-does-not-exist")
  })
})

describe("extractTimingValues — B21 inference-style numeric extraction", () => {
  it("extracts millisecond values normalized to ms", () => {
    const values = extractTimingValues("indicator disappears within 200ms after expiry")
    expect(values.map(v => v.ms)).toEqual([200])
    expect(values[0].raw.toLowerCase()).toContain("200ms")
  })

  it("extracts second values normalized to ms (1s = 1000)", () => {
    const values = extractTimingValues("warning appears within 1 second of receipt")
    expect(values.map(v => v.ms)).toEqual([1000])
  })

  it("extracts minute values normalized to ms (60 minutes = 3_600_000)", () => {
    const values = extractTimingValues("session expires after 60 minutes of inactivity")
    expect(values.map(v => v.ms)).toEqual([3_600_000])
  })

  it("extracts hour values normalized to ms (1 hour = 3_600_000)", () => {
    const values = extractTimingValues("token TTL is 1 hour by default")
    expect(values.map(v => v.ms)).toEqual([3_600_000])
  })

  it("dedupes identical raw+normalized values", () => {
    const values = extractTimingValues("200ms and 200ms again")
    expect(values).toHaveLength(1)
  })

  it("returns empty for text with no timings", () => {
    expect(extractTimingValues("no timings in this prose")).toEqual([])
  })
})

describe("verifyAcReferences — B21 inference-style citations (catastrophic #13/#14)", () => {
  // Spec where ACs use "1 second" — agent that claims "200ms matches AC 4 and AC 27"
  // is fabricating; both ACs would have to contain a 200ms timing for the citation to be valid.
  const specWithSecondTimings = `## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation.
3. The user can log in.
4. The system applies the new policy within 1 second of receipt.
5. Some other AC.
27. A subsequent guarantee fires within 1 second of access-token expiry detection.
`

  it("Bug-G canonical inference scenario: '200ms matches AC 4 and AC 27' but both ACs say '1 second'", () => {
    const response = `My recommendation: 200ms threshold. This matches the threshold used in AC 4 and AC 27.`
    const findings = verifyAcReferences(response, specWithSecondTimings)
    // Two findings — one per cited AC where the inference fails
    expect(findings.filter(f => f.reason === "inference-claim-not-in-ac")).toHaveLength(2)
    expect(findings.find(f => f.citedAcNumber === 4)?.reason).toBe("inference-claim-not-in-ac")
    expect(findings.find(f => f.citedAcNumber === 27)?.reason).toBe("inference-claim-not-in-ac")
    expect(findings.find(f => f.citedAcNumber === 4)?.claimedWording.toLowerCase()).toContain("200ms")
  })

  it("does NOT flag when the cited AC actually contains the claimed timing", () => {
    const spec = `## Acceptance Criteria
1. The user signs up.
2. The system propagates the change within 200ms of confirmation.
`
    const response = `My recommendation: 200ms is consistent with AC 2 which already uses 200ms.`
    const findings = verifyAcReferences(response, spec)
    expect(findings.filter(f => f.reason === "inference-claim-not-in-ac")).toEqual([])
  })

  it("does NOT flag when no timing values appear near the AC citation", () => {
    const response = `AC 4 covers the policy update behavior. No specific timing claim here.`
    const findings = verifyAcReferences(response, specWithSecondTimings)
    expect(findings.filter(f => f.reason === "inference-claim-not-in-ac")).toEqual([])
  })

  it("respects the tight ±80 char inference window — distant timings don't fire", () => {
    // Timing value sits >80 chars away from the AC citation; should not be claimed-of-AC.
    const padding = "x".repeat(120)
    const response = `Recommendation 200ms. ${padding} AC 4 also covers some unrelated concern.`
    const findings = verifyAcReferences(response, specWithSecondTimings)
    expect(findings.filter(f => f.reason === "inference-claim-not-in-ac")).toEqual([])
  })

  it("normalizes units — '1 second' in AC matches '1000ms' in claim", () => {
    const response = `Recommendation: 1000ms is consistent with the threshold in AC 4.`
    const findings = verifyAcReferences(response, specWithSecondTimings)
    expect(findings.filter(f => f.reason === "inference-claim-not-in-ac")).toEqual([])
  })

  it("determinism per Principle 11 — same input ⇒ same findings, three times", () => {
    const response = `200ms matches AC 4 and AC 27.`
    const a = verifyAcReferences(response, specWithSecondTimings)
    const b = verifyAcReferences(response, specWithSecondTimings)
    const c = verifyAcReferences(response, specWithSecondTimings)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})

describe("formatHallucinations — diagnostic string", () => {
  it("formats ac-does-not-exist findings", () => {
    const out = formatHallucinations([
      {
        citedAcNumber: 27,
        claimedWording: "a clear call-to-action",
        actualWording: null,
        reason: "ac-does-not-exist",
      },
    ])
    expect(out).toContain("AC 27 does NOT exist")
    expect(out).toContain("a clear call-to-action")
  })

  it("formats claimed-wording-not-in-ac findings with both claimed and actual", () => {
    const out = formatHallucinations([
      {
        citedAcNumber: 1,
        claimedWording: "verify their email",
        actualWording: "The user can sign up with email and password.",
        reason: "claimed-wording-not-in-ac",
      },
    ])
    expect(out).toContain("AC 1 does NOT contain")
    expect(out).toContain("verify their email")
    expect(out).toContain("sign up with email and password")
  })

  it("returns empty string for empty input", () => {
    expect(formatHallucinations([])).toBe("")
  })
})
