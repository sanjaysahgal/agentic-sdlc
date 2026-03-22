import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  isCreateSpecIntent,
  hasDraftSpec,
  extractDraftSpec,
  extractSpecContent,
  buildPmSystemPrompt,
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
})
