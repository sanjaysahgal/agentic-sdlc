import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildDesignSystemPrompt,
  isCreateDesignSpecIntent,
  hasDraftDesignSpec,
  extractDraftDesignSpec,
  extractDesignSpecContent,
} from "../../agents/design"
import type { AgentContext } from "../../runtime/context-loader"

const baseContext: AgentContext = {
  productVision: "We help teams ship faster.",
  systemArchitecture: "Next.js, tRPC, Prisma.",
  featureConventions: "",
  currentDraft: "",
}

describe("buildDesignSystemPrompt", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("question is last — prompt instructs agent not to trail with a closing line after the question", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("The question is the last thing in your response")
  })

  it("leads with proposal — prompt instructs agent to open with a structural opinion, not discovery questions", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("open with a concrete structural proposal")
  })

  it("enforces flows before screens", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Flows before screens")
  })

  it("enforces states before components", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("States before components")
  })

  it("includes featureName in channel scope", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("onboarding")
  })

  it("redirects out-of-scope questions to main channel", () => {
    process.env.SLACK_MAIN_CHANNEL = "all-testapp"
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("all-testapp")
  })

  it("injects approved product spec when present", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, currentDraft: "## Problem\nHelp users onboard." }, "onboarding")
    expect(prompt).toContain("Help users onboard.")
  })

  it("warns when no approved product spec found", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, currentDraft: "" }, "onboarding")
    expect(prompt).toContain("No approved product spec found")
  })

  it("read-only mode suppresses draft and approval markers", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding", true)
    expect(prompt).toContain("READ-ONLY MODE")
    expect(prompt).toContain("DRAFT_DESIGN_SPEC_START")  // marker is named in the prohibition
  })

  it("prohibits permission-asking — shall I, would you like me to, want me to, happy to, what would you like to do", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Shall I")
    expect(prompt).toContain("Would you like me to")
    expect(prompt).toContain("Want me to")
    expect(prompt).toContain("Happy to")
    expect(prompt).toContain("What would you like to do")
    expect(prompt).toContain("Permission-asking is a failure")
  })

  it("prohibits ASCII tables — no pipe-and-dash markdown tables in Slack responses", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Never use ASCII tables")
  })

  it("auto-save rule triggers after every agreed decision, not just when spec is substantial", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Save a draft after EVERY response")
  })

  it("short reply re-read rule — re-read last question before interpreting a short reply", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("re-read the last question you asked")
  })
})

describe("isCreateDesignSpecIntent", () => {
  it("returns true when response contains INTENT: CREATE_DESIGN_SPEC", () => {
    expect(isCreateDesignSpecIntent("INTENT: CREATE_DESIGN_SPEC\n# Onboarding — Design Spec")).toBe(true)
  })

  it("returns false when marker is absent", () => {
    expect(isCreateDesignSpecIntent("Looks good, let's move forward.")).toBe(false)
  })

  it("returns false for product spec marker", () => {
    expect(isCreateDesignSpecIntent("INTENT: CREATE_SPEC")).toBe(false)
  })
})

describe("hasDraftDesignSpec", () => {
  it("returns true when both markers present", () => {
    const response = "Here is the draft:\nDRAFT_DESIGN_SPEC_START\ncontent\nDRAFT_DESIGN_SPEC_END"
    expect(hasDraftDesignSpec(response)).toBe(true)
  })

  it("returns false when only start marker present", () => {
    expect(hasDraftDesignSpec("DRAFT_DESIGN_SPEC_START\ncontent")).toBe(false)
  })

  it("returns false when neither marker present", () => {
    expect(hasDraftDesignSpec("Just a regular response.")).toBe(false)
  })

  it("returns false for product spec markers", () => {
    expect(hasDraftDesignSpec("DRAFT_SPEC_START\ncontent\nDRAFT_SPEC_END")).toBe(false)
  })
})

describe("extractDraftDesignSpec", () => {
  it("extracts content between markers", () => {
    const response = "Some text\nDRAFT_DESIGN_SPEC_START\n# Design Spec\ncontent here\nDRAFT_DESIGN_SPEC_END\nMore text"
    expect(extractDraftDesignSpec(response)).toBe("# Design Spec\ncontent here")
  })

  it("returns empty string when markers not found", () => {
    expect(extractDraftDesignSpec("no markers here")).toBe("")
  })

  it("trims whitespace from extracted content", () => {
    const response = "DRAFT_DESIGN_SPEC_START\n  content  \nDRAFT_DESIGN_SPEC_END"
    expect(extractDraftDesignSpec(response)).toBe("content")
  })
})

describe("extractDesignSpecContent", () => {
  it("extracts content from code block", () => {
    const response = "INTENT: CREATE_DESIGN_SPEC\n```\n# Design Spec\nFigma: TBD\n```"
    expect(extractDesignSpecContent(response)).toBe("# Design Spec\nFigma: TBD")
  })

  it("falls back to stripping marker when no code block", () => {
    const response = "INTENT: CREATE_DESIGN_SPEC\n# Design Spec\nFigma: TBD"
    expect(extractDesignSpecContent(response)).toBe("# Design Spec\nFigma: TBD")
  })
})

describe("approval-ready visualisation offer", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("prompt tells agent to offer Figma AI as a visualisation option when approval-ready", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Figma AI")
    expect(prompt).toContain("Make Designs")
  })

  it("prompt includes a direct link to the design spec on GitHub", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("https://github.com/o/r/blob/spec/onboarding-design/")
    expect(prompt).toContain("onboarding.design.md")
  })

  it("prompt tells agent to offer Builder.io or Anima as a second option", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Builder.io")
    expect(prompt).toContain("Anima")
  })

  it("prompt tells agent the offer is one-time and not a prompt for discussion", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("one-time offer")
  })
})
