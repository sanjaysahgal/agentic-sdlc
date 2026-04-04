import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildPmSystemPrompt,
  PM_TOOLS,
} from "../../agents/pm"
import type { AgentContext } from "../../runtime/context-loader"

const baseContext: AgentContext = {
  productVision: "We help teams ship faster.",
  systemArchitecture: "Next.js, tRPC, Prisma.",
  featureConventions: "",
  currentDraft: "",
}

describe("PM_TOOLS structure", () => {
  it("exports 4 tools", () => {
    expect(PM_TOOLS).toHaveLength(4)
  })

  it("includes save_product_spec_draft as first tool", () => {
    expect(PM_TOOLS[0].name).toBe("save_product_spec_draft")
  })

  it("includes apply_product_spec_patch as second tool", () => {
    expect(PM_TOOLS[1].name).toBe("apply_product_spec_patch")
  })

  it("includes run_phase_completion_audit as third tool", () => {
    expect(PM_TOOLS[2].name).toBe("run_phase_completion_audit")
  })

  it("includes finalize_product_spec as fourth tool", () => {
    expect(PM_TOOLS[3].name).toBe("finalize_product_spec")
  })

  it("save_product_spec_draft requires content parameter", () => {
    const tool = PM_TOOLS.find(t => t.name === "save_product_spec_draft")!
    expect(tool.input_schema.required).toContain("content")
  })

  it("apply_product_spec_patch requires patch parameter", () => {
    const tool = PM_TOOLS.find(t => t.name === "apply_product_spec_patch")!
    expect(tool.input_schema.required).toContain("patch")
  })

  it("finalize_product_spec requires no parameters", () => {
    const tool = PM_TOOLS.find(t => t.name === "finalize_product_spec")!
    expect(tool.input_schema.required).toHaveLength(0)
  })
})

describe("buildPmSystemPrompt — spec link on approval-ready", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("requires Product Vision Updates section in every approved spec — non-negotiable enforcement", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Product Vision Updates")
    expect(prompt).toContain("PROPOSED ADDITION TO PRODUCT_VISION.md")
    expect(prompt).toContain("END PROPOSED ADDITION")
  })

  it("enforces Product Vision Updates section — explicitly states it is required in every spec", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Every approved feature spec must include the \"Product Vision Updates\" section")
  })

  it("cross-feature coherence — reads previously approved product specs before every response", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("cross-feature coherence")
  })

  it("injects approved feature specs when provided", () => {
    const contextWithSpecs = { ...baseContext, approvedFeatureSpecs: "# Login Spec\n## Problem\nUsers can't log in." }
    const prompt = buildPmSystemPrompt(contextWithSpecs, "onboarding")
    expect(prompt).toContain("Users can't log in.")
  })

  it("states first feature message when no approved specs available", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("No other approved product specs yet")
  })

  it("names the save_product_spec_draft tool", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("save_product_spec_draft")
  })

  it("names the apply_product_spec_patch tool", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("apply_product_spec_patch")
  })

  it("names the finalize_product_spec tool", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("finalize_product_spec")
  })
})

describe("buildPmSystemPrompt — PATCH enforcement rules", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })
  afterEach(() => { process.env = originalEnv })

  const draftContext: AgentContext = {
    ...baseContext,
    currentDraft: "## Problem\nHelp users onboard faster.",
  }

  it("PATCH is absolute — no exceptions phrase is present", () => {
    const prompt = buildPmSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("no exceptions")
  })

  it("prohibits confirm-then-ask pattern — agreement is the permission", () => {
    const prompt = buildPmSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("agreement is the permission")
  })

  it("enforces batch PATCH limit of 3 sections per response", () => {
    const prompt = buildPmSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("3 most significant")
    expect(prompt).toContain("more than 3 sections")
  })
})
