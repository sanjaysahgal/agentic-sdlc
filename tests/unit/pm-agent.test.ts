import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  isCreateSpecIntent,
  hasDraftSpec,
  extractDraftSpec,
  extractSpecContent,
  buildPmSystemPrompt,
  hasPmPatch,
  extractPmPatch,
} from "../../agents/pm"
import type { AgentContext } from "../../runtime/context-loader"

const baseContext: AgentContext = {
  productVision: "We help teams ship faster.",
  systemArchitecture: "Next.js, tRPC, Prisma.",
  featureConventions: "",
  currentDraft: "",
}

describe("isCreateSpecIntent", () => {
  it("returns true when response contains INTENT: CREATE_SPEC", () => {
    expect(isCreateSpecIntent("INTENT: CREATE_SPEC\n\n# Feature — Product Spec")).toBe(true)
  })

  it("returns false when marker is absent", () => {
    expect(isCreateSpecIntent("Looks good! Let me summarize the spec.")).toBe(false)
  })

  it("returns false for partial match (marker must be exact)", () => {
    expect(isCreateSpecIntent("INTENT: create_spec")).toBe(false)
    expect(isCreateSpecIntent("CREATE_SPEC")).toBe(false)
  })
})

describe("hasDraftSpec", () => {
  it("returns true when both markers are present", () => {
    const response = "Here is the draft:\nDRAFT_SPEC_START\n# Spec\nDRAFT_SPEC_END"
    expect(hasDraftSpec(response)).toBe(true)
  })

  it("returns false when only start marker is present", () => {
    expect(hasDraftSpec("DRAFT_SPEC_START\n# Spec")).toBe(false)
  })

  it("returns false when only end marker is present", () => {
    expect(hasDraftSpec("# Spec\nDRAFT_SPEC_END")).toBe(false)
  })

  it("returns false when neither marker is present", () => {
    expect(hasDraftSpec("Just a regular response with no draft.")).toBe(false)
  })
})

describe("extractDraftSpec", () => {
  it("extracts spec content between the markers", () => {
    const response = "Some text\nDRAFT_SPEC_START\n# Onboarding — Product Spec\n\n## Problem\nX\nDRAFT_SPEC_END\nMore text"
    const result = extractDraftSpec(response)
    expect(result).toBe("# Onboarding — Product Spec\n\n## Problem\nX")
  })

  it("trims whitespace from extracted content", () => {
    const response = "DRAFT_SPEC_START\n\n  # Spec  \n\nDRAFT_SPEC_END"
    expect(extractDraftSpec(response)).toBe("# Spec")
  })

  it("returns empty string when markers are absent", () => {
    expect(extractDraftSpec("No draft here.")).toBe("")
  })
})

describe("extractSpecContent", () => {
  it("extracts content from first fenced code block", () => {
    const response = "INTENT: CREATE_SPEC\n```markdown\n# Feature Spec\n\n## Problem\nY\n```"
    expect(extractSpecContent(response)).toBe("# Feature Spec\n\n## Problem\nY")
  })

  it("falls back to full response minus INTENT marker when no code block", () => {
    const response = "INTENT: CREATE_SPEC\n# Feature Spec\n\n## Problem\nZ"
    expect(extractSpecContent(response)).toContain("# Feature Spec")
    expect(extractSpecContent(response)).not.toContain("INTENT: CREATE_SPEC")
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

  it("includes a GitHub link to the draft spec when the spec is approval-ready", () => {
    const prompt = buildPmSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("https://github.com/o/r/blob/spec/onboarding-product/")
    expect(prompt).toContain("onboarding.product.md")
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
})

describe("hasPmPatch", () => {
  it("returns true when both patch markers are present", () => {
    expect(hasPmPatch("PRODUCT_PATCH_START\n## Problem\nUpdated.\nPRODUCT_PATCH_END")).toBe(true)
  })

  it("returns false when only start marker is present", () => {
    expect(hasPmPatch("PRODUCT_PATCH_START\n## Problem\nUpdated.")).toBe(false)
  })

  it("returns false when neither marker is present", () => {
    expect(hasPmPatch("Just a regular PM response.")).toBe(false)
  })

  it("returns false when DRAFT markers are present but not PATCH markers", () => {
    expect(hasPmPatch("DRAFT_SPEC_START\ncontent\nDRAFT_SPEC_END")).toBe(false)
  })
})

describe("extractPmPatch", () => {
  it("extracts content between patch markers", () => {
    const response = "Updating goals.\nPRODUCT_PATCH_START\n## Goals\nNew goals here.\nPRODUCT_PATCH_END\nMore text."
    expect(extractPmPatch(response)).toBe("## Goals\nNew goals here.")
  })

  it("returns empty string when markers are absent", () => {
    expect(extractPmPatch("No markers here.")).toBe("")
  })

  it("extracts multi-section patch correctly", () => {
    const response = [
      "PRODUCT_PATCH_START",
      "## Goals",
      "Updated goals.",
      "",
      "## Non-Goals",
      "Updated non-goals.",
      "PRODUCT_PATCH_END",
    ].join("\n")
    const extracted = extractPmPatch(response)
    expect(extracted).toContain("## Goals")
    expect(extracted).toContain("Updated goals.")
    expect(extracted).toContain("## Non-Goals")
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
    expect(prompt).toContain("No exceptions")
  })

  it("prompt warns that DRAFT blocks are cut off on long specs", () => {
    const prompt = buildPmSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("cut off mid-spec")
  })
})
