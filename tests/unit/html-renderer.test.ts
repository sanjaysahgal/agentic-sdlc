import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { renderFromSpec, generateDesignPreview, validateRenderedHtml, validateTextFidelity } from "../../runtime/html-renderer"

const dir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(dir, "../fixtures/agent-output")

const onboardingSpec = readFileSync(resolve(fixturesDir, "onboarding-design-brand-section.md"), "utf-8")
const brandMd = readFileSync(resolve(fixturesDir, "brand-md-glow.md"), "utf-8")

// Minimal spec for parsing tests
const MINIMAL_SPEC = `
## Design Direction
Heading: "HealthApp"
Tagline: "All your health. One conversation."
Placeholder: "Ask anything about your health"

### Starter Chips
- "How did I sleep last week?"
- "Am I hitting my step goals?"
- "What's my stress trend?"
`

// Minimal brand for color tests
const MINIMAL_BRAND = `
## Color Palette
--bg: #1A1A2E
--surface: #16213E
--text: #E0E0F0
--violet: #8B5CF6
--teal: #06B6D4
`

// ─── renderFromSpec: structural guarantees ────────────────────────────────────

describe("renderFromSpec — structural guarantees", () => {
  it("id='hero' is always present", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain('id="hero"')
  })

  it("id='thread' is always present", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain('id="thread"')
  })

  it("hero uses :class (not x-show) — visible before Alpine loads", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    const heroIdx = html.indexOf('id="hero"')
    // Find the tag boundary
    const tagEnd = html.indexOf('>', heroIdx)
    const heroTag = html.slice(heroIdx, tagEnd)
    expect(heroTag).toContain(":class")
    expect(heroTag).not.toContain("x-show")
  })

  it("thread has style='display:none' — hidden before Alpine", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    const threadIdx = html.indexOf('id="thread"')
    const tagEnd = html.indexOf('>', threadIdx)
    const threadTag = html.slice(threadIdx, tagEnd)
    expect(threadTag).toContain("display:none")
  })

  it("thread has x-show — Alpine can show it when msgs arrive", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    const threadIdx = html.indexOf('id="thread"')
    const tagEnd = html.indexOf('>', threadIdx)
    const threadTag = html.slice(threadIdx, tagEnd)
    expect(threadTag).toContain("x-show")
  })

  it("hero is NOT nested inside thread (siblings, not parent-child)", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    const { blocking } = validateRenderedHtml(html)
    const nestingIssues = blocking.filter(b => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))
    expect(nestingIssues).toHaveLength(0)
  })

  it("validateRenderedHtml reports no blocking issues on template output", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    const { blocking } = validateRenderedHtml(html)
    expect(blocking).toHaveLength(0)
  })

  it("chips are in a horizontal row (flex-direction:row), not vertical stack", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("flex-direction:row")
  })

  it("chips are anchored at bottom of hero via margin-top:auto", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("margin-top:auto")
  })

  it("inspector buttons have full static style attributes (not just :style)", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    // Every button in the inspector has a static style= that includes background and color
    // Count buttons with :style (inspector pattern) and verify they all also have static style
    const inspectorSection = html.slice(html.indexOf("INSPECTOR"))
    const buttonMatches = [...inspectorSection.matchAll(/<button([^>]*)>/g)]
    for (const [, attrs] of buttonMatches) {
      if (attrs.includes(":style")) {
        // Must also have a static style attribute
        expect(attrs).toMatch(/(?<![:\w])style\s*=\s*"/)
      }
    }
  })

  it("outputs a complete HTML document", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html.trim().startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html.trim().endsWith("</html>")).toBe(true)
  })

  it("body has explicit background-color in style block", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toMatch(/body\s*\{[^}]*background-color:/s)
  })

  it("includes heartbeat-violet and heartbeat-teal keyframe animations", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("@keyframes heartbeat-violet")
    expect(html).toContain("@keyframes heartbeat-teal")
  })
})

// ─── renderFromSpec: spec value parsing ──────────────────────────────────────

describe("renderFromSpec — spec value parsing", () => {
  it("uses Heading value from spec as app name", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("HealthApp")
  })

  it("uses Tagline value from spec", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("All your health. One conversation.")
  })

  it("uses Placeholder value from spec in prompt input", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("Ask anything about your health")
  })

  it("includes chip text from spec in button elements", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "healthapp")
    expect(html).toContain("How did I sleep last week?")
    expect(html).toContain("Am I hitting my step goals?")
  })

  it("caps chips at 3", () => {
    const manyChipsSpec = `
### Starter Chips
- "Chip one"
- "Chip two"
- "Chip three"
- "Chip four"
- "Chip five"
`
    const html = renderFromSpec(manyChipsSpec, MINIMAL_BRAND, "test")
    expect(html).toContain("Chip one")
    expect(html).toContain("Chip two")
    expect(html).toContain("Chip three")
    expect(html).not.toContain("Chip four")
  })

  it("falls back to capitalized featureName when Heading not found", () => {
    const noHeadingSpec = "## Screens\n### Chat Home\nSome content"
    const html = renderFromSpec(noHeadingSpec, MINIMAL_BRAND, "onboarding")
    expect(html).toContain("Onboarding")
  })

  it("handles chips with apostrophes safely via data-chip attribute", () => {
    const apostropheSpec = `### Starter Chips\n- "How's my heart rate?"`
    const html = renderFromSpec(apostropheSpec, MINIMAL_BRAND, "test")
    // chip text must appear; data-chip avoids JS syntax errors
    expect(html).toContain("data-chip=")
    expect(html).toContain("How")
  })

  it("shows 3 TBD placeholder pills when spec has no chip content", () => {
    const noChipsSpec = "## Nav Shell\nHealth360 wordmark: gradient text"
    const html = renderFromSpec(noChipsSpec, MINIMAL_BRAND, "test")
    // 3 placeholder pills, not just 1
    const tbdCount = (html.match(/TBD/g) ?? []).length
    expect(tbdCount).toBe(3)
    // Correct spec dimensions — 44px height, 40px border-radius (rounded pill)
    expect(html).toContain("height:44px")
    expect(html).toContain("border-radius:40px")
  })

  it("hides native scrollbars — polished preview never shows browser chrome", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "test")
    expect(html).toContain("scrollbar-width: none")
    expect(html).toContain("-ms-overflow-style: none")
    expect(html).toContain("::-webkit-scrollbar")
  })
})

// ─── renderFromSpec: brand color substitution ─────────────────────────────────

describe("renderFromSpec — brand color substitution", () => {
  it("applies --bg color to body background-color", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "test")
    expect(html).toContain("#1A1A2E")
  })

  it("applies --violet color to gradient and accents", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "test")
    expect(html).toContain("#8B5CF6")
  })

  it("applies --teal color to gradient", () => {
    const html = renderFromSpec(MINIMAL_SPEC, MINIMAL_BRAND, "test")
    expect(html).toContain("#06B6D4")
  })

  it("falls back to default colors when brand is empty", () => {
    const html = renderFromSpec(MINIMAL_SPEC, "", "test")
    // Should contain default violet
    expect(html).toContain("#7C6FCD")
  })

  it("uses glow-duration from spec Brand section in animation", () => {
    // Spec Brand section defines 2.5s duration; MINIMAL_SPEC has no Brand section → default 2.5s
    const html = renderFromSpec(MINIMAL_SPEC, brandMd, "test")
    expect(html).toContain("2.5s")
  })

  it("uses glow-blur from spec Brand section in filter", () => {
    // Spec Brand section defines 200px blur; MINIMAL_SPEC has no Brand section → default 200px
    const html = renderFromSpec(MINIMAL_SPEC, brandMd, "test")
    expect(html).toContain("200px")
  })
})

// ─── renderFromSpec: with real fixtures ──────────────────────────────────────

describe("renderFromSpec — real onboarding fixtures", () => {
  it("produces valid HTML with no blocking issues from real spec + brand", () => {
    const html = renderFromSpec(onboardingSpec, brandMd, "onboarding")
    const { blocking } = validateRenderedHtml(html)
    expect(blocking).toHaveLength(0)
  })

  it("hero and thread are siblings in real output", () => {
    const html = renderFromSpec(onboardingSpec, brandMd, "onboarding")
    const heroIdx = html.indexOf('id="hero"')
    const threadIdx = html.indexOf('id="thread"')
    expect(heroIdx).toBeGreaterThan(-1)
    expect(threadIdx).toBeGreaterThan(-1)
    // Verify hero is not between thread opening tag and its closing tag
    const { blocking } = validateRenderedHtml(html)
    expect(blocking.some(b => b.includes("nested"))).toBe(false)
  })

  it("applies heartbeat opacity values from spec Brand section in real fixture", () => {
    // BRAND.md specifies 0.55 at 0% keyframe for violet heartbeat (getarchon.dev match)
    const html = renderFromSpec(onboardingSpec, brandMd, "onboarding")
    expect(html).toContain("heartbeat-violet")
    expect(html).toContain("0.55")
  })
})

// ─── generateDesignPreview: backward-compat wrapper ──────────────────────────

describe("generateDesignPreview — backward-compat wrapper", () => {
  it("returns html and empty warnings without LLM call", async () => {
    const result = await generateDesignPreview({
      specContent: MINIMAL_SPEC,
      featureName: "healthapp",
      brandContent: MINIMAL_BRAND,
    })
    expect(result.html).toContain('id="hero"')
    expect(result.warnings).toHaveLength(0)
  })

  it("passes brandContent to renderer", async () => {
    const result = await generateDesignPreview({
      specContent: MINIMAL_SPEC,
      featureName: "test",
      brandContent: MINIMAL_BRAND,
    })
    expect(result.html).toContain("#1A1A2E") // --bg from MINIMAL_BRAND
  })
})

// ─── validateRenderedHtml — blocking validators (kept for regression) ─────────

describe("validateRenderedHtml — blocking: missing id='hero'", () => {
  it("returns a blocking issue when id='hero' is absent", () => {
    const html = `<!DOCTYPE html><html><body><div id="thread" style="display:none;" x-show="msgs.length > 0"><p>msg</p></div></body></html>`
    const result = validateRenderedHtml(html)
    expect(result.blocking.some(b => b.toLowerCase().includes("hero"))).toBe(true)
  })

  it("returns no hero-id blocking issue when id='hero' is present", () => {
    const html = `<!DOCTYPE html><html><body><div id="hero" :class="{ 'hidden': msgs.length > 0 }"></div><div id="thread" style="display:none;" x-show="msgs.length > 0"></div></body></html>`
    const result = validateRenderedHtml(html)
    const heroIdBlocking = result.blocking.filter(b => b.toLowerCase().includes("hero") && b.toLowerCase().includes("id"))
    expect(heroIdBlocking).toHaveLength(0)
  })
})

describe("validateRenderedHtml — blocking: hero nested inside thread", () => {
  it("returns a blocking issue when hero is nested inside thread", () => {
    const html = `<!DOCTYPE html><html><body><div id="thread" style="display:none;"><div id="hero"></div></div></body></html>`
    const result = validateRenderedHtml(html)
    expect(result.blocking.some(b => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))).toBe(true)
  })

  it("returns no nesting issue when hero and thread are siblings", () => {
    const html = `<!DOCTYPE html><html><body><div id="hero"></div><div id="thread" style="display:none;"></div></body></html>`
    const result = validateRenderedHtml(html)
    const nestingIssues = result.blocking.filter(b => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))
    expect(nestingIssues).toHaveLength(0)
  })

  it("does NOT false-positive when hero appears AFTER thread as a sibling", () => {
    const html = `<!DOCTYPE html><html><body><div id="thread" style="display:none;"><p>msg</p></div><div id="hero"></div></body></html>`
    const result = validateRenderedHtml(html)
    const nestingIssues = result.blocking.filter(b => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))
    expect(nestingIssues).toHaveLength(0)
  })
})

// ─── validateRenderedHtml — brandContent --bg token check ─────────────────────

describe("validateRenderedHtml — brand token warning", () => {
  it("warns when brandContent has --bg token not present in HTML", () => {
    const html = `<!DOCTYPE html><html><body style="background-color: #FFFFFF"><style>@keyframes glow {} body { background-color: #FFFFFF; }</style><div id="hero"></div></body></html>`
    const brandContent = "--bg: #1A1A2E"
    const result = validateRenderedHtml(html, brandContent)
    expect(result.warnings.some(w => w.includes("#1A1A2E") && w.includes("--bg"))).toBe(true)
  })

  it("does NOT warn when brandContent --bg token IS present in HTML", () => {
    const html = `<!DOCTYPE html><html><body><style>@keyframes glow {} body { background-color: #1A1A2E; }</style><div id="hero"></div></body></html>`
    const brandContent = "--bg: #1A1A2E"
    const result = validateRenderedHtml(html, brandContent)
    expect(result.warnings.some(w => w.includes("#1A1A2E"))).toBe(false)
  })

  it("skips brand token check when brandContent is not provided", () => {
    const html = `<!DOCTYPE html><html><body><style>@keyframes glow {} body { background-color: #1A1A2E; }</style><div id="hero"></div></body></html>`
    const result = validateRenderedHtml(html)
    // No brand warning possible without brandContent
    expect(result.warnings.some(w => w.includes("--bg"))).toBe(false)
  })

  it("skips brand token check when brandContent has no --bg token", () => {
    const html = `<!DOCTYPE html><html><body><style>@keyframes glow {} body { background-color: #1A1A2E; }</style><div id="hero"></div></body></html>`
    const brandContent = "--violet: #8B5CF6" // no --bg
    const result = validateRenderedHtml(html, brandContent)
    expect(result.warnings.some(w => w.includes("--bg"))).toBe(false)
  })

  it("warns when HTML has no @keyframes animation", () => {
    const html = `<!DOCTYPE html><html><body><style>body { background-color: #1A1A2E; }</style><div id="hero"></div></body></html>`
    const result = validateRenderedHtml(html)
    expect(result.warnings.some(w => w.toLowerCase().includes("keyframe"))).toBe(true)
  })

  it("warns when body has no explicit background-color CSS", () => {
    const html = `<!DOCTYPE html><html><body><style>@keyframes glow {} p { color: red; }</style><div id="hero"></div></body></html>`
    const result = validateRenderedHtml(html)
    expect(result.warnings.some(w => w.toLowerCase().includes("background"))).toBe(true)
  })
})

// ─── validateTextFidelity ─────────────────────────────────────────────────────

describe("validateTextFidelity", () => {
  it("returns no issues when all spec text literals are present in HTML", () => {
    const html = `<div><h1>My App</h1><p>All your health. One conversation.</p><input placeholder="Ask anything about your health"></div>`
    const spec = `Heading: "My App"\nTagline: "All your health. One conversation."\nPlaceholder: "Ask anything about your health"`
    const issues = validateTextFidelity(html, spec)
    expect(issues).toHaveLength(0)
  })

  it("flags spec text not found in HTML", () => {
    const html = `<div><h1>Wrong App Name</h1></div>`
    const spec = `Heading: "My App"\nTagline: "All your health."`
    const issues = validateTextFidelity(html, spec)
    expect(issues.some(i => i.includes("My App"))).toBe(true)
  })

  it("returns empty array when spec has no quoted text literals matching the pattern", () => {
    const html = `<div>Hello world</div>`
    const spec = `## Screens\n### Chat Home\nContent goes here.`
    const issues = validateTextFidelity(html, spec)
    expect(issues).toHaveLength(0)
  })

  it("skips short quoted strings (under 4 chars) that are not real spec literals", () => {
    // Pattern requires 4+ chars inside quotes
    const html = `<div>Hello</div>`
    const spec = `Heading: "Hi"` // 2 chars — below threshold
    const issues = validateTextFidelity(html, spec)
    expect(issues).toHaveLength(0)
  })

  it("flags multiple missing spec texts", () => {
    const html = `<div>Nothing here</div>`
    const spec = `Heading: "Missing Heading"\nTagline: "Missing tagline text"\nPlaceholder: "Missing placeholder"`
    const issues = validateTextFidelity(html, spec)
    expect(issues.length).toBeGreaterThanOrEqual(2)
  })
})
