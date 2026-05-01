import { describe, it, expect } from "vitest"
import {
  extractAcMap,
  findAcReferences,
  extractQuotedPhrasesNear,
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
