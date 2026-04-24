import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { buildConciergeSystemPrompt } from "../../agents/concierge"
import { ACTIVE_AGENTS } from "../../agents/registry"
import type { FeatureStatus } from "../../runtime/github-client"
import type { AgentContext } from "../../runtime/context-loader"

// buildConciergeSystemPrompt and describeFeatureStatus (called internally) are pure functions.
// They only depend on process.env via loadWorkspaceConfig — set env vars directly.

const baseContext: AgentContext = {
  productVision: "We help teams ship faster.",
  systemArchitecture: "Next.js, tRPC, Prisma.",
  featureConventions: "",
  currentDraft: "",
}

describe("buildConciergeSystemPrompt", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PRODUCT_NAME: "TestApp",
      GITHUB_OWNER: "test-owner",
      GITHUB_REPO: "test-repo",
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("includes productName from workspace config — not hardcoded", () => {
    process.env.PRODUCT_NAME = "Acme"
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("Acme")
  })

  it("reflects productName change without code change (config is the only coupling point)", () => {
    process.env.PRODUCT_NAME = "BetaCo"
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("BetaCo")
    expect(prompt).not.toContain("Acme")
    expect(prompt).not.toContain("Health360")
  })

  it("includes product vision context when provided", () => {
    const prompt = buildConciergeSystemPrompt([], {
      ...baseContext,
      productVision: "We are building a revolutionary task manager.",
    })
    expect(prompt).toContain("We are building a revolutionary task manager.")
  })

  it("includes system architecture context when provided", () => {
    const prompt = buildConciergeSystemPrompt([], {
      ...baseContext,
      systemArchitecture: "GraphQL, PostgreSQL, React Native.",
    })
    expect(prompt).toContain("GraphQL, PostgreSQL, React Native.")
  })

  it("does not use markdown table syntax — Slack formatting only", () => {
    const features: FeatureStatus[] = [
      { featureName: "onboarding", phase: "product-spec-in-progress" },
      { featureName: "dashboard", phase: "product-spec-approved-awaiting-design" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    // Markdown tables use | and --- patterns
    expect(prompt).not.toMatch(/\|.*\|.*\|/)
    expect(prompt).not.toMatch(/^---+$/m)
  })

  // ─── describeFeatureStatus (tested via system prompt output) ──────────────

  it("describes product-spec-in-progress correctly", () => {
    const features: FeatureStatus[] = [
      { featureName: "onboarding", phase: "product-spec-in-progress" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt.toLowerCase()).toMatch(/in.progress|in progress/)
    expect(prompt).toContain("#feature-onboarding")
  })

  it("describes product-spec-approved-awaiting-design correctly", () => {
    const features: FeatureStatus[] = [
      { featureName: "onboarding", phase: "product-spec-approved-awaiting-design" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt.toLowerCase()).toContain("approved")
    expect(prompt.toLowerCase()).toContain("design")
    expect(prompt).toContain("#feature-onboarding")
  })

  it("describes design-in-progress correctly", () => {
    const features: FeatureStatus[] = [
      { featureName: "onboarding", phase: "design-in-progress" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt.toLowerCase()).toContain("design")
    expect(prompt).toContain("#feature-onboarding")
  })

  it("describes design-approved-awaiting-engineering correctly", () => {
    const features: FeatureStatus[] = [
      { featureName: "payments", phase: "design-approved-awaiting-engineering" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt.toLowerCase()).toMatch(/design|engineer/)
    expect(prompt).toContain("#feature-payments")
  })

  it("describes engineering-in-progress correctly", () => {
    const features: FeatureStatus[] = [
      { featureName: "payments", phase: "engineering-in-progress" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt.toLowerCase()).toMatch(/architect|engineer/)
    expect(prompt).toContain("#feature-payments")
  })

  it("includes 'no features' message when feature list is empty", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt.toLowerCase()).toMatch(/no features/)
  })

  it("lists every agent in ACTIVE_AGENTS registry — fails if a new agent is added without updating the concierge", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    for (const agent of ACTIVE_AGENTS) {
      expect(prompt, `Missing active agent in concierge prompt: "${agent.name}"`).toContain(agent.name)
    }
  })

  it("includes all in-progress features in the prompt", () => {
    const features: FeatureStatus[] = [
      { featureName: "onboarding", phase: "product-spec-in-progress" },
      { featureName: "payments", phase: "product-spec-approved-awaiting-design" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt).toContain("onboarding")
    expect(prompt).toContain("payments")
  })

  it("includes platform identity instruction — concierge knows it IS the platform", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("You ARE the SDLC platform")
    expect(prompt).toContain("Never say \"I don't know what that is\"")
    expect(prompt).toContain("Never tell the user to \"ask someone else\"")
  })

  it("includes slash command instructions for agent discoverability", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("/pm")
    expect(prompt).toContain("/design")
    expect(prompt).toContain("/architect")
    expect(prompt).toContain("slash command")
  })

  it("directs product-level discussions to slash commands, not feature channels", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("product vision")
    expect(prompt).toContain("/pm")
    // Should NOT say "open a feature channel" for vision/brand/arch discussions
    expect(prompt).not.toContain("direct them to open a feature channel and work with the PM agent")
  })

  it("prioritizes user intent over role identification", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    // Intent-over-identity rule must appear before role identification instructions
    const intentIdx = prompt.indexOf("intent over identity")
    const roleIdx = prompt.indexOf("figure out who they are")
    expect(intentIdx).toBeGreaterThan(-1)
    expect(roleIdx).toBeGreaterThan(-1)
    expect(intentIdx).toBeLessThan(roleIdx)
  })

  it("does not mention company names in persona descriptions", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    const companyNames = ["Stripe", "Airbnb", "Google", "Apple", "Meta", "Amazon"]
    for (const name of companyNames) {
      expect(prompt).not.toContain(name)
    }
  })

  it("never uses 'AI' prefix when describing agents", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).not.toContain("AI Product Manager")
    expect(prompt).not.toContain("AI UX Design")
    expect(prompt).not.toContain("AI Concierge")
  })

  it("includes thread guidance for @agent: text prefix", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("@pm:")
    expect(prompt).toContain("inside threads")
  })

  it("directs users to slash commands at channel top level, not 'right here'", () => {
    const prompt = buildConciergeSystemPrompt([], baseContext)
    expect(prompt).toContain("at the top level of this channel")
    expect(prompt).toContain("not in this thread")
  })
})
