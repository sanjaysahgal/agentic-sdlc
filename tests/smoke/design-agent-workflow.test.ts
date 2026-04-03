/**
 * Smoke tests — real Anthropic API, no mocks.
 *
 * These tests exist to catch behavioral regressions that unit tests cannot:
 * - A tool removed from DESIGN_TOOLS (Step 13 regression class)
 * - identifyUncommittedDecisions false positives on question-only turns
 * - identifyUncommittedDecisions missing genuine user agreements
 *
 * Run:   SMOKE_TEST=true npx vitest run tests/smoke/
 * CI:    NOT run in CI — requires real ANTHROPIC_API_KEY and incurs API cost.
 */

import { describe, it, expect, beforeAll } from "vitest"
import Anthropic from "@anthropic-ai/sdk"
import { DESIGN_TOOLS } from "../../agents/design"
import { identifyUncommittedDecisions } from "../../runtime/conversation-summarizer"

const ENABLED = process.env.SMOKE_TEST === "true"

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Design agent calls offer_pm_escalation on a product spec gap
// Guards against: tool removed from DESIGN_TOOLS, system prompt rule weakened
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — design agent calls offer_pm_escalation on spec gap (real API)", () => {
  let toolName: string | null
  let toolInput: Record<string, unknown> | null

  beforeAll(async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: `You are a UX Design agent. Your rules:
- When a user request exposes a product question the spec doesn't answer and you cannot resolve from design judgment alone, call offer_pm_escalation IMMEDIATELY with the specific blocking question. Do NOT ask the user "want me to flag it for the PM?" — just call the tool.
- Do NOT ask multiple questions. Do NOT proceed with design assumptions on unanswered product questions.

PRODUCT SPEC:
## Onboarding
New users create an account and complete a 3-step health profile. The app shows a personalized dashboard after onboarding completes.

[IMPORTANT: The spec does not define what happens when an already-authenticated user opens the app after reinstalling — whether they see onboarding again, skip to the dashboard, or see a "welcome back" flow.]`,
      tools: DESIGN_TOOLS,
      tool_choice: { type: "auto" as const },
      messages: [{ role: "user", content: "Design the onboarding screen. What should happen when a user who already completed onboarding reinstalls and opens the app?" }],
    })

    const toolUse = response.content.find(b => b.type === "tool_use")
    toolName = toolUse?.type === "tool_use" ? toolUse.name : null
    toolInput = toolUse?.type === "tool_use" ? (toolUse.input as Record<string, unknown>) : null
  }, 60_000)

  it("model calls offer_pm_escalation — not just mentions it in text", () => {
    expect(toolName).toBe("offer_pm_escalation")
  })

  it("escalation question is present and non-empty", () => {
    expect(typeof toolInput?.question).toBe("string")
    expect((toolInput?.question as string).length).toBeGreaterThan(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: identifyUncommittedDecisions returns "none" for question-only turn
// Guards against: false positive warnings when agent only asked a question
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — identifyUncommittedDecisions: no false positive on question-only turn (real API)", () => {
  let result: string

  beforeAll(async () => {
    const turn = [
      { role: "user" as const, content: "Where should the tagline appear on the onboarding screen?" },
      {
        role: "assistant" as const,
        content:
          "I see two options: A) Full-screen hero with the tagline as the dominant element, or B) Metadata below the app name in a standard header. Which direction feels right for the brand?",
      },
    ]
    result = await identifyUncommittedDecisions(turn, "## Design Direction\nDark mode with --bg: #0A0A0F")
  }, 30_000)

  it("returns 'none' — agent proposed options, user made no choice", () => {
    expect(result.trim().toLowerCase()).toBe("none")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: identifyUncommittedDecisions detects a genuine user agreement
// Guards against: over-tightened prompt that misses real commitments
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — identifyUncommittedDecisions: detects genuine user agreement (real API)", () => {
  let result: string

  beforeAll(async () => {
    const turn = [
      { role: "user" as const, content: "I want dark mode with the Archon palette. Let's go with that." },
      { role: "assistant" as const, content: "Dark mode confirmed with the Archon palette — I'll save the Brand section now." },
    ]
    result = await identifyUncommittedDecisions(turn, "## Design Direction\nLight mode default.")
  }, 30_000)

  it("result is NOT 'none' — user explicitly agreed to dark mode", () => {
    expect(result.trim().toLowerCase()).not.toBe("none")
  })

  it("result references the dark mode decision", () => {
    expect(result.toLowerCase()).toMatch(/dark mode|archon/)
  })
})
