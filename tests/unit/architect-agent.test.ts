import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildArchitectSystemPrompt,
  ARCHITECT_TOOLS,
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
    expect(prompt).toContain("Save after every agreed decision")
  })

  it("names the tool for saving the engineering spec draft", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("save_engineering_spec_draft")
  })

  it("names the tool for applying patches", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("apply_engineering_spec_patch")
  })

  it("names the tool for finalizing the spec", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("finalize_engineering_spec")
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

  it("read-only mode prohibits save and finalize tools", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding", true)
    expect(prompt).toContain("Do not call any save tools or finalize tools")
  })

  it("includes a direct link to the engineering spec on GitHub", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("https://github.com/o/r/blob/spec/onboarding-engineering/")
    expect(prompt).toContain("onboarding.engineering.md")
  })
})

describe("ARCHITECT_TOOLS structure", () => {
  it("exports 5 tools", () => {
    expect(ARCHITECT_TOOLS).toHaveLength(5)
  })

  it("includes save_engineering_spec_draft as first tool", () => {
    expect(ARCHITECT_TOOLS[0].name).toBe("save_engineering_spec_draft")
  })

  it("includes apply_engineering_spec_patch as second tool", () => {
    expect(ARCHITECT_TOOLS[1].name).toBe("apply_engineering_spec_patch")
  })

  it("includes read_approved_specs as third tool", () => {
    expect(ARCHITECT_TOOLS[2].name).toBe("read_approved_specs")
  })

  it("includes finalize_engineering_spec as fourth tool", () => {
    expect(ARCHITECT_TOOLS[3].name).toBe("finalize_engineering_spec")
  })

  it("save_engineering_spec_draft requires content parameter", () => {
    const tool = ARCHITECT_TOOLS.find(t => t.name === "save_engineering_spec_draft")!
    expect(tool.input_schema.required).toContain("content")
  })

  it("apply_engineering_spec_patch requires patch parameter", () => {
    const tool = ARCHITECT_TOOLS.find(t => t.name === "apply_engineering_spec_patch")!
    expect(tool.input_schema.required).toContain("patch")
  })

  it("read_approved_specs has no required parameters — featureNames is optional", () => {
    const tool = ARCHITECT_TOOLS.find(t => t.name === "read_approved_specs")!
    expect(tool.input_schema.required).toHaveLength(0)
  })

  it("finalize_engineering_spec requires no parameters", () => {
    const tool = ARCHITECT_TOOLS.find(t => t.name === "finalize_engineering_spec")!
    expect(tool.input_schema.required).toHaveLength(0)
  })

  it("includes offer_upstream_revision as fifth tool with question and targetAgent required", () => {
    const tool = ARCHITECT_TOOLS.find(t => t.name === "offer_upstream_revision")!
    expect(tool).toBeDefined()
    expect(tool.input_schema.required).toContain("question")
    expect(tool.input_schema.required).toContain("targetAgent")
    const targetEnum = (tool.input_schema.properties as any).targetAgent.enum
    expect(targetEnum).toContain("pm")
    expect(targetEnum).toContain("design")
  })
})

describe("buildArchitectSystemPrompt — PATCH enforcement rules", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })
  afterEach(() => { process.env = originalEnv })

  const draftContext: AgentContext = {
    ...baseContext,
    currentDraft: "## Approved Product Spec\nSpec.\n\n## Approved Design Spec\nDesign.\n\n## Current Engineering Draft\n# Onboarding — Engineering Spec\n\n## Data Model\nUser table.",
  }

  it("PATCH is absolute — no exceptions phrase is present", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("no exceptions")
  })

  it("prohibits confirm-then-ask pattern — agreement is the permission", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("agreement is the permission")
  })

  it("enforces batch PATCH limit of 3 sections per response", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("3 most significant")
    expect(prompt).toContain("more than 3 sections")
  })
})

describe("buildArchitectSystemPrompt — domain boundary", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })
  afterEach(() => { process.env = originalEnv })

  const draftContext: AgentContext = {
    ...baseContext,
    currentDraft: "## Approved Product Spec\nSpec.\n\n## Approved Design Spec\nDesign.\n\n## Current Engineering Draft\n# Onboarding — Engineering Spec\n\n## Data Model\nUser table.",
  }

  it("has an explicit domain boundary section", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("Domain boundary")
    expect(prompt).toContain("what you never own")
  })

  it("product decisions are routed to offer_upstream_revision(pm) — never made by architect", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("offer_upstream_revision")
    expect(prompt.toLowerCase()).toMatch(/pm owns|product.*pm|pm.*product behavior/)
  })

  it("design decisions are routed to offer_upstream_revision(design) — never made by architect", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt.toLowerCase()).toMatch(/designer owns|design.*designer|ui.*layout.*designer/)
  })

  it("architect owns the technical domain explicitly", () => {
    const prompt = buildArchitectSystemPrompt(draftContext, "onboarding")
    expect(prompt.toLowerCase()).toMatch(/data model|api contracts|you own.*technical|technical.*yours/)
  })

  it("includes newcomer orientation instruction — orient before gap dump", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Read the room first")
    expect(prompt).toContain("STOP THERE")
  })

  it("includes assertive escalation instruction — no defer option", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("PM gaps first")
    expect(prompt).toContain("Design gaps second")
    expect(prompt).toContain("Never ask \"do you want me to escalate?\"")
  })

  it("GitHub is single source of truth — never trust conversation history over spec", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("GitHub is the single source of truth")
    expect(prompt).toContain("conversation history is not")
    expect(prompt).toContain("if X is not in the spec, X is a gap")
  })

  it("cannot modify upstream specs — only escalate", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("You cannot modify upstream specs")
    expect(prompt).toContain("NO tool to write to the PM spec or design spec")
    expect(prompt).toContain("offer_upstream_revision")
  })

  it("never asks 'did they already resolve this' or offers to update specs", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Never ask \"did they already resolve this?\"")
    expect(prompt).toContain("Never offer to \"update the specs yourself\"")
  })

  it("includes 'never say platform' instruction — findings are the architect's own", () => {
    const prompt = buildArchitectSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Never say \"the platform\" to the user")
    expect(prompt).toContain("Findings are yours")
  })
})
