import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildDesignSystemPrompt,
  isCreateDesignSpecIntent,
  hasDraftDesignSpec,
  extractDraftDesignSpec,
  extractDesignSpecContent,
  hasEscalationOffer,
  extractEscalationQuestion,
  stripEscalationMarker,
  buildDesignStateResponse,
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

describe("cross-phase escalation helpers", () => {
  const withOffer = (q: string) =>
    `The design decision depends on a product call.\n\nThis is a product decision — want me to pull the PM in?\n\nOFFER_PM_ESCALATION_START\n${q}\nOFFER_PM_ESCALATION_END`

  describe("hasEscalationOffer", () => {
    it("returns true when both escalation markers are present", () => {
      expect(hasEscalationOffer(withOffer("Should social login be supported?"))).toBe(true)
    })

    it("returns false when markers are absent", () => {
      expect(hasEscalationOffer("This is a product decision — let's discuss.")).toBe(false)
    })

    it("returns false when only start marker is present", () => {
      expect(hasEscalationOffer("OFFER_PM_ESCALATION_START\nsome question")).toBe(false)
    })
  })

  describe("extractEscalationQuestion", () => {
    it("extracts the question between markers", () => {
      const response = withOffer("Should social login be supported?")
      expect(extractEscalationQuestion(response)).toBe("Should social login be supported?")
    })

    it("returns empty string when markers not present", () => {
      expect(extractEscalationQuestion("no markers here")).toBe("")
    })

    it("trims whitespace from extracted question", () => {
      const response = "text\nOFFER_PM_ESCALATION_START\n  question  \nOFFER_PM_ESCALATION_END"
      expect(extractEscalationQuestion(response)).toBe("question")
    })
  })

  describe("stripEscalationMarker", () => {
    it("removes the escalation marker block from the response", () => {
      const response = withOffer("Should social login be supported?")
      const stripped = stripEscalationMarker(response)
      expect(stripped).not.toContain("OFFER_PM_ESCALATION_START")
      expect(stripped).not.toContain("OFFER_PM_ESCALATION_END")
      expect(stripped).not.toContain("Should social login be supported?")
    })

    it("preserves the user-visible offer text", () => {
      const response = withOffer("Should social login be supported?")
      const stripped = stripEscalationMarker(response)
      expect(stripped).toContain("want me to pull the PM in")
    })

    it("returns unchanged string when no marker present", () => {
      const response = "Just a normal response."
      expect(stripEscalationMarker(response)).toBe(response)
    })
  })

  describe("buildDesignSystemPrompt — escalation instruction", () => {
    const originalEnv = process.env
    beforeEach(() => { process.env = { ...originalEnv, PRODUCT_NAME: "T", GITHUB_OWNER: "o", GITHUB_REPO: "r" } })
    afterEach(() => { process.env = originalEnv })

    it("instructs the agent to emit OFFER_PM_ESCALATION marker for blocking product questions", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("OFFER_PM_ESCALATION_START")
      expect(prompt).toContain("OFFER_PM_ESCALATION_END")
    })

    it("tells agent to offer escalation only for product decisions, not engineering or design calls", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("Only emit this marker when you are genuinely blocked on a product decision")
    })
  })
})

describe("approval-ready message in system prompt", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("prompt includes a direct link to the design spec on GitHub", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("https://github.com/o/r/blob/spec/onboarding-design/")
    expect(prompt).toContain("onboarding.design.md")
  })

  it("prompt tells agent an HTML preview has been saved alongside the spec", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("HTML preview")
  })

  it("prompt tells agent to direct designer to Slack message for preview link", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Slack message")
  })
})

// ─── buildDesignStateResponse ─────────────────────────────────────────────────
// These tests verify what the user actually sees in Slack for "current state?"
// queries — voice, structure, preview link, and CTA.

const SPEC_URL = "https://github.com/o/r/blob/spec/onboarding-design/specs/features/onboarding/onboarding.design.md"

const draftWithNonBlockingOnly = `# Onboarding — Design Spec

### Screen 1: Landing
Content here.

### Screen 2: Auth
Content here.

### Flow: US-1 — Sign up
Steps here.

### Flow: US-2 — Sign in
Steps here.

## Open Questions
- [type: engineering] [blocking: no] How does iOS Safari handle beforeunload?
- [type: design] [blocking: no] Wordmark size to confirm in Figma.
`

const draftWithBlocking = `# Onboarding — Design Spec

### Screen 1: Landing

## Open Questions
- [type: product] [blocking: yes] Which auth provider are we using?
- [type: engineering] [blocking: no] Session TTL trigger mechanism.
`

const draftNoQuestions = `# Onboarding — Design Spec

### Screen 1: Landing

## Open Questions
None.
`

describe("buildDesignStateResponse", () => {
  it("includes the spec URL", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).toContain(SPEC_URL)
  })

  it("shows screen and flow counts", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).toContain("2 screens")
    expect(result).toContain("2 flows")
  })

  it("includes preview link when previewUrl is provided and nothing is blocking", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL, previewUrl: "https://htmlpreview.github.io/?https://example.com/preview.html" })
    expect(result).toContain("htmlpreview.github.io")
  })

  it("omits preview link when previewUrl is not provided", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).not.toContain("htmlpreview.github.io")
  })

  it("CTA says 'approved' and mentions engineering", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).toContain("approved")
    expect(result).toContain("engineering")
  })

  it("lists non-blocking questions without type/blocking metadata tags", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).toContain("iOS Safari")
    expect(result).not.toContain("[type:")
    expect(result).not.toContain("[blocking:")
  })

  it("shows blocking warning when blocking questions exist", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithBlocking, specUrl: SPEC_URL })
    expect(result).toContain("Which auth provider")
  })

  it("handles no open questions — says ready to approve", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftNoQuestions, specUrl: SPEC_URL })
    expect(result).toContain("approved")
  })

  it("handles no draft — prompts to start", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: "", specUrl: SPEC_URL })
    expect(result).toContain("No design draft yet")
    expect(result).not.toContain(SPEC_URL)
  })
})
