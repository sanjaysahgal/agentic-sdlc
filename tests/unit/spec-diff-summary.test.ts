import { describe, it, expect } from "vitest"
import { summarizeAcDiff } from "../../runtime/spec-diff-summary"

/**
 * B24 — unit tests for the deterministic AC-level diff summary.
 *
 * Companion regression for catastrophic Step 2a observation #29 lives in
 * tests/regression/spec-diff-summary.test.ts (bug #19); these tests cover the
 * primitive summarizeAcDiff in isolation.
 */

describe("summarizeAcDiff — pure deterministic AC-level diff", () => {
  const SPEC_3 = `## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation.
3. The user can log in.
`

  it("returns 'no changes' brief when before === after", () => {
    const out = summarizeAcDiff(SPEC_3, SPEC_3)
    expect(out.addedAcs).toEqual([])
    expect(out.modifiedAcs).toEqual([])
    expect(out.removedAcs).toEqual([])
    expect(out.brief).toBe("No AC changes detected.")
  })

  it("flags a modified AC when its body changes", () => {
    const after = `## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation within 1 second of sign up.
3. The user can log in.
`
    const out = summarizeAcDiff(SPEC_3, after)
    expect(out.modifiedAcs).toEqual([2])
    expect(out.addedAcs).toEqual([])
    expect(out.removedAcs).toEqual([])
    expect(out.brief).toContain("Modified AC 2")
  })

  it("flags an added AC when after has a number not in before", () => {
    const after = `## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation.
3. The user can log in.
4. The user can reset their password.
`
    const out = summarizeAcDiff(SPEC_3, after)
    expect(out.addedAcs).toEqual([4])
    expect(out.modifiedAcs).toEqual([])
    expect(out.brief).toContain("added AC 4")
  })

  it("flags a removed AC when before has a number not in after", () => {
    const after = `## Acceptance Criteria
1. The user can sign up.
3. The user can log in.
`
    const out = summarizeAcDiff(SPEC_3, after)
    expect(out.removedAcs).toEqual([2])
    expect(out.brief).toContain("removed AC 2")
  })

  it("ignores cosmetic whitespace and case differences (no false-positive modification)", () => {
    const after = `## Acceptance Criteria
1.    The user can sign up.
2. THE USER RECEIVES CONFIRMATION.
3. The user can log in.
`
    const out = summarizeAcDiff(SPEC_3, after)
    expect(out.modifiedAcs).toEqual([])
    expect(out.brief).toBe("No AC changes detected.")
  })

  it("composes a multi-part brief when multiple change classes occur", () => {
    const after = `## Acceptance Criteria
1. The user can sign up.
2. The user receives confirmation within 200ms.
4. The user can reset their password.
`
    const out = summarizeAcDiff(SPEC_3, after)
    expect(out.modifiedAcs).toEqual([2])
    expect(out.addedAcs).toEqual([4])
    expect(out.removedAcs).toEqual([3])
    expect(out.brief).toContain("Modified AC 2")
    expect(out.brief).toContain("added AC 4")
    expect(out.brief).toContain("removed AC 3")
  })

  it("formats lists of multiple ACs as 'ACs N, M, K'", () => {
    const before = `## Acceptance Criteria
1. AC one.
2. AC two.
3. AC three.
`
    const after = `## Acceptance Criteria
1. AC one is now changed.
2. AC two changed too.
3. AC three changed.
`
    const out = summarizeAcDiff(before, after)
    expect(out.modifiedAcs).toEqual([1, 2, 3])
    expect(out.brief).toContain("Modified ACs 1, 2, 3")
  })

  it("determinism per Principle 11 — same input ⇒ same brief, three times", () => {
    const after = `## Acceptance Criteria
1. The user can sign up via SSO.
2. The user receives confirmation.
3. The user can log in.
4. The user can reset their password.
`
    const a = summarizeAcDiff(SPEC_3, after)
    const b = summarizeAcDiff(SPEC_3, after)
    const c = summarizeAcDiff(SPEC_3, after)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it("handles empty before-spec (no extracted ACs) — every after-AC is 'added'", () => {
    const empty = `# Some Spec\nNo AC section yet.\n`
    const out = summarizeAcDiff(empty, SPEC_3)
    expect(out.addedAcs).toEqual([1, 2, 3])
    expect(out.modifiedAcs).toEqual([])
    expect(out.removedAcs).toEqual([])
    expect(out.brief).toContain("added ACs 1, 2, 3")
  })

  it("canonical Step 2a #29 scenario — multi-AC corruption surfaces in the brief instead of vague 'partially updated'", () => {
    // Pre-writeback: 6 ACs with timing thresholds.
    const before = `## Acceptance Criteria
1. The system applies the policy within 1 second of receipt.
2. Users sign up within 30 seconds.
3. Sessions expire after 60 minutes.
4. Warning appears 10 minutes before timeout.
5. Indicator disappears within 1 second of token receipt.
6. Validation completes within 200ms.
`
    // Post-writeback (the catastrophic strip-pass corruption case):
    // PM was supposed to fix AC 4 (replace "10 minutes" with concrete value) but
    // instead the strip-pass removed timing thresholds across ACs 1-3, 5, 6 and
    // left AC 4 unchanged.
    const after = `## Acceptance Criteria
1. The system applies the policy.
2. Users sign up promptly.
3. Sessions expire after a period of inactivity.
4. Warning appears 10 minutes before timeout.
5. Indicator disappears upon token receipt.
6. Validation completes quickly.
`
    const out = summarizeAcDiff(before, after)
    // The user must SEE that 5 ACs were modified — not the vague "1 gap remains."
    expect(out.modifiedAcs).toEqual([1, 2, 3, 5, 6])
    expect(out.brief).toContain("Modified ACs 1, 2, 3, 5, 6")
  })
})
