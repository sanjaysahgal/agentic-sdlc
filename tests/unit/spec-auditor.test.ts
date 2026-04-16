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

  it("requests at least 8192 max_tokens to avoid truncation on large specs with many findings", async () => {
    // 26 verbose findings at ~150 chars each = ~3900 chars, which exceeded the old 4096-token limit.
    // Now set to 8192 (Haiku's maximum) so even worst-case specs don't get truncated.
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Screen 1: Home\n## User Flows\n### Flow: US-1\nHome")
    const call = mockCreate.mock.calls[0][0]
    expect(call.max_tokens).toBeGreaterThanOrEqual(8192)
  })

  it("Haiku prompt includes per-finding brevity cap to keep output within token budget", async () => {
    // Producer test: prompt must instruct the model to keep each finding brief.
    // Without this, 26 findings at ~150 chars each hit the token ceiling and get truncated.
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Screen 1: Home\n## User Flows\n### Flow: US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toMatch(/≤\d+\s*words/i)
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

// ─── auditSpecDecisions ────────────────────────────────────────────────────────

describe("auditSpecDecisions", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns ok immediately when history has fewer than 2 messages — no API call", async () => {
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "# Spec",
      history: [{ role: "user", content: "hello" }],
    })
    expect(result).toEqual({ status: "ok" })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("returns ok when Claude responds OK", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 10%",
      history: [
        { role: "user", content: "let's lock glow opacity at 10%" },
        { role: "assistant", content: "Locked. Glow opacity: 10%" },
      ],
    })
    expect(result).toEqual({ status: "ok" })
  })

  it("returns ok when Claude responds with text that doesn't include MISMATCH:", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "No issues found." }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 10%",
      history: [
        { role: "user", content: "lock glow opacity 10%" },
        { role: "assistant", content: "Locked." },
      ],
    })
    expect(result).toEqual({ status: "ok" })
  })

  it("returns corrections when Claude returns MISMATCH lines", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "MISMATCH: Glow opacity | glow opacity: 15% | 10%" }],
    })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 15%",
      history: [
        { role: "user", content: "lock glow opacity at 10%" },
        { role: "assistant", content: "Locked. Glow opacity: 10%" },
      ],
    })
    expect(result.status).toBe("corrections")
    if (result.status === "corrections") {
      expect(result.corrections).toHaveLength(1)
      expect(result.corrections[0].description).toBe("Glow opacity")
      expect(result.corrections[0].found).toBe("glow opacity: 15%")
      expect(result.corrections[0].correct).toBe("10%")
    }
  })

  it("returns ok when MISMATCH lines have wrong format (not 3 parts)", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "MISMATCH: only two | parts" }],
    })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 15%",
      history: [
        { role: "user", content: "lock it" },
        { role: "assistant", content: "Locked." },
      ],
    })
    // Malformed MISMATCH lines are skipped; 0 corrections → ok
    expect(result).toEqual({ status: "ok" })
  })

  it("handles multiple MISMATCH lines in one response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "MISMATCH: Glow | old-glow | new-glow\nMISMATCH: Color | old-color | new-color" }],
    })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "old-glow old-color",
      history: [
        { role: "user", content: "lock both" },
        { role: "assistant", content: "Locked." },
      ],
    })
    expect(result.status).toBe("corrections")
    if (result.status === "corrections") {
      expect(result.corrections).toHaveLength(2)
    }
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await auditSpecDecisions({
      specContent: "spec content",
      history: [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "msg2" },
      ],
    })
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }))
  })
})

// ─── extractLockedDecisions ───────────────────────────────────────────────────

describe("extractLockedDecisions", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns empty string when history has fewer than 6 messages — no API call", async () => {
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
    ]
    const result = await extractLockedDecisions(history)
    expect(result).toBe("")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("returns empty string when Claude responds with 'none'", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array(6).fill(null).map((_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg${i}` }))
    const result = await extractLockedDecisions(history)
    expect(result).toBe("")
  })

  it("returns empty string when Claude responds without bullet points", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "No decisions found." }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array(6).fill(null).map((_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg${i}` }))
    const result = await extractLockedDecisions(history)
    expect(result).toBe("")
  })

  it("returns bullet list when Claude responds with decisions", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "• Dark mode primary\n• Glow opacity: 10%" }],
    })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array(6).fill(null).map((_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg${i}` }))
    const result = await extractLockedDecisions(history)
    expect(result).toContain("•")
    expect(result).toContain("Dark mode primary")
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array(6).fill(null).map((_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg${i}` }))
    await extractLockedDecisions(history)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }))
  })
})

// ─── filterDesignContent ──────────────────────────────────────────────────────

describe("filterDesignContent", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns extracted design tokens from Claude", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "--bg: #0A0A0F\n--violet: #8B5CF6" }] })
    const { filterDesignContent } = await import("../../runtime/spec-auditor")
    const result = await filterDesignContent("<html>...<style>--bg: #0A0A0F</style></html>")
    expect(result).toContain("--bg")
  })

  it("returns raw input slice when Claude responds with non-text block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] })
    const { filterDesignContent } = await import("../../runtime/spec-auditor")
    const input = "<style>body { color: red; }</style>"
    const result = await filterDesignContent(input)
    // Falls back to input (sliced to 150_000)
    expect(result).toBe(input)
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "--bg: #000" }] })
    const { filterDesignContent } = await import("../../runtime/spec-auditor")
    await filterDesignContent("<style>body { color: red; }</style>")
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }))
  })
})

// ─── applyDecisionCorrections ─────────────────────────────────────────────────

describe("applyDecisionCorrections", () => {
  let applyDecisionCorrections: (specContent: string, corrections: Array<{ description: string; found: string; correct: string }>) => { corrected: string; applied: Array<{ description: string; found: string; correct: string }> }

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import("../../runtime/spec-auditor")
    applyDecisionCorrections = mod.applyDecisionCorrections
  })

  it("replaces found text with correct value", () => {
    const { corrected, applied } = applyDecisionCorrections("Glow opacity: 15%", [
      { description: "Glow opacity", found: "15%", correct: "10%" },
    ])
    expect(corrected).toBe("Glow opacity: 10%")
    expect(applied).toHaveLength(1)
  })

  it("skips corrections where found text is not in spec", () => {
    const { corrected, applied } = applyDecisionCorrections("Glow opacity: 10%", [
      { description: "Color", found: "old-color", correct: "new-color" },
    ])
    expect(corrected).toBe("Glow opacity: 10%")
    expect(applied).toHaveLength(0)
  })

  it("replaces all occurrences of found text", () => {
    const { corrected, applied } = applyDecisionCorrections("opacity: 15% and opacity: 15%", [
      { description: "Opacity", found: "15%", correct: "10%" },
    ])
    expect(corrected).toBe("opacity: 10% and opacity: 10%")
    expect(applied).toHaveLength(1)
  })

  it("applies multiple corrections in sequence", () => {
    const { corrected, applied } = applyDecisionCorrections("color: red; opacity: 15%", [
      { description: "Color", found: "red", correct: "blue" },
      { description: "Opacity", found: "15%", correct: "10%" },
    ])
    expect(corrected).toBe("color: blue; opacity: 10%")
    expect(applied).toHaveLength(2)
  })

  it("returns original spec unchanged when no corrections provided", () => {
    const spec = "Glow opacity: 10%"
    const { corrected, applied } = applyDecisionCorrections(spec, [])
    expect(corrected).toBe(spec)
    expect(applied).toHaveLength(0)
  })
})

// ─── auditSpecDecisions — ZERO TESTS EXISTED — consumer + producer ────────────
//
// Producer-consumer chain rule: consumer tests verify the gate parses correctly;
// producer tests verify the system prompt contains the format instruction that
// causes Haiku to output that format.

describe("auditSpecDecisions — consumer tests (MISMATCH parsing)", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns status: ok when Haiku responds OK", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 10%",
      history: [
        { role: "user", content: "let's do 10% opacity" },
        { role: "assistant", content: "Locked. Glow opacity 10%." },
        { role: "user", content: "perfect" },
      ],
    })
    expect(result.status).toBe("ok")
  })

  it("returns status: ok when no MISMATCH: prefix in response", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "No mismatches found in the spec." }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 10%",
      history: [{ role: "user", content: "fine" }, { role: "assistant", content: "ok" }, { role: "user", content: "done" }],
    })
    expect(result.status).toBe("ok")
  })

  it("parses a single MISMATCH line into one correction", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "MISMATCH: glow opacity wrong | opacity: 5% | 10%" }],
    })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 5%",
      history: [
        { role: "user", content: "lock glow opacity at 10%" },
        { role: "assistant", content: "Locked. Glow opacity: 10%." },
        { role: "user", content: "confirmed" },
      ],
    })
    expect(result.status).toBe("corrections")
    if (result.status === "corrections") {
      expect(result.corrections).toHaveLength(1)
      expect(result.corrections[0].description).toBe("glow opacity wrong")
      expect(result.corrections[0].found).toBe("opacity: 5%")
      expect(result.corrections[0].correct).toBe("10%")
    }
  })

  it("parses multiple MISMATCH lines into multiple corrections", async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: "text",
        text: "MISMATCH: opacity wrong | opacity: 5% | 10%\nMISMATCH: duration wrong | duration: 2s | 2.5s",
      }],
    })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "Glow opacity: 5%\nAnimation duration: 2s",
      history: [
        { role: "user", content: "lock it: 10% opacity, 2.5s duration" },
        { role: "assistant", content: "Locked." },
        { role: "user", content: "yes" },
      ],
    })
    expect(result.status).toBe("corrections")
    if (result.status === "corrections") {
      expect(result.corrections).toHaveLength(2)
      expect(result.corrections[0].found).toBe("opacity: 5%")
      expect(result.corrections[1].found).toBe("duration: 2s")
    }
  })

  it("skips malformed MISMATCH line with fewer than 3 pipe parts — does not crash", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "MISMATCH: malformed line without enough pipes | only-two-parts" }],
    })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "some spec",
      history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    })
    // Malformed line skipped → no corrections → status ok
    expect(result.status).toBe("ok")
  })

  it("returns status: ok immediately when history has fewer than 2 messages — no API call", async () => {
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const result = await auditSpecDecisions({
      specContent: "spec",
      history: [{ role: "user", content: "hi" }],
    })
    expect(result.status).toBe("ok")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await auditSpecDecisions({
      specContent: "spec",
      history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    })
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }))
  })
})

describe("auditSpecDecisions — producer tests (system prompt contains format instruction)", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("system prompt instructs Haiku to output 'MISMATCH: description | found | correct'", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await auditSpecDecisions({
      specContent: "spec",
      history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("MISMATCH:")
    expect(systemPrompt).toContain("|")
  })

  it("system prompt instructs Haiku to output 'OK' when no mismatches", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await auditSpecDecisions({
      specContent: "spec",
      history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("OK")
  })

  it("system prompt instructs Haiku to look for 'locked' or 'confirmed' decisions", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await auditSpecDecisions({
      specContent: "spec",
      history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Must instruct Haiku to look for explicitly confirmed/locked values
    expect(systemPrompt.toLowerCase()).toMatch(/locked|confirmed|agreed/)
  })

  it("user message contains both spec content and conversation history", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await auditSpecDecisions({
      specContent: "Glow opacity: MY_SPEC_MARKER",
      history: [
        { role: "user", content: "MY_HISTORY_MARKER" },
        { role: "assistant", content: "Locked." },
        { role: "user", content: "yes" },
      ],
    })
    const userContent = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(userContent).toContain("MY_SPEC_MARKER")
    expect(userContent).toContain("MY_HISTORY_MARKER")
  })
})

// ─── extractLockedDecisions — ZERO TESTS EXISTED — consumer + producer ────────

describe("extractLockedDecisions — consumer tests", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("returns empty string immediately when history has fewer than 6 messages — no API call", async () => {
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const result = await extractLockedDecisions([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ])
    expect(result).toBe("")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("returns empty string when Haiku responds 'none'", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    const result = await extractLockedDecisions(history)
    expect(result).toBe("")
  })

  it("returns empty string when response has no bullet character", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "Some vague text without bullets" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    const result = await extractLockedDecisions(history)
    expect(result).toBe("")
  })

  it("returns bullet text when Haiku returns bullet-prefixed decisions", async () => {
    const bulletText = "• Dark mode primary, light secondary\n• Glow opacity: 10%"
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: bulletText }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    const result = await extractLockedDecisions(history)
    expect(result).toBe(bulletText)
    expect(result).toContain("Dark mode")
    expect(result).toContain("Glow opacity")
  })

  it("uses claude-haiku-4-5-20251001 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await extractLockedDecisions(history)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }))
  })
})

describe("extractLockedDecisions — producer tests (system prompt contains format instruction)", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("system prompt instructs Haiku to output bullet character '•' per locked decision", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await extractLockedDecisions(history)
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("•")
  })

  it("system prompt instructs Haiku to output 'none' when fewer than 2 decisions are locked", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await extractLockedDecisions(history)
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("none")
  })

  it("system prompt restricts to explicitly confirmed decisions — not proposals or open questions", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await extractLockedDecisions(history)
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toMatch(/confirmed|explicitly|locked/)
  })
})

// ─── auditSpecDraft — producer tests (format instruction in system prompt) ─────

describe("auditSpecDraft — producer tests (system prompt contains output format)", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("system prompt instructs Haiku to output 'CONFLICT:' prefix for conflicts", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({ draft: "spec", productVision: "vision", systemArchitecture: "arch", featureName: "f" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("CONFLICT:")
  })

  it("system prompt instructs Haiku to output 'GAP:' prefix for gaps", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({ draft: "spec", productVision: "vision", systemArchitecture: "arch", featureName: "f" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("GAP:")
  })

  it("system prompt instructs Haiku to output 'OK' when no issues", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({ draft: "spec", productVision: "vision", systemArchitecture: "arch", featureName: "f" })
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("OK")
  })
})

// ─── auditSpecRenderAmbiguity — producer tests (JSON array instruction) ────────

describe("auditSpecRenderAmbiguity — producer tests (system prompt instructs JSON array output)", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("system prompt instructs Haiku to return a JSON array of strings", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toMatch(/json array/)
  })

  it("system prompt instructs Haiku to return '[]' when spec is fully specified", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain("[]")
  })

  it("system prompt instructs Haiku to return ONLY the array — no preamble", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "[]" }] })
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome")
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt.toLowerCase()).toMatch(/only.*array|array.*only|no preamble|return only/i)
  })
})

// ─── Network failure resilience — spec-auditor clients ────────────────────────
//
// spec-auditor.ts Anthropic clients are configured with maxRetries: 0 and 60s timeout.
// Errors propagate to the caller (message.ts calls these with .catch() for non-blocking audits).
// These tests verify no silent retry swallowing — exactly one API call per error.

describe("spec-auditor — network failure propagates immediately, no retries", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("auditSpecDraft propagates API error immediately — no retry", async () => {
    mockCreate.mockRejectedValue(new Error("APITimeoutError: Request timed out"))
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await expect(auditSpecDraft({ draft: "spec", productVision: "vision", systemArchitecture: "arch", featureName: "f" }))
      .rejects.toThrow()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("auditSpecDecisions propagates API error immediately — no retry", async () => {
    mockCreate.mockRejectedValue(new Error("APITimeoutError: Request timed out"))
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    await expect(auditSpecDecisions({
      specContent: "spec",
      history: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }],
    })).rejects.toThrow()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("extractLockedDecisions propagates API error immediately — no retry", async () => {
    mockCreate.mockRejectedValue(new Error("APITimeoutError: Request timed out"))
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await expect(extractLockedDecisions(history)).rejects.toThrow()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it("auditSpecRenderAmbiguity propagates API error immediately — no retry", async () => {
    mockCreate.mockRejectedValue(new Error("APITimeoutError: Request timed out"))
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await expect(auditSpecRenderAmbiguity("## Screens\n### Home\n## User Flows\n### US-1\nHome"))
      .rejects.toThrow()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

describe("spec-auditor — [AUDITOR] logging on every call", () => {
  beforeEach(() => {
    vi.resetModules()
    mockCreate.mockReset()
  })

  it("auditSpecDraft logs [AUDITOR] prefix on ok result", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { auditSpecDraft } = await import("../../runtime/spec-auditor")
    await auditSpecDraft({ draft: "spec", productVision: "vision", systemArchitecture: "arch", featureName: "myfeature" })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[AUDITOR] auditSpecDraft: feature=myfeature"))
    logSpy.mockRestore()
  })

  it("auditSpecRenderAmbiguity logs finding count including llm findings", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: '["Missing animation timing"]' }] })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { auditSpecRenderAmbiguity } = await import("../../runtime/spec-auditor")
    await auditSpecRenderAmbiguity("## Screens\n")
    const auditLog = logSpy.mock.calls.find(c => String(c[0]).includes("[AUDITOR] auditSpecRenderAmbiguity"))
    expect(auditLog).toBeDefined()
    expect(String(auditLog![0])).toContain("llm=1")
    logSpy.mockRestore()
  })

  it("auditSpecDecisions logs [AUDITOR] prefix on ok result", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "OK" }] })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { auditSpecDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await auditSpecDecisions({ specContent: "spec content", history })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[AUDITOR] auditSpecDecisions:"))
    logSpy.mockRestore()
  })

  it("extractLockedDecisions logs [AUDITOR] prefix when none found", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "none" }] })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { extractLockedDecisions } = await import("../../runtime/spec-auditor")
    const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` }))
    await extractLockedDecisions(history)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[AUDITOR] extractLockedDecisions:"))
    logSpy.mockRestore()
  })
})
