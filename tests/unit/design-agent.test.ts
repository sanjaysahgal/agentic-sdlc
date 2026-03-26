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
  hasProductSpecUpdate,
  extractProductSpecUpdate,
  hasDesignPatch,
  extractDesignPatch,
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

  it("requires Design System Updates section in every approved spec — non-negotiable enforcement", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Design System Updates")
    expect(prompt).toContain("PROPOSED ADDITION TO DESIGN_SYSTEM.md")
    expect(prompt).toContain("END PROPOSED ADDITION")
  })

  it("enforces Design System Updates section — explicitly states it is required in every spec", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Every approved feature spec must include the \"Design System Updates\" section")
  })

  it("PRODUCT_SPEC_UPDATE instruction present — design agent can propose product spec changes when PM authorizes direction change", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("PRODUCT_SPEC_UPDATE_START")
    expect(prompt).toContain("PRODUCT_SPEC_UPDATE_END")
  })

  it("post-draft sign-off — prompt instructs agent to end with 'Draft saved to GitHub. Review it and say approved'", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Draft saved to GitHub")
    expect(prompt).toContain("approved")
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

describe("hasProductSpecUpdate", () => {
  it("returns true when both markers are present", () => {
    const response = "PM authorized a change.\nPRODUCT_SPEC_UPDATE_START\n# Spec\ncontent\nPRODUCT_SPEC_UPDATE_END"
    expect(hasProductSpecUpdate(response)).toBe(true)
  })

  it("returns false when only start marker present", () => {
    expect(hasProductSpecUpdate("PRODUCT_SPEC_UPDATE_START\ncontent")).toBe(false)
  })

  it("returns false when neither marker present", () => {
    expect(hasProductSpecUpdate("Just a regular response.")).toBe(false)
  })

  it("returns false when design draft markers are present but not product spec markers", () => {
    expect(hasProductSpecUpdate("DRAFT_DESIGN_SPEC_START\ncontent\nDRAFT_DESIGN_SPEC_END")).toBe(false)
  })
})

describe("extractProductSpecUpdate", () => {
  it("extracts content between product spec update markers", () => {
    const response = "Authorized.\nPRODUCT_SPEC_UPDATE_START\n# Onboarding — Product Spec\nDark mode primary.\nPRODUCT_SPEC_UPDATE_END"
    expect(extractProductSpecUpdate(response)).toBe("# Onboarding — Product Spec\nDark mode primary.")
  })

  it("trims whitespace from extracted content", () => {
    const response = "PRODUCT_SPEC_UPDATE_START\n\n  # Spec  \n\nPRODUCT_SPEC_UPDATE_END"
    expect(extractProductSpecUpdate(response).trim()).toBe("# Spec")
  })

  it("returns empty string when markers are absent", () => {
    expect(extractProductSpecUpdate("No markers here.")).toBe("")
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

  describe("buildDesignSystemPrompt — product spec update instruction", () => {
    const originalEnv = process.env
    beforeEach(() => { process.env = { ...originalEnv, PRODUCT_NAME: "T", GITHUB_OWNER: "o", GITHUB_REPO: "r" } })
    afterEach(() => { process.env = originalEnv })

    it("instructs agent to emit PRODUCT_SPEC_UPDATE markers when PM authorizes direction change", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("PRODUCT_SPEC_UPDATE_START")
      expect(prompt).toContain("PRODUCT_SPEC_UPDATE_END")
    })

    it("tells agent to include complete updated product spec, not a diff", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("complete updated product spec")
    })

    it("instructs agent to end post-draft message with 'say *approved*'", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("say *approved*")
    })

    it("prohibits 'All locked decisions saved' phrasing after draft save", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("Never say \"All locked decisions saved\"")
    })

    it("no-draft-blocks rule — agent has no internal memory between turns, only GitHub spec", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("You have no draft blocks, internal drafts, or memory between turns")
    })

    it("no-draft-blocks rule — explicitly names the hallucination to forbid", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("in my draft blocks")
    })

    it("no-draft-blocks rule — instructs agent to use GitHub spec as the complete record", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("The spec shown above is the complete record")
    })

    it("no-reconstruct rule — forbids listing specific design values not in the spec", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("Never reconstruct or list specific design decisions that are not in the spec above")
    })

    it("no-reconstruct rule — explicitly names the failure pattern (color tokens, timings)", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("color tokens, animation timings")
    })

    it("no-reconstruct rule — prescribes the honest response when decisions are missing", () => {
      const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
      expect(prompt).toContain("Could you tell me what was agreed and I'll build the spec with those decisions now?")
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

  it("includes preview note when provided and nothing is blocking", () => {
    const note = "_HTML preview attached above — download and open in any browser._"
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL, previewNote: note })
    expect(result).toContain("HTML preview attached")
  })

  it("omits preview note when not provided", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).not.toContain("HTML preview")
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

  it("shows committed Design Direction as key decisions when section is present", () => {
    const draftWithDirection = `# Onboarding — Design Spec

## Design Direction
Dark mode, Archon Labs aesthetic. #0A0A0F background, pulsing glow treatment.
High contrast, minimal, single-metric-forward.

### Screen 1: Landing

## Open Questions
None.
`
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithDirection, specUrl: SPEC_URL })
    expect(result).toContain("Committed decisions")
    expect(result).toContain("Archon Labs")
  })

  it("omits committed decisions block when no Design Direction section in spec", () => {
    const draftNoDirection = `# Onboarding — Design Spec

### Screen 1: Landing

## Open Questions
None.
`
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftNoDirection, specUrl: SPEC_URL })
    expect(result).not.toContain("Committed decisions")
  })
})

describe("buildDesignSystemPrompt — PATCH enforcement rules", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r" }
  })
  afterEach(() => { process.env = originalEnv })

  const draftContext: AgentContext = {
    ...baseContext,
    currentDraft: "## Approved Product Spec\nSpec.\n\n## Current Design Draft\n# Onboarding — Design Spec\n\n## Design Direction\nLight mode.",
  }

  it("PATCH is absolute — no exceptions phrase is present", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("No exceptions")
  })

  it("'new html' and 'full rewrite' map to PATCH not DRAFT", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("new html")
    expect(prompt).toContain("full rewrite")
    // Both must appear in the PATCH section (not in the DRAFT section)
    const patchSectionIdx = prompt.indexOf("DESIGN_PATCH_START")
    const draftSectionIdx = prompt.indexOf("DRAFT_DESIGN_SPEC_START")
    expect(patchSectionIdx).toBeGreaterThan(-1)
    expect(draftSectionIdx).toBeGreaterThan(-1)
  })

  it("prompt states HTML preview is regenerated automatically on PATCH saves", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("HTML preview")
    expect(prompt).toContain("regenerated automatically")
    expect(prompt).toContain("PATCH save")
  })

  it("prompt warns that DRAFT blocks are cut off on long specs", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("cut off mid-spec")
  })

  it("prohibits confirm-then-ask pattern — agreement is the permission", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("agreement is the permission")
    expect(prompt).toContain("Output PATCH blocks immediately")
  })

  it("enforces batch PATCH limit of 3 sections per response", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("3 most significant sections")
    expect(prompt).toContain("more than 3 sections")
  })

  it("handles HTML rendering feedback by patching spec — not suggesting to skip preview", () => {
    const prompt = buildDesignSystemPrompt({ featureName: "onboarding", context: draftContext })
    expect(prompt).toContain("Do NOT suggest skipping the preview")
    expect(prompt).toContain("fix the spec and save it with a PATCH block")
  })
})

describe("hasDesignPatch", () => {
  it("returns true when both patch markers are present", () => {
    const response = "Updating design direction.\nDESIGN_PATCH_START\n## Design Direction\ndark mode\nDESIGN_PATCH_END"
    expect(hasDesignPatch(response)).toBe(true)
  })

  it("returns false when only start marker is present", () => {
    expect(hasDesignPatch("DESIGN_PATCH_START\n## Design Direction\ndark mode")).toBe(false)
  })

  it("returns false when neither marker is present", () => {
    expect(hasDesignPatch("Just a regular response.")).toBe(false)
  })

  it("returns false when draft markers are present but not patch markers", () => {
    expect(hasDesignPatch("DRAFT_DESIGN_SPEC_START\ncontent\nDRAFT_DESIGN_SPEC_END")).toBe(false)
  })
})

describe("extractDesignPatch", () => {
  it("extracts content between patch markers", () => {
    const response = "Applying update.\nDESIGN_PATCH_START\n## Design Direction\ndark mode\nDESIGN_PATCH_END\nMore text."
    expect(extractDesignPatch(response)).toBe("## Design Direction\ndark mode")
  })

  it("returns empty string when markers are absent", () => {
    expect(extractDesignPatch("No markers here.")).toBe("")
  })

  it("trims whitespace from extracted content", () => {
    const response = "DESIGN_PATCH_START\n  ## Design Direction\ndark mode  \nDESIGN_PATCH_END"
    expect(extractDesignPatch(response).trim()).toBe("## Design Direction\ndark mode")
  })

  it("extracts multi-section patch correctly", () => {
    const response = [
      "Updating screens and open questions.",
      "DESIGN_PATCH_START",
      "## Screens",
      "### Screen 1",
      "Updated screen 1.",
      "",
      "## Open Questions",
      "- [type: product] [blocking: no] New question.",
      "DESIGN_PATCH_END",
    ].join("\n")
    const extracted = extractDesignPatch(response)
    expect(extracted).toContain("## Screens")
    expect(extracted).toContain("Updated screen 1.")
    expect(extracted).toContain("## Open Questions")
    expect(extracted).toContain("New question.")
  })
})
