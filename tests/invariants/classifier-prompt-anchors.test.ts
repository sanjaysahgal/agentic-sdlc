// Block B3 — classifier prompt-drift gate (producer side).
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// (Block B3, producer/consumer parity). The bug class B3 retires:
// "consumer test mocked the LLM to return X, but the prompt was never
// verified to actually instruct Haiku to produce X." The N18 escalation
// gate (April 2026) shipped this exact bug — gate logic was correct, but
// the rubric criteria contained no instruction to produce the expected
// tag, so real Haiku never generated it. The fix required restructuring.
//
// This test is the producer side of the contract. For every classifier
// (`runtime/*-classifier.ts` and `runtime/routing/dismiss-classifier.ts`):
//   - The system prompt is loaded from the same module the runtime uses
//   - Pinned anchor strings (canonical examples + valid output tokens)
//     MUST appear in the prompt verbatim
//   - If anyone removes a canonical example or changes the output schema,
//     this test fails at PR time — before production drift can ship
//
// Real-Haiku fixture verification (the orthogonal "Haiku regressed for an
// example the prompt still contains" case) is operator-driven via
// `scripts/capture-classifier-fixtures.ts` (BACKLOG entry: real-fixture
// capture). The structural anchor gate ships now.

import { describe, it, expect } from "vitest"
import { DISMISS_SYSTEM_PROMPT } from "../../runtime/routing/dismiss-classifier"
import { FIX_INTENT_SYSTEM_PROMPT } from "../../runtime/fix-intent-classifier"
import { PM_GAP_SYSTEM_PROMPT } from "../../runtime/pm-gap-classifier"
import { ARCH_GAP_SYSTEM_PROMPT } from "../../runtime/arch-gap-classifier"

// Each anchor entry is a structural-truth claim about the prompt: if the
// anchor disappears, behavior the platform depends on is no longer
// reliably elicited. Every anchor here was the basis for a behavior or
// regression-prevention decision; removing one without replacement is a
// contract violation.

type AnchorSpec = {
  readonly name:    string
  readonly prompt:  string
  readonly outputTokens: readonly string[]   // valid output strings the consumer parses
  readonly canonicalExamples: readonly string[]  // example inputs the prompt teaches
  readonly criticalRules: readonly string[]  // policy phrases consumer logic depends on
}

const SPECS: readonly AnchorSpec[] = [
  {
    name: "dismiss-classifier",
    prompt: DISMISS_SYSTEM_PROMPT,
    outputTokens: ["DISMISS", "NOT-DISMISS"],
    canonicalExamples: [
      // Positive examples — must elicit DISMISS
      `"leave it as-is"`,
      `"the spec is fine, skip this"`,
      `"ignore those gaps"`,
      `"abandon this escalation"`,
      `"drop the escalation, just continue"`,
      // Negative examples — must elicit NOT-DISMISS
      `"yes"`,
      `"approved"`,
      `"what about item 3"`,
      `"hmm, maybe later"`,
    ],
    criticalRules: [
      "CONSERVATIVE RULE",
      // The conservative bias is the safety net; if it disappears the
      // false-dismiss rate goes up. The rule wording is load-bearing.
    ],
  },
  {
    name: "fix-intent-classifier",
    prompt: FIX_INTENT_SYSTEM_PROMPT,
    outputTokens: ["FIX-ALL", "FIX-ITEMS:", "NOT-FIX"],
    canonicalExamples: [
      // Positive
      `"fix all"`,
      `"fix 1, 3, and 5"`,
      `"apply your recommendations for 1, 4, and 7"`,
      // Negative
      `"yes"`,
      `"approved"`,
      `"what is item 3 about"`,
    ],
    criticalRules: [
      "CONSERVATIVE RULE",
    ],
  },
  {
    name: "pm-gap-classifier",
    prompt: PM_GAP_SYSTEM_PROMPT,
    outputTokens: ["GAP:", "DESIGN:", "ARCH:", "NONE"],
    canonicalExamples: [
      // The "PM owns the WHAT not the HOW" framing is the prompt's
      // entire behavioral spec; if it disappears the classifier
      // collapses categories.
      "THE PM OWNS THE WHAT — NOT THE HOW",
    ],
    criticalRules: [
      "CRITICAL RULE",  // "check the approved PM spec first"
      "Approved Product Spec",  // section header passed at runtime
    ],
  },
  {
    name: "arch-gap-classifier",
    prompt: ARCH_GAP_SYSTEM_PROMPT,
    outputTokens: ["ARCH-GAP", "DESIGN-ASSUMPTION"],
    canonicalExamples: [
      // The "single test" framing is the prompt's entire behavioral spec.
      "THE SINGLE TEST",
      `"Would the UI look or behave differently depending on the answer?"`,
    ],
    criticalRules: [
      "ARCH-GAP examples",
      "DESIGN-ASSUMPTION examples",
    ],
  },
]

describe("Block B3 — classifier prompt-anchor gate (producer-side drift detection)", () => {
  for (const spec of SPECS) {
    describe(`${spec.name}`, () => {
      it("prompt is non-empty and importable from the runtime module (single-source guard)", () => {
        expect(spec.prompt).toBeDefined()
        expect(spec.prompt.length).toBeGreaterThan(50)
      })

      for (const token of spec.outputTokens) {
        it(`prompt instructs Haiku to use the output token '${token}' (consumer parses this verbatim)`, () => {
          expect(spec.prompt).toContain(token)
        })
      }

      for (const example of spec.canonicalExamples) {
        it(`prompt contains canonical example: ${example.slice(0, 60)}…`, () => {
          expect(spec.prompt).toContain(example)
        })
      }

      for (const rule of spec.criticalRules) {
        it(`prompt contains critical-rule phrase: ${rule}`, () => {
          expect(spec.prompt).toContain(rule)
        })
      }
    })
  }

  describe("plan-level gate summary", () => {
    it("all 4 classifiers contribute their prompts to the producer-side gate", () => {
      expect(SPECS).toHaveLength(4)
      // Every classifier shipped today must be in the SPECS table. If a new
      // classifier is added (B3 + future), the operator updates this table
      // — failure to do so is a delivery gap caught by code review (no test
      // can structurally assert "every Anthropic.messages.create caller is
      // listed here" without a global registry; the table IS the registry).
      // eslint-disable-next-line no-console
      console.log(`[B3-GATE] ${SPECS.length} classifier prompts pinned (anchors + output tokens + critical rules).`)
    })
  })
})
