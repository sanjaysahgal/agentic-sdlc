// Phase 5 / I22 — dismiss-intent classifier tests.
//
// Two-layer coverage per the producer-consumer-chain rule (memory:
// feedback_producer_consumer_chain): the gate fires when the LLM returns
// "DISMISS", so we test BOTH that the consumer (parser) handles "DISMISS"
// correctly AND that the producer (system prompt) is structured to actually
// produce that token for representative dismiss messages.
//
// Layer 1 — consumer test (mocked LLM): mock the Anthropic client, feed
// canned model outputs ("DISMISS" / "NOT-DISMISS" / unrecognized), assert
// the parser returns the right `dismiss` boolean.
//
// Layer 2 — producer-prompt test: assert the system prompt contains the
// literal output tokens AND examples for both classes. This pins the
// prompt against silent drift — a future edit that drops "DISMISS" from
// the prompt would compile but never produce dismisses in production. A
// real-fixture-sourced producer test (capture Haiku output for a sample
// set of dismiss/non-dismiss prompts) is queued for a follow-up after
// Phase 4 cutover when live runs become routine; until then the prompt-
// structure assertions catch the most common regression class.

import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoist the mock so the import below picks it up. The classifier imports
// `new Anthropic()` at module load; we replace the .messages.create method
// with a Vitest mock per test. Mirrors the canonical pattern used in
// tests/unit/conversation-summarizer.test.ts — vi.hoisted lifts mockCreate
// above the vi.mock factory at compile time.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { classifyDismissIntent, DISMISS_SYSTEM_PROMPT } from "../../runtime/routing/dismiss-classifier"

beforeEach(() => {
  mockCreate.mockReset()
})

function llmReturns(text: string): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: "text", text }],
  })
}

describe("classifyDismissIntent — consumer (mocked Anthropic)", () => {
  it("DISMISS token → dismiss=true", async () => {
    llmReturns("DISMISS")
    const result = await classifyDismissIntent("leave it as-is")
    expect(result.dismiss).toBe(true)
    expect(result.rawOutput).toBe("DISMISS")
  })

  it("NOT-DISMISS token → dismiss=false", async () => {
    llmReturns("NOT-DISMISS")
    const result = await classifyDismissIntent("yes")
    expect(result.dismiss).toBe(false)
    expect(result.rawOutput).toBe("NOT-DISMISS")
  })

  it("trims whitespace around the LLM output", async () => {
    llmReturns("  DISMISS  \n")
    const result = await classifyDismissIntent("the spec is fine")
    expect(result.dismiss).toBe(true)
  })

  it("any output other than exact 'DISMISS' is treated as NOT-DISMISS (conservative bias)", async () => {
    llmReturns("MAYBE")
    const r1 = await classifyDismissIntent("???")
    expect(r1.dismiss).toBe(false)

    llmReturns("dismiss")  // wrong case
    const r2 = await classifyDismissIntent("???")
    expect(r2.dismiss).toBe(false)

    llmReturns("DISMISS the escalation")  // extra text
    const r3 = await classifyDismissIntent("???")
    expect(r3.dismiss).toBe(false)
  })

  it("non-text content block → defaults to NOT-DISMISS", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
    })
    const result = await classifyDismissIntent("anything")
    expect(result.dismiss).toBe(false)
    expect(result.rawOutput).toBe("NOT-DISMISS")
  })

  it("empty input → no LLM call, returns NOT-DISMISS immediately", async () => {
    const result = await classifyDismissIntent("   ")
    expect(result.dismiss).toBe(false)
    expect(result.rawOutput).toBe("")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("invokes Haiku 4.5 with the canonical system prompt", async () => {
    llmReturns("NOT-DISMISS")
    await classifyDismissIntent("anything")
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model:  "claude-haiku-4-5-20251001",
      system: DISMISS_SYSTEM_PROMPT,
    }))
  })
})

describe("classifyDismissIntent — producer (system-prompt structure)", () => {
  // These tests pin the prompt against silent drift. They don't exercise
  // the model — they assert the prompt is shaped to PRODUCE the gated
  // tokens. A real-fixture-sourced producer test is queued as follow-up.

  it("declares the exact output tokens the consumer parses on", () => {
    expect(DISMISS_SYSTEM_PROMPT).toContain("DISMISS")
    expect(DISMISS_SYSTEM_PROMPT).toContain("NOT-DISMISS")
    expect(DISMISS_SYSTEM_PROMPT).toMatch(/Respond with exactly one of:\s*DISMISS\s*NOT-DISMISS/)
  })

  it("includes positive dismiss examples (model has at least 5 to pattern from)", () => {
    const positives = [
      "leave it as-is",
      "ignore those gaps",
      "abandon this escalation",
      "skip this",
      "drop the escalation",
    ]
    for (const ex of positives) {
      expect(DISMISS_SYSTEM_PROMPT).toContain(ex)
    }
  })

  it("includes negative examples that would otherwise look like dismisses (Principle 11 — conservative bias)", () => {
    const negatives = [
      "yes",        // affirmative ≠ dismiss
      "go ahead",   // affirmative ≠ dismiss
      "no, the spec needs work",  // declining the spec ≠ dismissing the escalation
      "let me think about it",    // deferred ≠ dismissed
    ]
    for (const ex of negatives) {
      expect(DISMISS_SYSTEM_PROMPT).toContain(ex)
    }
  })

  it("explicitly states the conservative bias rule", () => {
    expect(DISMISS_SYSTEM_PROMPT.toLowerCase()).toContain("conservative")
    expect(DISMISS_SYSTEM_PROMPT.toLowerCase()).toContain("ambig")
  })

  it("names the operational context the classifier sits in (active spec audit escalation)", () => {
    expect(DISMISS_SYSTEM_PROMPT.toLowerCase()).toContain("escalation")
    expect(DISMISS_SYSTEM_PROMPT.toLowerCase()).toContain("audit")
  })
})
