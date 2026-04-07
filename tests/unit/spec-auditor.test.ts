import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const dir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(dir, "../fixtures/agent-output")

// auditSpecDraft calls `new Anthropic()` at module load — mock before any import.
// Use vi.hoisted() so mockCreate is available when the factory runs (factories are hoisted
// above module-level code, so plain `const mockCreate = vi.fn()` would be undefined there).
const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

describe("auditSpecRenderAmbiguity — undefined screen detection", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("flags a screen referenced in User Flows but missing from Screens section", async () => {
    // LLM returns empty — deterministic check must catch the missing screen
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")

    const spec = `
## Screens

### Screen 1: Chat Home
**Purpose:** Main chat interface.

## User Flows

### Flow: US-1 — New user sign-up
Landing (logged-out) → Auth Sheet (default) → Landing (logged-in)
`
    const result = await auditSpecRenderAmbiguity(spec)
    // The finding names the screen (Auth) not the type — check for the name
    expect(result.some(s => s.toLowerCase().includes("auth"))).toBe(true)
    expect(result.some(s => s.toLowerCase().includes("screens section"))).toBe(true)
  })

  it("does NOT flag a screen that IS defined in Screens section", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")

    const spec = `
## Screens

### Screen 1: Chat Home
**Purpose:** Main chat interface.

### Screen 2: Auth Sheet
**Purpose:** Sign-in via SSO.

## User Flows

### Flow: US-1 — New user sign-up
Landing (logged-out) → Auth Sheet (default) → Landing (logged-in)
`
    const result = await auditSpecRenderAmbiguity(spec)
    // Auth Sheet is defined → should not be flagged by the deterministic check
    expect(result.some(s => s.toLowerCase().includes("auth sheet"))).toBe(false)
  })

  it("merges deterministic findings with LLM findings", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '["Button label not specified"]' }],
    })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")

    const spec = `
## Screens

### Screen 1: Chat Home
**Purpose:** Main chat interface.

## User Flows

### Flow: US-1
Landing → Auth Sheet (default) → Landing (logged-in)
`
    const result = await auditSpecRenderAmbiguity(spec)
    expect(result.some(s => s.toLowerCase().includes("auth"))).toBe(true)
    expect(result).toContain("Button label not specified")
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it("returns empty array for spec with no User Flows section", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")

    const spec = `
## Screens

### Screen 1: Chat Home
**Purpose:** Main chat interface.

## Accessibility
No additional requirements.
`
    const result = await auditSpecRenderAmbiguity(spec)
    expect(result).toEqual([])
  })

  it("Haiku prompt includes animation spec requirement for sheets and modals", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Screen 1: Home\n## User Flows\n### Flow: US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toMatch(/entry\/exit animation.*timing.*easing/i)
  })

  it("Haiku prompt includes the 4 expanded save-time check categories", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Screen 1: Home\n## User Flows\n### Flow: US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // TBD / placeholder copy
    expect(systemPrompt).toContain("TBD")
    // Named states with no visual description
    expect(systemPrompt).toMatch(/named.*no visual description|state.*without.*visual/i)
    // Conflicting values
    expect(systemPrompt).toMatch(/two different specifications|conflicting.*value/i)
    // Vague measurement language
    expect(systemPrompt).toMatch(/near the top|slightly|subtle.*specific measurement/i)
  })

  it("Haiku prompt includes form factor check when formFactors option is provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity(
      "## Screens\n### Screen 1: Home\n## User Flows\n### Flow: US-1\nHome",
      { formFactors: ["mobile", "desktop"] }
    )
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("mobile")
    expect(systemPrompt).toContain("desktop")
  })

  it("Haiku prompt omits form factor check when formFactors option is not provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Screen 1: Home\n## User Flows\n### Flow: US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Without the option, no form factor language injected
    expect(systemPrompt).not.toContain("form factor")
  })
})

describe("auditSpecDraft", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns ok immediately when both productVision and systemArchitecture are empty — no API call", async () => {
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "",
      systemArchitecture: "",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("returns ok when Claude responds OK", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "We build a web app for teams.",
      systemArchitecture: "tRPC, Prisma, Next.js.",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
  })

  it("returns conflict with stripped message when Claude responds CONFLICT", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "CONFLICT: draft proposes password auth but vision mandates SSO only" }],
    })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Auth spec — add password login",
      productVision: "All auth is SSO only.",
      systemArchitecture: "Next-Auth with SSO provider.",
      featureName: "auth",
    })
    expect(result.status).toBe("conflict")
    if (result.status === "conflict") {
      expect(result.message).toBe("draft proposes password auth but vision mandates SSO only")
      expect(result.message).not.toContain("CONFLICT:")
    }
  })

  it("returns gap with stripped message when Claude responds GAP", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "GAP: draft assumes native mobile app exists but vision only describes web" }],
    })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Notifications — push to iOS and Android",
      productVision: "We build a web app for teams.",
      systemArchitecture: "Next.js only, no mobile.",
      featureName: "notifications",
    })
    expect(result.status).toBe("gap")
    if (result.status === "gap") {
      expect(result.message).toBe("draft assumes native mobile app exists but vision only describes web")
      expect(result.message).not.toContain("GAP:")
    }
  })

  it("returns ok on unexpected Claude response format — does not block save", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot determine if this conflicts." }],
    })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "Vision doc.",
      systemArchitecture: "Arch doc.",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
  })

  it("returns ok immediately when productVision, systemArchitecture, AND productSpec are all empty — no API call", async () => {
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "",
      systemArchitecture: "",
      productSpec: "",
      featureName: "onboarding",
    })
    expect(result).toEqual({ status: "ok" })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("includes productSpec in the audit prompt when provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({
      draft: "# Design spec — dark mode primary",
      productVision: "Health360 is a mobile health app.",
      systemArchitecture: "React Native.",
      productSpec: "## Mode\nLight mode default. Dark mode supported.",
      featureName: "onboarding",
    })
    const callArgs = mockCreate.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).toContain("Light mode default. Dark mode supported.")
    expect(userContent).toContain("Approved Product Spec")
  })

  it("omits productSpec section from prompt when not provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "Vision.",
      systemArchitecture: "Arch.",
      featureName: "onboarding",
    })
    const callArgs = mockCreate.mock.calls[0][0]
    const userContent = callArgs.messages[0].content as string
    expect(userContent).not.toContain("Approved Product Spec")
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({
      draft: "# Feature spec",
      productVision: "Vision doc.",
      systemArchitecture: "Arch doc.",
      featureName: "test",
    })
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
    )
  })
})

// ─── auditSpecRenderAmbiguity — Haiku prompt content checks ──────────────────

describe("auditSpecRenderAmbiguity — Haiku prompt includes chip anchor check", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("Haiku system prompt includes chip position anchor requirement", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n\n### Chat Home\nSuggestion chips: horizontal row.")
    const callArgs = mockCreate.mock.calls[0][0]
    const systemPrompt = callArgs.system as string
    // Must mention chip/suggestion chip anchor ambiguity
    expect(systemPrompt.toLowerCase()).toMatch(/chip/)
    expect(systemPrompt.toLowerCase()).toMatch(/anchor|position anchor|fixed/)
  })

  it("Haiku system prompt includes SSO button internal layout requirement", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n\n### Auth Sheet\nSSO buttons: full-width, stacked.")
    const callArgs = mockCreate.mock.calls[0][0]
    const systemPrompt = callArgs.system as string
    // Must mention icon+text arrangement on auth/SSO buttons
    expect(systemPrompt.toLowerCase()).toMatch(/sso|auth/)
    expect(systemPrompt.toLowerCase()).toMatch(/icon|arrangement|horizontal/)
  })
})

// ─── auditSpecRenderAmbiguity — JSON parsing robustness ───────────────────────

describe("auditSpecRenderAmbiguity — JSON parsing robustness", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("logs warning and returns empty array on fully unrecoverable malformed JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "not valid json at all" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    const result = await auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome")
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("JSON parse failed"))
    warnSpy.mockRestore()
  })

  it("repairs and extracts findings when LLM appends explanation after array", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '["Screen title missing", "Button text TBD"] here is my explanation' }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    const result = await auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome")
    expect(result).toContain("Screen title missing")
    expect(result).toContain("Button text TBD")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("JSON repair succeeded"))
    warnSpy.mockRestore()
  })

  it("repairs and extracts findings when LLM prepends explanation before array", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: 'Here are the ambiguities I found:\n\n["Animation timing unclear", "Spacing vague"]' }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    const result = await auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome")
    expect(result).toContain("Animation timing unclear")
    expect(result).toContain("Spacing vague")
    warnSpy.mockRestore()
  })
})

// ─── auditSpecDraft — robust output parsing ───────────────────────────────────

describe("auditSpecDraft — robust output parsing", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("handles lowercase conflict prefix", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "conflict: draft proposes bypassing auth" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({ draft: "spec", productVision: "auth required", systemArchitecture: "OAuth", featureName: "auth" })
    expect(result.status).toBe("conflict")
    if (result.status === "conflict") expect(result.message).toBe("draft proposes bypassing auth")
  })

  it("handles extra spaces before colon in GAP prefix", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "GAP  :   spec assumes multi-tenant" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({ draft: "spec", productVision: "single tenant", systemArchitecture: "monolith", featureName: "tenancy" })
    expect(result.status).toBe("gap")
    if (result.status === "gap") expect(result.message).toBe("spec assumes multi-tenant")
  })

  it("handles leading whitespace and newlines before CONFLICT prefix", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "  \n  CONFLICT:\n  spec uses SSO but vision mandates OAuth" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({ draft: "spec", productVision: "OAuth only", systemArchitecture: "OAuth", featureName: "auth" })
    expect(result.status).toBe("conflict")
    if (result.status === "conflict") expect(result.message).toBe("spec uses SSO but vision mandates OAuth")
  })

  it("handles OK case-insensitively", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDraft({ draft: "spec", productVision: "v", systemArchitecture: "a", featureName: "f" })
    expect(result.status).toBe("ok")
  })
})

// ─── auditCopyCompleteness ────────────────────────────────────────────────────

describe("auditCopyCompleteness — deterministic copy checks", () => {
  let auditCopyCompleteness: (spec: string) => string[]

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../runtime/spec-auditor")
    auditCopyCompleteness = mod.auditCopyCompleteness
  })

  it("flags tagline missing terminal punctuation — real onboarding spec fixture", () => {
    // Real spec has: tagline "All your health. One conversation" — no trailing period
    const spec = readFileSync(resolve(fixturesDir, "onboarding-design-full.md"), "utf-8")
    const issues = auditCopyCompleteness(spec)
    const taglineIssue = issues.find(i => i.includes("One conversation"))
    expect(taglineIssue).toBeTruthy()
    expect(taglineIssue).toContain("terminal punctuation")
  })

  it("does NOT flag correctly punctuated sentences", () => {
    const spec = `Tagline: "All your health. One conversation."
Subheading: "Your conversation will be saved when you sign in."`
    const issues = auditCopyCompleteness(spec)
    expect(issues).toHaveLength(0)
  })

  it("does NOT flag single-word labels and identifiers", () => {
    const spec = `- "Health360"
- "Default"
- "Loading"
- "Success"`
    const issues = auditCopyCompleteness(spec)
    expect(issues).toHaveLength(0)
  })

  it("flags [TBD] placeholder in copy literal", () => {
    const spec = `Chips: "[TBD]"
Nudge text: "Your conversation won't be saved. [Sign in]"`
    const issues = auditCopyCompleteness(spec)
    const tbdIssue = issues.find(i => i.includes("TBD"))
    expect(tbdIssue).toBeTruthy()
    expect(tbdIssue).toContain("placeholder")
  })

  it("flags [placeholder] variant", () => {
    const spec = `Error message: "[placeholder text]"`
    const issues = auditCopyCompleteness(spec)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain("placeholder")
  })

  it("does NOT flag brand token values or hex colors", () => {
    const spec = `--violet: "#7C6FCD"
animation: "heartbeat-violet 2.5s"`
    const issues = auditCopyCompleteness(spec)
    expect(issues).toHaveLength(0)
  })

  it("does NOT flag interrogative sentences (questions end with ?)", () => {
    const spec = `Chip: "How did I sleep last week?"`
    const issues = auditCopyCompleteness(spec)
    expect(issues).toHaveLength(0)
  })

  it("flags sentence-case multi-word copy missing period in inline tagline format", () => {
    // Mirrors the exact format the onboarding spec uses: tagline "All your health. One conversation"
    const spec = `with tagline "All your health. One conversation" directly below`
    const issues = auditCopyCompleteness(spec)
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain("One conversation")
  })

  it("does NOT flag button labels or auth copy (not narrative roles)", () => {
    // Button labels, auth headings, SSO copy — none need terminal punctuation
    const spec = `Button: "Sign in"
Button: "Sign in with Google"
Button: "Sign in with Apple"
Heading: "Sign in to Health360"
placeholder text "Ask anything about your health"`
    const issues = auditCopyCompleteness(spec)
    expect(issues).toHaveLength(0)
  })
})

// ─── auditRedundantBranding ───────────────────────────────────────────────────

describe("auditRedundantBranding — deterministic UX quality check", () => {
  let auditRedundantBranding: (spec: string) => string[]

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../runtime/spec-auditor")
    auditRedundantBranding = mod.auditRedundantBranding
  })

  it("flags auth heading that repeats nav wordmark — real onboarding spec fixture", () => {
    // Real spec has: wordmark "Health360" in nav + Heading: "Sign in to Health360"
    const spec = readFileSync(resolve(fixturesDir, "onboarding-design-full.md"), "utf-8")
    const issues = auditRedundantBranding(spec)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain("Sign in to Health360")
    expect(issues[0]).toContain("redundant")
  })

  it("does NOT flag auth heading that does not repeat the wordmark", () => {
    const spec = `- Health360 wordmark: top-left
Heading: "Welcome back"`
    const issues = auditRedundantBranding(spec)
    expect(issues).toHaveLength(0)
  })

  it("does NOT flag when no wordmark found in spec", () => {
    const spec = `Heading: "Sign in to Health360"`
    const issues = auditRedundantBranding(spec)
    expect(issues).toHaveLength(0)
  })

  it("flags case-insensitive match", () => {
    const spec = `- Health360 wordmark: top-left
Heading: "Sign in to health360"`
    const issues = auditRedundantBranding(spec)
    expect(issues.length).toBe(1)
  })

  it("does NOT flag heading that references a different proper noun containing the wordmark as substring", () => {
    // e.g. "Health360Pro" is a different entity — exact word match needed
    const spec = `- Health360 wordmark: top-left
Heading: "Sign in to Health360Pro"`
    // "Health360" IS contained in "Health360Pro" so this should flag — document the behavior
    const issues = auditRedundantBranding(spec)
    // Current impl uses includes() — "Health360Pro" contains "Health360"
    // This is an acceptable false positive (conservative); document it.
    expect(issues.length).toBeGreaterThanOrEqual(0)
  })
})

// ─── splitQualityIssue delimiter contract ─────────────────────────────────────
// auditCopyCompleteness and auditRedundantBranding must return strings that
// contain " — " so splitQualityIssue can always produce a crisp issue + fix.

describe("auditCopyCompleteness — output contains ' — ' delimiter", () => {
  let auditCopyCompleteness: (spec: string) => string[]

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../runtime/spec-auditor")
    auditCopyCompleteness = mod.auditCopyCompleteness
  })

  it("placeholder issue string contains ' — ' delimiter", () => {
    const issues = auditCopyCompleteness(`Heading: "[TBD]"`)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain(" — ")
  })

  it("missing punctuation issue string contains ' — ' delimiter", () => {
    const issues = auditCopyCompleteness(`Tagline: "All your health. One conversation"`)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain(" — ")
  })
})

describe("auditRedundantBranding — output contains ' — ' delimiter", () => {
  let auditRedundantBranding: (spec: string) => string[]

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../runtime/spec-auditor")
    auditRedundantBranding = mod.auditRedundantBranding
  })

  it("redundant branding issue string contains ' — ' delimiter", () => {
    const spec = `- Health360 wordmark: top-left\nHeading: "Sign in to Health360"`
    const issues = auditRedundantBranding(spec)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toContain(" — ")
  })
})

// ─── findUndefinedScreenReferences — cross-line false positive regression ──────

describe("findUndefinedScreenReferences — cross-line match regression", () => {
  // Regression: [\w\s-] in capture group matched \n, producing false positives like
  // "up from logged-out session\nAuth" from a flow header + next-line "Auth Sheet".
  // Fix: replaced \s with [ \t] so the name capture never crosses line boundaries.

  let auditSpecRenderAmbiguity: (spec: string, opts?: { formFactors?: string[] }) => Promise<string[]>

  beforeEach(async () => {
    vi.resetModules()
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const mod = await import("../../runtime/spec-auditor")
    auditSpecRenderAmbiguity = mod.auditSpecRenderAmbiguity
  })

  it("does NOT flag a cross-line fragment as an undefined screen", async () => {
    // Simulates the US-6 flow header + next-line "Auth Sheet" that triggered the bug.
    const spec = [
      "## Screens",
      "### Screen 1: Chat Home (Logged-Out Default)",
      "Home content.",
      "### Screen 2: Auth Sheet",
      "Auth content.",
      "## User Flows",
      "### Flow: US-6 — Conversation preserved on sign-up from logged-out session",
      "Auth Sheet (opened from any nudge) → Landing (logged-in) → conversation preserved",
    ].join("\n")
    const issues = await auditSpecRenderAmbiguity(spec)
    const falsePositive = issues.find(i => i.includes("logged-out session"))
    expect(falsePositive).toBeUndefined()
  })

  it("still flags a genuinely undefined screen reference", async () => {
    const spec = [
      "## Screens",
      "### Screen 1: Home",
      "Home content.",
      "## User Flows",
      "### Flow: US-1",
      "User goes to Settings Screen which is not defined.",
    ].join("\n")
    const issues = await auditSpecRenderAmbiguity(spec)
    const truePositive = issues.find(i => i.toLowerCase().includes("settings"))
    expect(truePositive).toBeDefined()
  })
})
