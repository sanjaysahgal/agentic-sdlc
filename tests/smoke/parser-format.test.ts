/**
 * Smoke tests — real Anthropic API, no mocks.
 *
 * These tests exist to catch one failure class that unit tests cannot:
 * the model changes its output format and our parsers silently return empty.
 *
 * Each test sends a prompt to the real API, captures the response, and
 * asserts that the platform parsers can extract the expected data from it.
 * If a test starts failing it means the model's format has drifted from
 * what our parsers expect — the fixture must be updated and the parser fixed.
 *
 * Run:   SMOKE_TEST=true npx vitest run tests/smoke/
 * CI:    NOT run in CI — requires real ANTHROPIC_API_KEY and incurs API cost.
 */

import { describe, it, expect, beforeAll } from "vitest"
import Anthropic from "@anthropic-ai/sdk"
import { readFileSync } from "fs"
import { join } from "path"
import { auditBrandTokens, auditAnimationTokens } from "../../runtime/brand-auditor"

const ENABLED = process.env.SMOKE_TEST === "true"
const FIXTURE_DIR = join(__dirname, "../fixtures/agent-output")
const BRAND_MD_WITH_ANIMATION = readFileSync(join(FIXTURE_DIR, "brand-md-with-animation.md"), "utf-8")

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function callModel(systemPrompt: string, userMessage: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001", // Haiku — cheapest for format probing
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  })
  const block = response.content[0]
  if (block.type !== "text") throw new Error("Expected text response")
  return block.text
}

// ─────────────────────────────────────────────────────────────────────────────
// Brand token format probe
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — brand token format (real Anthropic API)", () => {
  let specOutput: string

  // Instruct the model to output a Brand section using SPECIFIC drifted values.
  // If the model follows the format, auditBrandTokens will detect the drift.
  // If the model changes its format and the parser breaks, auditBrandTokens returns
  // empty — which will fail the assertion.
  beforeAll(async () => {
    const system = `You are a UX designer writing a design spec. Output ONLY the Brand section, nothing else.
Use EXACTLY this format — do not deviate:

## Brand

**Color Palette**
- \`--bg:\` \`#0A0E27\` // Page background
- \`--surface:\` \`#151B38\` // Card surfaces
- \`--text:\` \`#F8F8F7\` // Primary text
- \`--violet:\` \`#8B7FE8\` // Accent violet
- \`--teal:\` \`#4FADA8\` // Accent teal
- \`--error:\` \`#e06c75\` // Error

**Animation & Glow**
- Glow duration: \`2.5s\` ease-in-out
- Blur radius: \`200px\`
- Opacity cycle: 0.45 → 0.75
- Animation delay: \`-0.5s\`

Output nothing else — no intro, no explanation, just the Brand section above.`
    specOutput = await callModel(system, "Output the Brand section now.")
  }, 30_000)

  it("model outputs a ## Brand section (format not broken)", () => {
    expect(specOutput).toContain("## Brand")
  })

  it("auditBrandTokens detects --violet color drift from the model's output", () => {
    // Model is instructed to write #8B7FE8; BRAND.md has #7C6FCD → should be detected
    const drifts = auditBrandTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    const violet = drifts.find(d => d.token === "--violet")
    expect(violet).toBeDefined()
    expect(violet?.specValue).toBe("#8B7FE8")
    expect(violet?.brandValue).toBe("#7C6FCD")
  })

  it("auditBrandTokens does not flag --text which matches BRAND.md exactly", () => {
    const drifts = auditBrandTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    expect(drifts.find(d => d.token === "--text")).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Animation token format probe
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("Smoke — animation token format (real Anthropic API)", () => {
  let specOutput: string

  // Same approach: instruct the model to use specific drifted animation values,
  // then assert the parser detects every one of them.
  beforeAll(async () => {
    const system = `You are a UX designer writing a design spec. Output ONLY the Brand section, nothing else.
Use EXACTLY this format — do not deviate:

## Brand

**Color Palette**
- \`--violet:\` \`#7C6FCD\`

**Animation & Glow**
- Glow duration: \`2.5s\` ease-in-out
- Blur radius: \`200px\`
- Opacity cycle: 0.45 → 0.75
- Animation delay: \`-0.5s\`

Output nothing else — no intro, no explanation, just the Brand section above.`
    specOutput = await callModel(system, "Output the Brand section now.")
  }, 30_000)

  it("auditAnimationTokens detects glow-duration drift (2.5s vs 4s)", () => {
    const drifts = auditAnimationTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    const d = drifts.find(d => d.param === "glow-duration")
    expect(d?.specValue).toBe("2.5s")
    expect(d?.brandValue).toBe("4s")
  })

  it("auditAnimationTokens detects glow-blur drift (200px vs 80px)", () => {
    const drifts = auditAnimationTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    const d = drifts.find(d => d.param === "glow-blur")
    expect(d?.specValue).toBe("200px")
    expect(d?.brandValue).toBe("80px")
  })

  it("auditAnimationTokens detects glow-opacity-min drift (0.45 vs 0.55)", () => {
    const drifts = auditAnimationTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    const d = drifts.find(d => d.param === "glow-opacity-min")
    expect(d?.specValue).toBe("0.45")
    expect(d?.brandValue).toBe("0.55")
  })

  it("auditAnimationTokens detects glow-opacity-max drift (0.75 vs 1.00)", () => {
    const drifts = auditAnimationTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    const d = drifts.find(d => d.param === "glow-opacity-max")
    expect(d?.specValue).toBe("0.75")
    expect(d?.brandValue).toBe("1.00")
  })

  it("auditAnimationTokens detects glow-delay drift (-0.5s vs -1.8s)", () => {
    const drifts = auditAnimationTokens(specOutput, BRAND_MD_WITH_ANIMATION)
    const d = drifts.find(d => d.param === "glow-delay")
    expect(d?.specValue).toBe("-0.5s")
    expect(d?.brandValue).toBe("-1.8s")
  })
})
