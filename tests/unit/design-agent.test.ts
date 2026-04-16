import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  buildDesignSystemPrompt,
  buildDesignStateResponse,
  DESIGN_TOOLS,
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

  it("recommendation before question — prompt requires agent to state recommendation before asking", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    // Every question must include the agent's recommendation — user should never need to ask "what do you recommend?"
    expect(prompt).toContain("recommendation")
    expect(prompt).toContain("Never make the user ask")
    expect(prompt).toContain("what do you recommend")
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

  it("injects brand tokens when BRAND.md is present", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, brand: "--bg: #0A0A0F\n--violet: #7C6FCD" }, "onboarding")
    expect(prompt).toContain("--bg: #0A0A0F")
    expect(prompt).toContain("--violet: #7C6FCD")
  })

  it("brand tokens appear before the persona — model reads them first", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, brand: "--bg: #0A0A0F" }, "onboarding")
    const brandIdx = prompt.indexOf("--bg: #0A0A0F")
    const personaIdx = prompt.indexOf("## Who you are")
    expect(brandIdx).toBeGreaterThan(-1)
    expect(personaIdx).toBeGreaterThan(-1)
    expect(brandIdx).toBeLessThan(personaIdx)
  })

  it("states brand tokens are the production site values — agent must not ask for external URLs", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, brand: "--bg: #0A0A0F" }, "onboarding")
    expect(prompt).toContain("Do NOT ask for a Figma file")
    expect(prompt).toContain("these tokens ARE that website")
  })

  it("falls back gracefully when no BRAND.md — tells agent to use spec Brand section", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, brand: "" }, "onboarding")
    expect(prompt).toContain("No BRAND.md found")
  })

  it("bans asking for brand tokens when BRAND.md is present — explicit banned phrase", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Asking for brand tokens, Figma files")
  })

  it("bans 'I cannot extract values from a live website' — agent already has the values", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("I cannot extract values from a live website")
  })

  it("warns when no approved product spec found", () => {
    const prompt = buildDesignSystemPrompt({ ...baseContext, currentDraft: "" }, "onboarding")
    expect(prompt).toContain("No approved product spec found")
  })

  it("read-only mode activates READ-ONLY MODE block", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding", true)
    expect(prompt).toContain("READ-ONLY MODE")
    expect(prompt).toContain("Do not call any save tools or finalize tools")
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

  it("auto-save rule triggers after every agreed decision", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Save after every agreed decision")
  })

  it("response format constraint — ≤3 sentences when applying fixes", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("≤3 sentences")
  })

  it("response format constraint — prohibits restating platform notice content", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Do NOT restate, reformat, or list any [PLATFORM NOTICE] content")
  })

  it("response format constraint — ≤1 question when applying fixes", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("ask at most ONE")
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

  it("post-draft sign-off — prompt instructs agent to end with 'Draft saved to GitHub. Review it and say approved'", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("Draft saved to GitHub")
    expect(prompt).toContain("approved")
  })

  it("system prompt instructs agent to call offer_pm_escalation immediately — not ask permission first", () => {
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    expect(prompt).toContain("offer_pm_escalation")
    expect(prompt).toContain("immediately")
    // Old permission-asking patterns must not appear as instructions (they may appear in "do not" clauses)
    expect(prompt).not.toContain("want me to pull the PM")
    // The phrase "want me to flag it for the PM" appears only in a prohibition ("Do not ask...")
    expect(prompt).toContain('Do not ask "want me to flag it for the PM?"')
  })

  it("system prompt only references tools that exist in DESIGN_TOOLS", () => {
    // Catches the Step 13 regression class: tool mentioned in prompt but dropped from the array.
    const prompt = buildDesignSystemPrompt(baseContext, "onboarding")
    const toolNames = new Set(DESIGN_TOOLS.map(t => t.name))
    const promptToolRefs = [...prompt.matchAll(/`([a-z_]+)`/g)]
      .map(m => m[1])
      .filter(name => name.includes("_") && (
        name.endsWith("_spec") || name.endsWith("_draft") || name.endsWith("_patch") ||
        name.endsWith("_preview") || name.endsWith("_url") || name.endsWith("_escalation")
      ))
    for (const ref of promptToolRefs) {
      expect(toolNames, `System prompt references \`${ref}\` but it is not in DESIGN_TOOLS`).toContain(ref)
    }
  })
})

describe("DESIGN_TOOLS structure", () => {
  it("exports 8 tools", () => {
    expect(DESIGN_TOOLS).toHaveLength(8)
  })

  it("includes save_design_spec_draft as first tool", () => {
    expect(DESIGN_TOOLS[0].name).toBe("save_design_spec_draft")
  })

  it("includes apply_design_spec_patch as second tool", () => {
    expect(DESIGN_TOOLS[1].name).toBe("apply_design_spec_patch")
  })

  it("includes generate_design_preview as third tool", () => {
    expect(DESIGN_TOOLS[2].name).toBe("generate_design_preview")
  })

  it("includes fetch_url as fourth tool", () => {
    expect(DESIGN_TOOLS[3].name).toBe("fetch_url")
  })

  it("includes offer_pm_escalation as fifth tool", () => {
    expect(DESIGN_TOOLS[4].name).toBe("offer_pm_escalation")
  })

  it("includes offer_architect_escalation as sixth tool", () => {
    expect(DESIGN_TOOLS[5].name).toBe("offer_architect_escalation")
  })

  it("includes run_phase_completion_audit as seventh tool", () => {
    expect(DESIGN_TOOLS[6].name).toBe("run_phase_completion_audit")
  })

  it("includes finalize_design_spec as eighth tool", () => {
    expect(DESIGN_TOOLS[7].name).toBe("finalize_design_spec")
  })

  it("save_design_spec_draft requires content parameter", () => {
    const tool = DESIGN_TOOLS.find(t => t.name === "save_design_spec_draft")!
    expect(tool.input_schema.required).toContain("content")
  })

  it("apply_design_spec_patch requires patch parameter", () => {
    const tool = DESIGN_TOOLS.find(t => t.name === "apply_design_spec_patch")!
    expect(tool.input_schema.required).toContain("patch")
  })

  it("generate_design_preview requires specContent parameter", () => {
    const tool = DESIGN_TOOLS.find(t => t.name === "generate_design_preview")!
    expect(tool.input_schema.required).toContain("specContent")
  })

  it("fetch_url requires url parameter", () => {
    const tool = DESIGN_TOOLS.find(t => t.name === "fetch_url")!
    expect(tool.input_schema.required).toContain("url")
  })

  it("offer_pm_escalation requires question parameter", () => {
    const tool = DESIGN_TOOLS.find(t => t.name === "offer_pm_escalation")!
    expect(tool.input_schema.required).toContain("question")
  })

  it("finalize_design_spec requires no parameters", () => {
    const tool = DESIGN_TOOLS.find(t => t.name === "finalize_design_spec")!
    expect(tool.input_schema.required).toHaveLength(0)
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

  it("handles no draft — shows 'no committed spec' with PENDING section", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: "", specUrl: SPEC_URL })
    expect(result).toContain("No committed spec yet")
    expect(result).toContain("PENDING")
    expect(result).not.toContain(SPEC_URL)
  })

  it("no-draft path: shows 'No open items' when no uncommitted decisions", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: "", specUrl: SPEC_URL })
    expect(result).toContain("No open items from prior conversations")
  })

  it("no-draft path: shows uncommitted decisions when provided", () => {
    const decisions = "1. Use system-ui font\n2. Nav 52px"
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: "", specUrl: SPEC_URL, uncommittedDecisions: decisions })
    expect(result).toContain("PENDING")
    expect(result).toContain("system-ui font")
    expect(result).toContain("save those")
  })

  it("shows bold summary statement from Design Direction — not raw bullet lists", () => {
    // Design Direction: bold statements are the intentional high-level summary.
    // Bullet lists (color tokens, rules) are implementation detail — they belong in the spec link.
    const draftWithDirection = `# Onboarding — Design Spec

## Design Direction
**Dark mode primary — Archon Labs aesthetic.** Visual language: minimal, high negative space.
**Color palette:**
- \`--bg: #0A0A0F\` — deep near-black
- \`--accent: #7C6FCD\` — violet

### Screen 1: Landing

## Open Questions
None.
`
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithDirection, specUrl: SPEC_URL })
    // Bold summary statement is shown
    expect(result).toContain("Committed decisions")
    expect(result).toContain("Dark mode primary")
    expect(result).toContain("Archon Labs aesthetic")
    // Bullet list items are NOT in the response — they're in the spec link
    expect(result).not.toContain("--bg: #0A0A0F")
    expect(result).not.toContain("--accent: #7C6FCD")
    // Pointer to full spec is shown
    expect(result).toContain("see spec link above")
  })

  it("omits committed decisions block when Design Direction has no bold summary statements", () => {
    // A Direction section with only bullet lists and no bold sentence produces no key decisions.
    const draftWithDirection = `# Onboarding — Design Spec

## Design Direction
Dark mode, Archon Labs aesthetic. #0A0A0F background, pulsing glow treatment.
High contrast, minimal, single-metric-forward.

### Screen 1: Landing

## Open Questions
None.
`
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithDirection, specUrl: SPEC_URL })
    // No bold sentences → no committed decisions block shown
    expect(result).not.toContain("Committed decisions")
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

  it("PENDING section always present — shows 'No open items' when nothing uncommitted", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).toContain("PENDING")
    expect(result).toContain("No open items from prior conversations")
  })

  it("shows PENDING section and gates CTA when uncommittedDecisions provided", () => {
    const decisions = "1. Use system-ui font stack exactly as on getarchon.dev\n2. Nav bar height 52px, not 44px"
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL, uncommittedDecisions: decisions })
    expect(result).toContain("PENDING")
    expect(result).toContain("system-ui font")
    expect(result).toContain("save those")
    // CTA must block approval when uncommitted decisions exist
    expect(result).toContain("Save the pending decisions above first")
    expect(result).not.toContain("Say *approved*")
  })

  it("CTA gates on blocking questions when no uncommitted decisions", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithBlocking, specUrl: SPEC_URL })
    expect(result).toContain("Resolve the blocking question")
    expect(result).not.toContain("Say *approved*")
  })

  it("CTA offers approval only when all gates are clear", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftNoQuestions, specUrl: SPEC_URL })
    expect(result).toContain("Say *approved* to move to engineering")
  })

  it("shows spec gap section when specGap is provided", () => {
    const gap = "The spec implies session expiry warnings for unauthenticated users, but the Product Vision does not address session management."
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL, specGap: gap })
    expect(result).toContain("Spec gap")
    expect(result).toContain("session expiry")
    expect(result).toContain("update the product vision")
  })

  it("omits spec gap section when specGap is null", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL, specGap: null })
    expect(result).not.toContain("Spec gap")
  })

  it("omits spec gap section when specGap is omitted", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithNonBlockingOnly, specUrl: SPEC_URL })
    expect(result).not.toContain("Spec gap")
  })

  it("CTA gates on openItemCount when no blocking questions and no uncommitted decisions", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftNoQuestions, specUrl: SPEC_URL, openItemCount: 8 })
    expect(result).toContain("Resolve the 8 open items below")
    expect(result).toContain("then say *approved* to move to engineering")
    expect(result).not.toContain("Say *approved* to move to engineering")
  })

  it("CTA gates on openItemCount=1 with singular wording", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftNoQuestions, specUrl: SPEC_URL, openItemCount: 1 })
    expect(result).toContain("Resolve the 1 open item below")
    // CTA uses singular "item" not "items"
    expect(result).not.toContain("1 open items")
  })

  it("CTA offers approval when openItemCount is 0", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftNoQuestions, specUrl: SPEC_URL, openItemCount: 0 })
    expect(result).toContain("Say *approved* to move to engineering")
  })

  it("openItemCount does not gate approval when blocking questions also present (blocking has higher priority)", () => {
    const result = buildDesignStateResponse({ featureName: "onboarding", draftContent: draftWithBlocking, specUrl: SPEC_URL, openItemCount: 5 })
    expect(result).toContain("Resolve the blocking question")
    expect(result).not.toContain("Resolve the 5 open items")
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
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("no exceptions")
  })

  it("'new html' and 'full rewrite' map to PATCH not DRAFT", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("new html")
    expect(prompt).toContain("full rewrite")
  })

  it("prompt states HTML preview is regenerated on patch saves", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("HTML preview")
    expect(prompt).toContain("regenerates the HTML preview")
  })

  it("prohibits confirm-then-ask pattern — agreement is the permission", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("agreement is the permission")
  })

  it("enforces batch patch limit of 3 sections per response", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("3 most significant")
    expect(prompt).toContain("more than 3 sections")
  })

  it("handles HTML rendering feedback by patching spec — not suggesting to skip preview", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("No options. No asking permission.")
    expect(prompt).toContain("Fix the spec")
  })

  it("prohibits platform diagnosis — designer must not call renderer fundamentally broken", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("You are a designer, not a platform engineer")
  })

  it("brand drift protocol — instructs agent to cross-reference spec tokens against BRAND.md when user says preview doesn't match brand", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("brand token drift")
    expect(prompt).toContain("Cross-reference every color token")
    expect(prompt).toContain("BRAND.md is extracted from the production site")
  })

  it("brand drift protocol — requires transparency about what drifted before patching", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("Never silently fix the preview without surfacing the drift")
    expect(prompt).toContain("Approve and I'll patch the spec to align with BRAND.md")
  })

  it("brand drift protocol — prohibits asking user to screenshot website or provide external references", () => {
    // Root cause: agent asked user to "open getarchon.dev and screenshot" when
    // it couldn't see the live site. BRAND.md is the authority. The agent must
    // never fall back to asking for external references.
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("BRAND.md is the authority. Always.")
    expect(prompt).toContain("Do NOT ask the user to")
    expect(prompt).toContain("screenshot")
    expect(prompt).toContain("external URL")
  })

  it("brand drift protocol — agent infers correct values from plain-English description, never asks user for hex codes", () => {
    // The user cannot be expected to know hex values — that is the agent's job.
    // When the spec matches BRAND.md but the preview still looks wrong, the agent
    // should ask the user to describe what looks off, then infer and propose values.
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("The user cannot be expected to know hex values")
    expect(prompt).toContain("Describe what looks off")
    expect(prompt).toContain("infer what BRAND.md might have wrong")
    expect(prompt).toContain("Never ask the user to give you the hex code")
  })

  it("distinguishes preview-before-agreeing from agreed render — uses generate_design_preview for pre-decision previews", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("generate_design_preview")
    expect(prompt).toContain("nothing is saved to GitHub")
  })

  it("instructs agent to use generate_design_preview when uncertain — always safe to preview without committing", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("When uncertain, use")
    expect(prompt).toContain("generate_design_preview")
  })

  it("rule 8 — renderAmbiguities are blocking: agent must fix every one before next response", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("renderAmbiguities")
    expect(prompt).toContain("Render ambiguities are blocking")
    expect(prompt).toContain("must address every one before the next response")
  })

  it("rule 9 — [PROPOSED ADDITION] blocks surface as numbered decisions with recommendations", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("[PROPOSED ADDITION]")
    expect(prompt).toContain("Unresolved proposals are not spec")
    expect(prompt).toContain("numbered")
    expect(prompt).toContain("My recommendation")
  })

  it("escalation rule — consolidate all PM gaps into single tool call and stop after CTA", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    // Single consolidated call — not multiple
    expect(prompt).toContain("exactly once")
    expect(prompt).toContain("ALL blocking questions consolidated")
    // Hard stop after CTA — no roadmap preview
    expect(prompt).toContain("Then stop")
    expect(prompt).toContain("do NOT list brand drift items")
  })

  it("save tool descriptions mention renderAmbiguities return value", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    const saveToolIdx = prompt.indexOf("save_design_spec_draft")
    const patchToolIdx = prompt.indexOf("apply_design_spec_patch")
    expect(saveToolIdx).toBeGreaterThan(-1)
    expect(patchToolIdx).toBeGreaterThan(-1)
    // renderAmbiguities must appear in each tool's description
    expect(prompt.slice(saveToolIdx).indexOf("renderAmbiguities")).toBeGreaterThan(-1)
    expect(prompt.slice(patchToolIdx).indexOf("renderAmbiguities")).toBeGreaterThan(-1)
  })
})

describe("buildDesignSystemPrompt — domain boundary", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, PRODUCT_NAME: "TestApp", GITHUB_OWNER: "o", GITHUB_REPO: "r", TARGET_FORM_FACTORS: "mobile" }
  })
  afterEach(() => { process.env = originalEnv })

  const draftContext: AgentContext = {
    ...baseContext,
    currentDraft: "## Approved Product Spec\nSpec.\n\n## Current Design Draft\n# Onboarding — Design Spec\n\n## Design Direction\nMinimal.",
  }

  it("has an explicit domain boundary section", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("Domain boundary")
    expect(prompt).toContain("what you never own")
  })

  it("designer owns copy — PM defines intent, designer writes the words", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt.toLowerCase()).toMatch(/pm defines intent|designer.*writes.*words|designer owns.*copy|you own.*copy/)
  })

  it("product behavior decisions are explicitly routed to PM via offer_pm_escalation", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("offer_pm_escalation")
    // Must explicitly route product behavior decisions to PM, not just mention the tool
    expect(prompt.toLowerCase()).toMatch(/product behavior|pm owns.*product|product.*pm owns/)
  })

  it("architectural constraints are routed to offer_architect_escalation or Design Assumptions", () => {
    const prompt = buildDesignSystemPrompt(draftContext, "onboarding")
    expect(prompt).toContain("offer_architect_escalation")
    expect(prompt).toContain("Design Assumptions")
  })
})
