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

  it("describes design-approved-awaiting-engineering correctly", () => {
    const features: FeatureStatus[] = [
      { featureName: "payments", phase: "design-approved-awaiting-engineering" },
    ]
    const prompt = buildConciergeSystemPrompt(features, baseContext)
    expect(prompt.toLowerCase()).toMatch(/design|engineer/)
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
})
