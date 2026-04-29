// Block B3 — operator-driven real-Haiku fixture capture.
//
// Per the approved plan at `~/.claude/plans/rate-this-plan-zesty-tiger.md`
// (Block B3, producer/consumer parity). The producer-side prompt-anchor
// gate (`tests/invariants/classifier-prompt-anchors.test.ts`) catches
// "the prompt drifted" — but it cannot catch "the prompt is intact AND
// Haiku produces a different answer for one of its own canonical
// examples" (regression in the LLM, model-version change, etc.). For
// that case, real captured Haiku output is required.
//
// This script runs each classifier against its canonical inputs (drawn
// from the prompt's example list) and writes the output to:
//   tests/fixtures/agent-output/<classifier-name>/captured.json
//
// The fixture loader at `tests/invariants/classifier-fixture-replay.test.ts`
// (separate file) replays each captured input through the classifier
// (mocking Haiku to return the captured output) and asserts the consumer
// extracts the expected boolean / category. This is the consumer side of
// the producer/consumer parity gate.
//
// Operator workflow:
//   1. Have ANTHROPIC_API_KEY set in environment.
//   2. Run: `npx tsx scripts/capture-classifier-fixtures.ts`
//   3. Review the diff in `tests/fixtures/agent-output/*/captured.json`.
//      - Expected: any drift is documented and intentional.
//      - Unexpected: open a defect; the model regressed for an example
//        the prompt still teaches.
//   4. Commit the fixture diff alongside any prompt change in the same
//      PR so the producer/consumer parity gate stays green.
//
// Run frequency: when prompts change; on Haiku model-version bumps;
// quarterly health check.
//
// Cost: ~30 Haiku calls per run, ~2 cents total at current pricing.

import Anthropic from "@anthropic-ai/sdk"
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"

import { DISMISS_SYSTEM_PROMPT } from "../runtime/routing/dismiss-classifier"
import { FIX_INTENT_SYSTEM_PROMPT } from "../runtime/fix-intent-classifier"
import { PM_GAP_SYSTEM_PROMPT } from "../runtime/pm-gap-classifier"
import { ARCH_GAP_SYSTEM_PROMPT } from "../runtime/arch-gap-classifier"

type FixtureSpec = {
  readonly name:        string
  readonly prompt:      string
  readonly maxTokens:   number
  readonly inputs:      readonly { input: string; expectedClass: string }[]
}

// Canonical inputs come from each prompt's own example list. Expected
// classes are what the prompt instructs Haiku to produce. If a real
// Haiku call deviates from the expected class for an example the prompt
// explicitly teaches, that's a regression — either the model drifted
// (open a defect) or the prompt is misleading (rewrite the prompt).
const SPECS: readonly FixtureSpec[] = [
  {
    name: "dismiss-classifier",
    prompt: DISMISS_SYSTEM_PROMPT,
    maxTokens: 16,
    inputs: [
      { input: "leave it as-is",                      expectedClass: "DISMISS" },
      { input: "the spec is fine, skip this",         expectedClass: "DISMISS" },
      { input: "ignore those gaps",                   expectedClass: "DISMISS" },
      { input: "abandon this escalation",             expectedClass: "DISMISS" },
      { input: "drop the escalation, just continue",  expectedClass: "DISMISS" },
      { input: "yes",                                 expectedClass: "NOT-DISMISS" },
      { input: "approved",                            expectedClass: "NOT-DISMISS" },
      { input: "what about item 3",                   expectedClass: "NOT-DISMISS" },
      { input: "hmm, maybe later",                    expectedClass: "NOT-DISMISS" },
    ],
  },
  {
    name: "fix-intent-classifier",
    prompt: FIX_INTENT_SYSTEM_PROMPT,
    maxTokens: 32,
    inputs: [
      { input: "fix all",                                  expectedClass: "FIX-ALL" },
      { input: "go ahead and fix all of these",            expectedClass: "FIX-ALL" },
      { input: "fix 1, 3, and 5",                          expectedClass: "FIX-ITEMS:1,3,5" },
      { input: "apply your recommendations for 1, 4, and 7", expectedClass: "FIX-ITEMS:1,4,7" },
      { input: "yes",                                      expectedClass: "NOT-FIX" },
      { input: "what is item 3 about",                     expectedClass: "NOT-FIX" },
    ],
  },
  {
    name: "arch-gap-classifier",
    prompt: ARCH_GAP_SYSTEM_PROMPT,
    maxTokens: 32,
    inputs: [
      { input: "Does the API support streaming? I need to decide between a typing indicator vs a loading spinner.", expectedClass: "ARCH-GAP" },
      { input: "What is the max file upload size? I need to design the progress bar and error state.",              expectedClass: "ARCH-GAP" },
      { input: "How are logged-out conversations stored — client-side, server-side, or hybrid?",                    expectedClass: "DESIGN-ASSUMPTION" },
      { input: "What is the session store schema?",                                                                  expectedClass: "DESIGN-ASSUMPTION" },
    ],
  },
  // pm-gap-classifier is multi-line and context-dependent (takes optional
  // approvedProductSpec). Its capture entry is intentionally smaller; its
  // anchor gate is the primary structural check. Adding richer fixtures
  // is BACKLOG when richer regression tracking matters.
]

async function captureClassifierFixtures(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[B3-CAPTURE] ANTHROPIC_API_KEY is not set. Aborting.")
    process.exit(1)
  }

  const client = new Anthropic({ maxRetries: 0, timeout: 30_000 })

  for (const spec of SPECS) {
    console.log(`[B3-CAPTURE] ${spec.name}: capturing ${spec.inputs.length} input(s)...`)
    const captured: Array<{ input: string; expectedClass: string; rawOutput: string; matches: boolean }> = []

    for (const tc of spec.inputs) {
      const response = await client.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: spec.maxTokens,
        system:     spec.prompt,
        messages:   [{ role: "user", content: tc.input }],
      })
      const rawOutput = response.content[0].type === "text"
        ? response.content[0].text.trim()
        : ""
      // For FIX-ITEMS: prefix matches are sufficient (indices may vary in order).
      const matches = tc.expectedClass.startsWith("FIX-ITEMS:")
        ? rawOutput.startsWith("FIX-ITEMS:")
        : rawOutput === tc.expectedClass
      captured.push({ input: tc.input, expectedClass: tc.expectedClass, rawOutput, matches })
      console.log(`  [${matches ? "OK" : "FAIL"}] "${tc.input.slice(0, 50)}…" → "${rawOutput}" (expected ${tc.expectedClass})`)
    }

    const fixturePath = resolve(__dirname, "..", "tests", "fixtures", "agent-output", spec.name, "captured.json")
    if (!existsSync(dirname(fixturePath))) mkdirSync(dirname(fixturePath), { recursive: true })
    writeFileSync(fixturePath, JSON.stringify({ classifier: spec.name, capturedAt: new Date().toISOString(), captured }, null, 2))
    console.log(`[B3-CAPTURE] ${spec.name}: wrote ${fixturePath}`)

    const failures = captured.filter((c) => !c.matches)
    if (failures.length > 0) {
      console.error(`[B3-CAPTURE] ${spec.name}: ${failures.length} regression(s) — Haiku produced unexpected output for input(s) the prompt explicitly teaches:`)
      for (const f of failures) {
        console.error(`  input="${f.input}" expected=${f.expectedClass} got="${f.rawOutput}"`)
      }
    }
  }

  console.log("[B3-CAPTURE] done.")
}

captureClassifierFixtures().catch((err) => {
  console.error("[B3-CAPTURE] failed:", err)
  process.exit(1)
})
