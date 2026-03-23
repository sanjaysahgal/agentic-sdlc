import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildArchitectSystemPrompt,
  isCreateEngineeringSpecIntent,
  hasDraftEngineeringSpec,
  extractDraftEngineeringSpec,
  extractEngineeringSpecContent,
} from "../../agents/architect"
import type { AgentContext } from "../../runtime/context-loader"

const baseContext: AgentContext = {
  productVision: "We help teams ship faster.",
  systemArchitecture: "Next.js, tRPC, Prisma.",
  featureConventions: "",
  currentDraft: "",
}

describe("buildArchitectSystemPrompt", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("includes featureName in the prompt", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("onboarding")
  })

  it("leads with a structural proposal — data model and API surface in opening", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("data model")
    expect(prompt).toContain("API surface")
  })

  it("enforces data model first — no API discussion before data model agreed", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Data model first")
  })

  it("enforces one question at a time", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("One question at a time")
  })

  it("prohibits permission-asking phrases", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Permission-asking is a failure")
    expect(prompt).toContain("Shall I")
    expect(prompt).toContain("Would you like me to")
  })

  it("requires system architecture updates section in every approved spec", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("PROPOSED ADDITION TO SYSTEM_ARCHITECTURE.md")
    expect(prompt).toContain("END PROPOSED ADDITION")
  })

  it("mandates auto-save after every agreed decision", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Save a draft after EVERY response")
  })

  it("names the DRAFT block markers", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("DRAFT_ENGINEERING_SPEC_START")
    expect(prompt).toContain("DRAFT_ENGINEERING_SPEC_END")
  })

  it("names the approval marker", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("INTENT: CREATE_ENGINEERING_SPEC")
  })

  it("redirects out-of-scope questions to main channel", () => {
    process.env.SLACK_MAIN_CHANNEL = "all-testapp"
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("all-testapp")
  })

  it("injects approved spec chain when present", () => {
    const prompt = buildArchitectSystemPrompt(
      { ...baseContext, currentDraft: "## Approved Product Spec\nHelp users onboard." },
      "onboarding"
    )
    expect(prompt).toContain("Help users onboard.")
  })

  it("warns when no approved specs found", () => {
    const prompt = buildArchitectSystemPrompt({ ...baseContext, currentDraft: "" }, "onboarding")
    expect(prompt).toContain("No approved specs found")
  })

  it("injects approved engineering specs for cross-feature coherence", () => {
    const prompt = buildArchitectSystemPrompt(
      { ...baseContext, approvedFeatureSpecs: "### dashboard\n# Dashboard Engineering Spec" },
      "onboarding"
    )
    expect(prompt).toContain("Dashboard Engineering Spec")
  })

  it("notes no prior engineering specs when none exist", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("No other approved engineering specs yet")
  })

  it("read-only mode activates READ-ONLY MODE block", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding", true)
    expect(prompt).toContain("READ-ONLY MODE")
  })

  it("read-only mode prohibits DRAFT and INTENT markers", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding", true)
    expect(prompt).toContain("DRAFT_ENGINEERING_SPEC_START")
    expect(prompt).toContain("INTENT: CREATE_ENGINEERING_SPEC")
  })

  it("includes a direct link to the engineering spec on GitHub", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("https://github.com/o/r/blob/spec/onboarding-engineering/")
    expect(prompt).toContain("onboarding.engineering.md")
  })
})

describe("isCreateEngineeringSpecIntent", () => {
  it("returns true when response contains INTENT: CREATE_ENGINEERING_SPEC", () => {
    expect(isCreateEngineeringSpecIntent("INTENT: CREATE_ENGINEERING_SPEC\n# Onboarding — Engineering Spec")).toBe(true)
  })

  it("returns false when marker is absent", () => {
    expect(isCreateEngineeringSpecIntent("Looks good, let's move forward.")).toBe(false)
  })

  it("returns false for product spec marker", () => {
    expect(isCreateEngineeringSpecIntent("INTENT: CREATE_SPEC")).toBe(false)
  })

  it("returns false for design spec marker", () => {
    expect(isCreateEngineeringSpecIntent("INTENT: CREATE_DESIGN_SPEC")).toBe(false)
  })
})

describe("hasDraftEngineeringSpec", () => {
  it("returns true when both markers present", () => {
    const response = "Here is the draft:\nDRAFT_ENGINEERING_SPEC_START\ncontent\nDRAFT_ENGINEERING_SPEC_END"
    expect(hasDraftEngineeringSpec(response)).toBe(true)
  })

  it("returns false when only start marker present", () => {
    expect(hasDraftEngineeringSpec("DRAFT_ENGINEERING_SPEC_START\ncontent")).toBe(false)
  })

  it("returns false when neither marker present", () => {
    expect(hasDraftEngineeringSpec("Just a regular response.")).toBe(false)
  })

  it("returns false for product spec markers", () => {
    expect(hasDraftEngineeringSpec("DRAFT_SPEC_START\ncontent\nDRAFT_SPEC_END")).toBe(false)
  })

  it("returns false for design spec markers", () => {
    expect(hasDraftEngineeringSpec("DRAFT_DESIGN_SPEC_START\ncontent\nDRAFT_DESIGN_SPEC_END")).toBe(false)
  })
})

describe("extractDraftEngineeringSpec", () => {
  it("extracts content between markers", () => {
    const response = "Some text\nDRAFT_ENGINEERING_SPEC_START\n# Engineering Spec\ncontent here\nDRAFT_ENGINEERING_SPEC_END\nMore text"
    expect(extractDraftEngineeringSpec(response)).toBe("# Engineering Spec\ncontent here")
  })

  it("returns empty string when markers not found", () => {
    expect(extractDraftEngineeringSpec("no markers here")).toBe("")
  })

  it("trims whitespace from extracted content", () => {
    const response = "DRAFT_ENGINEERING_SPEC_START\n  content  \nDRAFT_ENGINEERING_SPEC_END"
    expect(extractDraftEngineeringSpec(response)).toBe("content")
  })
})

describe("extractEngineeringSpecContent", () => {
  it("extracts content from code block", () => {
    const response = "INTENT: CREATE_ENGINEERING_SPEC\n```\n# Engineering Spec\n## Data Model\n```"
    expect(extractEngineeringSpecContent(response)).toBe("# Engineering Spec\n## Data Model")
  })

  it("falls back to stripping marker when no code block", () => {
    const response = "INTENT: CREATE_ENGINEERING_SPEC\n# Engineering Spec\n## Data Model"
    expect(extractEngineeringSpecContent(response)).toBe("# Engineering Spec\n## Data Model")
  })
})
