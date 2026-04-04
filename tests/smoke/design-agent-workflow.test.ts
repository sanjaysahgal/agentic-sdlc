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
import { DESIGN_TOOLS, buildDesignSystemPrompt } from "../../agents/design"
import { identifyUncommittedDecisions } from "../../runtime/conversation-summarizer"
import { WorkspaceConfig } from "../../runtime/workspace-config"

const ENABLED = process.env.SMOKE_TEST === "true"

// Minimal config that satisfies buildDesignSystemPrompt without a real .env.
// Tests must pass a context and featureName — config values affect prompt copy
// but not the behavioral rules under test (escalation, patch auto-save).
const TEST_CONFIG: WorkspaceConfig = {
  productName: "TestApp",
  githubOwner: "test-owner",
  githubRepo: "test-repo",
  mainChannel: "general",
  targetFormFactors: ["mobile"],
  roles: { pmUser: "", designerUser: "", architectUser: "" },
  paths: {
    productVision: "specs/product/PRODUCT_VISION.md",
    systemArchitecture: "specs/architecture/system-architecture.md",
    designSystem: "specs/design/DESIGN_SYSTEM.md",
    brand: "specs/brand/BRAND.md",
    featureConventions: "specs/features/CLAUDE.md",
    featuresRoot: "specs/features",
  },
}

// Minimal AgentContext for smoke tests — no brand or upstream specs needed
// to exercise the behavioral rules we are guarding.
const TEST_CONTEXT = {
  productVision: "New users create an account and complete a 3-step health profile. The app shows a personalized dashboard after onboarding completes.",
  systemArchitecture: "",
  brand: null,
  designSystem: null,
  approvedSpecs: [],
  currentDraft: null,
  featureName: "onboarding",
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: Design agent calls offer_pm_escalation on a product spec gap
// Guards against: tool removed from DESIGN_TOOLS, system prompt rule weakened
// Uses the real buildDesignSystemPrompt to catch regressions in that function.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — design agent calls offer_pm_escalation on spec gap (real API)", () => {
  let toolName: string | null
  let toolInput: Record<string, unknown> | null

  beforeAll(async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const systemPrompt = buildDesignSystemPrompt(TEST_CONTEXT as any, "onboarding", false, TEST_CONFIG)

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt + `\n\nCURRENT PRODUCT SPEC:\n## Onboarding\nNew users create an account and complete a 3-step health profile. The app shows a personalized dashboard after onboarding completes.\n\n[IMPORTANT: The spec does not define what happens when an already-authenticated user opens the app after reinstalling — whether they see onboarding again, skip to the dashboard, or see a "welcome back" flow.]`,
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

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: Design agent calls apply_design_spec_patch after user agreement
// Guards against: agent acknowledging agreement in text but not calling the tool
// Uses real buildDesignSystemPrompt to catch prompt regressions.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — design agent calls apply_design_spec_patch after user agrees to design direction (real API)", () => {
  let patchToolName: string | null
  let patchInput: Record<string, unknown> | null

  beforeAll(async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    // Context simulates mid-conversation: agent has proposed a direction,
    // user has now explicitly agreed. A draft already exists (triggers patch vs. save).
    const contextWithDraft = {
      ...TEST_CONTEXT,
      currentDraft: "## Brand\nPrimary: #FFFFFF\n\n## Screens\n### Onboarding\nTBD",
    }
    const systemPrompt = buildDesignSystemPrompt(contextWithDraft as any, "onboarding", false, TEST_CONFIG)

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      tools: DESIGN_TOOLS,
      tool_choice: { type: "auto" as const },
      messages: [
        {
          role: "user",
          content: "Let's use a dark background (#0A0A0F) with white text (#FFFFFF) and the Inter font throughout.",
        },
        {
          role: "assistant",
          content: "Dark background #0A0A0F with white text #FFFFFF and Inter throughout — that's a strong, clean foundation. I'll lock in the Brand section now.",
        },
        {
          role: "user",
          content: "Yes, lock those in.",
        },
      ],
    })

    // Find the patch tool call (apply_design_spec_patch or save_design_spec_draft)
    const toolUse = response.content.find(b => b.type === "tool_use")
    patchToolName = toolUse?.type === "tool_use" ? toolUse.name : null
    patchInput = toolUse?.type === "tool_use" ? (toolUse.input as Record<string, unknown>) : null
  }, 60_000)

  it("agent calls a save tool — not just acknowledges in text", () => {
    expect(patchToolName).toMatch(/apply_design_spec_patch|save_design_spec_draft/)
  })

  it("patch includes the brand color or font decision", () => {
    const patchStr = JSON.stringify(patchInput ?? "").toLowerCase()
    expect(patchStr).toMatch(/#0a0a0f|inter|#ffffff/)
  })
})
