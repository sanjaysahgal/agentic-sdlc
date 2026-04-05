import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import Anthropic from "@anthropic-ai/sdk"
import { generateDesignPreview, sanitizeRenderedHtml, validateRenderedHtml } from "../../runtime/html-renderer"

beforeEach(() => {
  mockCreate.mockReset()
})

describe("Anthropic client config", () => {
  it("sets maxRetries: 0 — a timed-out 32k-token render won't succeed on retry, fail fast instead", () => {
    expect(Anthropic).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
  })
})

// Minimal valid HTML that satisfies all blocking validators (id="hero" present, hero not nested in thread)
const VALID_MOCK_HTML = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #fff; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`

describe("generateDesignPreview", () => {
  it("returns html and warnings from Claude response", async () => {
    const html = VALID_MOCK_HTML
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({
      specContent: "## Screens\n### Login",
      featureName: "onboarding",
    })

    expect(result.html).toBe(html)
    expect(result.warnings).toBeInstanceOf(Array)
  })

  it("strips leading ```html fence if model adds one", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "```html\n" + VALID_MOCK_HTML + "\n```" }],
    })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.html).not.toContain("```")
    expect(result.html).toContain("<!DOCTYPE html>")
  })

  it("strips leading ``` fence without language tag", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "```\n" + VALID_MOCK_HTML + "\n```" }],
    })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.html).not.toContain("```")
    expect(result.html).toContain("<!DOCTYPE html>")
  })

  it("passes featureName and specContent to Claude", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({
      specContent: "## Screens\n### Dashboard",
      featureName: "dashboard",
    })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain("dashboard")
    expect(userMessage).toContain("## Screens")
  })

  it("uses claude-sonnet-4-6 model for production-quality rendering", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    )
  })

  it("throws when first content block is not text (treated as truncation)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] })

    await expect(generateDesignPreview({ specContent: "spec", featureName: "test" }))
      .rejects.toThrow("truncated")
  })

  it("throws when HTML is missing closing </html> tag — retries once then throws (both passes truncated)", async () => {
    // Mock returns truncated HTML on both the initial call and the retry
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "<!DOCTYPE html><html><body><p>Truncated..." }],
    })

    await expect(generateDesignPreview({ specContent: "spec", featureName: "test" }))
      .rejects.toThrow(/truncated|failed after retry/)
  })

  it("uses max_tokens 32000 for complex spec rendering", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 32000 })
    )
  })

  it("system prompt instructs renderer to read opacity from AUTHORITATIVE BRAND TOKENS", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("AUTHORITATIVE BRAND TOKENS")
    expect(call.system).toContain("glow-pulse")
    // No hardcoded opacity value — reads from brand
    expect(call.system).not.toContain('"0.45"')
    expect(call.system).not.toContain("opacity 0.45\u20130.75")
  })

  it("system prompt uses non-prefixed color names to avoid Tailwind class collision", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain('"primary"')
    expect(call.system).toContain('"fg"')
    expect(call.system).toContain("Color naming rule")
  })

  it("system prompt instructs sheets and modals to be own nav tabs", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("OWN named tab")
  })

  it("prepends AUTHORITATIVE BRAND TOKENS block when brandContent is provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    const brandContent = "## Color Palette\n--bg: #0A0A0F\n--violet: #7C6FCD"
    await generateDesignPreview({ specContent: "spec", featureName: "test", brandContent })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain("AUTHORITATIVE BRAND TOKENS")
    expect(userMessage).toContain("## Color Palette")
  })

  it("does not prepend brand block when brandContent is not provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).not.toContain("AUTHORITATIVE BRAND TOKENS")
  })

  it("returns warnings when bg token from BRAND.md is absent from rendered HTML", async () => {
    const brandContent = "## Color Palette\n--bg: #1A1A2E\n"
    // HTML that does not include the brand bg token — but has valid hero/thread structure
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #000; color: #fff; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test", brandContent })
    expect(result.warnings.some(w => w.includes("#1A1A2E"))).toBe(true)
  })

  it("returns empty warnings when HTML is structurally complete", async () => {
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #F8F8F7; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings).toHaveLength(0)
  })

  it("returns warning when keyframe animations are missing", async () => {
    const html = `<!DOCTYPE html><html><head><style>body { background-color: #0A0A0F; color: #fff; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("keyframe"))).toBe(true)
  })

  it("returns warning when body has no explicit CSS background-color (Tailwind-only silently fails on file:// URLs)", async () => {
    // bg-primary class without explicit background-color in <style> → white page on disk
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {}</style></head><body class="bg-primary"><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("background"))).toBe(true)
  })

  it("no background warning when body has explicit CSS background-color in style tag", async () => {
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #F8F8F7; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }" style="position:absolute;inset:0"></div><div id="thread" style="display:none;position:absolute;inset:0" x-show="msgs.length > 0 || typing"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("background"))).toBe(false)
  })

  it("system prompt instructs chips to be horizontal row not vertical stack", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("horizontal row")
  })

  it("system prompt requires Alpine.js x-data function pattern to prevent $nextTick escaping", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    // The safe pattern: declare methods in <script>, bind by function name
    expect(call.system).toContain("appData()")
    expect(call.system).toContain("x-data=\"appData()\"")
    // Explicitly warn against inline method declarations
    expect(call.system).toContain("Never write methods inline in the x-data attribute string")
  })

  it("system prompt specifies phone frame + inspector panel preview layout", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("phone frame")
    expect(call.system).toContain("inspector panel")
    expect(call.system).toContain("applyMode")
  })

  it("system prompt requires empty-state hero to be separate from nav bar and static-first (no x-show on hero)", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    // Hero is a separate div below the nav — nav contains app name left-aligned
    expect(call.system).toContain("SEPARATE div below the nav bar")
    // Static-first: hero must be visible without JavaScript — not behind x-show
    expect(call.system).toContain("Static-first hero")
    expect(call.system).toContain("Do NOT put the hero behind")
    expect(call.system).toContain("x-show")
  })

  it("system prompt mandates phone content area position:absolute structure for hero and thread", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    // Mandatory phone content area structure
    expect(call.system).toContain("MANDATORY STRUCTURE")
    expect(call.system).toContain("position:absolute; inset:0")
    // Hero uses :class, not x-show
    expect(call.system).toContain(":class")
    expect(call.system).toContain("hidden': msgs.length")
    // Thread uses style="display:none" + x-show
    expect(call.system).toContain('style="display:none"')
  })

  it("system prompt forbids height:100% inside overflow-y:auto for phone content area", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("Do not use height:100% inside overflow-y:auto")
  })

  it("system prompt requires inspector buttons to have full resting-state styles in static style attribute", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("Inspector buttons")
    expect(call.system).toContain("resting")
    // Must not rely on :style as the ONLY source of color
    expect(call.system).toContain("Never use `:style` as the ONLY source")
  })

  it("system prompt requires double-quoted strings in appData to prevent apostrophe syntax errors", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: VALID_MOCK_HTML }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("double quotes")
    expect(call.system).toContain("apostrophe")
    expect(call.system).toContain("JavaScript string safety")
  })

  it("sanitizer removes x-show from hero so hero is always visible — no warning in output", async () => {
    // Sonnet put x-show on the hero — sanitizer removes it and adds :class instead
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #fff; }</style></head><body><div id="hero" x-show="msgs.length === 0"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    // Sanitizer fixed it — no hero x-show warning, and the output HTML does not have x-show on hero
    expect(result.warnings.some(w => w.includes("x-show") && w.toLowerCase().includes("hero"))).toBe(false)
    expect(result.html).not.toMatch(/id="hero"[^>]*x-show/)
    expect(result.html).toMatch(/:class.*hidden.*msgs/)
  })

  it("sanitizer injects display:none into thread so it starts hidden — no warning in output", async () => {
    // Sonnet forgot display:none on thread — sanitizer injects it. Hero is present with :class.
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #fff; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }"></div><div id="thread" x-show="msgs.length > 0"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    // Sanitizer fixed it — no thread display:none warning, and output HTML has display:none on thread
    expect(result.warnings.some(w => w.toLowerCase().includes("thread") && w.toLowerCase().includes("display:none"))).toBe(false)
    expect(result.html).toMatch(/id="thread"[^>]*display:none|display:none[^>]*id="thread"/)
  })

  it("no thread display:none warning when style was already present (sanitizer leaves it unchanged)", async () => {
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #fff; }</style></head><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }"></div><div id="thread" style="position:absolute;inset:0;overflow-y:auto;display:none;" x-show="msgs.length > 0"></div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("thread") && w.toLowerCase().includes("display:none"))).toBe(false)
  })
})

describe("sanitizeRenderedHtml", () => {
  it("removes x-show from hero and adds :class", () => {
    const html = `<div id="hero" x-show="msgs.length === 0" style="padding:24px">`
    const out = sanitizeRenderedHtml(html)
    expect(out).not.toContain('x-show="msgs.length === 0"')
    expect(out).toContain(":class")
    expect(out).toContain("hidden")
  })

  it("leaves hero unchanged when it already has :class and no x-show", () => {
    const html = `<div id="hero" :class="{ 'hidden': msgs.length > 0 }" style="padding:24px">`
    const out = sanitizeRenderedHtml(html)
    expect(out).toBe(html)
  })

  it("injects display:none into thread style when missing", () => {
    const html = `<div id="thread" x-show="msgs.length > 0" style="position:absolute;inset:0">`
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain("display:none")
    expect(out).toMatch(/id="thread"/)
  })

  it("does not double-inject display:none when already present on thread", () => {
    const html = `<div id="thread" style="position:absolute;inset:0;display:none;" x-show="msgs.length > 0">`
    const out = sanitizeRenderedHtml(html)
    const count = (out.match(/display:none/g) ?? []).length
    expect(count).toBe(1)
  })

  it("injects style attribute with display:none when thread has no style attribute", () => {
    const html = `<div id="thread" x-show="msgs.length > 0">`
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain('style="display:none;"')
  })

  it("converts single-quoted JS strings with apostrophes to double-quoted in script blocks", () => {
    const html = `<script>var chips = ['How\'s your day?', 'Normal string']</script>`
    const out = sanitizeRenderedHtml(html)
    // The apostrophe-containing string should use double quotes now
    expect(out).not.toContain("'How\\'s your day?'")
  })

  it("leaves non-apostrophe single-quoted strings unchanged in script blocks", () => {
    const html = `<script>var x = 'hello world'</script>`
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain("'hello world'")
  })

  it("does not modify html outside script blocks", () => {
    const html = `<p class='my-class'>Don't change this</p>`
    const out = sanitizeRenderedHtml(html)
    expect(out).toBe(html)
  })

  it("injects static resting style on button with :style but no static style", () => {
    const html = `<button :style="inspectorMode === 'default' ? 'border-color:#8b5cf6' : ''" @click="applyMode('default')">Default</button>`
    const out = sanitizeRenderedHtml(html)
    expect(out).toMatch(/style="background:rgba/)
    expect(out).toMatch(/color:rgba/)
    expect(out).toMatch(/border:1px solid/)
    // :style binding preserved
    expect(out).toContain(":style=")
  })

  it("does not modify button that already has a static style attribute", () => {
    const html = `<button style="background:#333;color:#fff" :style="inspectorMode === 'x' ? 'border-color:purple' : ''" @click="applyMode('x')">X</button>`
    const out = sanitizeRenderedHtml(html)
    // Should not double-inject
    expect((out.match(/style=/g) ?? []).length).toBe(2) // static + :style
    expect(out).not.toMatch(/background:rgba.*background:/)
  })

  it("does not modify button without :style binding", () => {
    const html = `<button class="btn" @click="sendMsg(chip)">Send</button>`
    const out = sanitizeRenderedHtml(html)
    expect(out).toBe(html)
  })
})

// ─── Fix 1c: hero without id="hero" ──────────────────────────────────────────

describe("sanitizeRenderedHtml — Fix 1c: hero without id='hero'", () => {
  it("injects id='hero' and :class when x-show matches hero predicate but id is missing", () => {
    const html = `<div x-show="msgs.length === 0 && !typing" style="position:absolute;inset:0"></div>`
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain('id="hero"')
    expect(out).not.toContain('x-show="msgs.length === 0')
    expect(out).toContain(":class")
    expect(out).toContain("hidden")
  })

  it("does not double-add id='hero' when hero already has it", () => {
    const html = `<div id="hero" :class="{ 'hidden': msgs.length > 0 }" style="position:absolute;inset:0"></div>`
    const out = sanitizeRenderedHtml(html)
    const count = (out.match(/id="hero"/g) ?? []).length
    expect(count).toBe(1)
  })
})

// ─── Fix 2 enhancement: thread missing x-show ────────────────────────────────

describe("sanitizeRenderedHtml — Fix 2 enhancement: thread missing x-show", () => {
  it("injects x-show on thread when x-show is absent", () => {
    const html = `<div id="thread" style="position:absolute;inset:0;display:none;"></div>`
    const out = sanitizeRenderedHtml(html)
    expect(out).toContain('x-show="msgs.length > 0 || typing"')
  })

  it("does not inject x-show on thread when x-show is already present", () => {
    const html = `<div id="thread" style="position:absolute;inset:0;display:none;" x-show="msgs.length > 0 || typing"></div>`
    const out = sanitizeRenderedHtml(html)
    const count = (out.match(/x-show=/g) ?? []).length
    expect(count).toBe(1)
  })
})

// ─── validateRenderedHtml — blocking validators ───────────────────────────────

describe("validateRenderedHtml — blocking: missing id='hero'", () => {
  it("returns a blocking issue when id='hero' is absent", () => {
    // Minimal but otherwise valid structure — no hero id
    const html = `<!DOCTYPE html><html><body><div id="thread" style="display:none;" x-show="msgs.length > 0 || typing"><p>msg</p></div></body></html>`
    const result = validateRenderedHtml(html)
    expect(result.blocking.length).toBeGreaterThan(0)
    expect(result.blocking.some((b: string) => b.toLowerCase().includes("hero") && b.toLowerCase().includes("id"))).toBe(true)
  })

  it("returns no hero-id blocking issue when id='hero' is present", () => {
    const html = `<!DOCTYPE html><html><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }"></div><div id="thread" style="display:none;" x-show="msgs.length > 0 || typing"><p>msg</p></div></body></html>`
    const result = validateRenderedHtml(html)
    const heroIdBlocking = result.blocking.filter((b: string) => b.toLowerCase().includes("hero") && b.toLowerCase().includes("id"))
    expect(heroIdBlocking.length).toBe(0)
  })
})

describe("validateRenderedHtml — blocking: hero nested inside thread", () => {
  it("returns a blocking issue when hero is nested inside thread", () => {
    // hero incorrectly placed inside thread
    const html = `<!DOCTYPE html><html><body><div id="thread" style="display:none;" x-show="msgs.length > 0 || typing"><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }"></div><p>msg</p></div></body></html>`
    const result = validateRenderedHtml(html)
    expect(result.blocking.some((b: string) => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))).toBe(true)
  })

  it("returns no nesting blocking issue when hero and thread are siblings", () => {
    const html = `<!DOCTYPE html><html><body><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }"></div><div id="thread" style="display:none;" x-show="msgs.length > 0 || typing"><p>msg</p></div></body></html>`
    const result = validateRenderedHtml(html)
    const nestingBlocking = result.blocking.filter((b: string) => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))
    expect(nestingBlocking.length).toBe(0)
  })

  it("does NOT false-positive when hero appears AFTER thread as a sibling (old window-search bug)", () => {
    // thread comes first, hero is its sibling — NOT nested inside it.
    // The old code used a 5000-char forward window from id="thread" and would incorrectly
    // flag this as nesting. The bracket-counter correctly scopes to thread's inner content.
    const html = `<!DOCTYPE html><html><body><div id="thread" style="display:none;" x-show="msgs.length > 0 || typing"><p>msg</p></div><div id="hero" :class="{ 'hidden': msgs.length > 0 || typing }"></div></body></html>`
    const result = validateRenderedHtml(html)
    const nestingBlocking = result.blocking.filter((b: string) => b.toLowerCase().includes("nested") || b.toLowerCase().includes("sibling"))
    expect(nestingBlocking.length).toBe(0)
  })
})

// ─── System prompt reinforcement: id="hero" required ─────────────────────────
// Verify the source file enforces id="hero" in the renderer system prompt.
// This is a static content check — if someone removes the rule, this test breaks.

describe("generateDesignPreview system prompt — id='hero' reinforcement", () => {
  it("html-renderer source enforces id='hero' in system prompt rules", async () => {
    const { readFileSync } = await import("fs")
    const { resolve, dirname } = await import("path")
    const { fileURLToPath } = await import("url")
    // Works in both CJS and ESM test environments
    const filePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime/html-renderer.ts")
    const src: string = readFileSync(filePath, "utf-8")
    // The source must contain a CRITICAL enforcement of id="hero" somewhere.
    // Find the occurrence that's adjacent to CRITICAL / must / retry language.
    let found = false
    let searchFrom = 0
    while (true) {
      const idx = src.indexOf('id="hero"', searchFrom)
      if (idx === -1) break
      const ctx = src.slice(Math.max(0, idx - 300), idx + 300).toLowerCase()
      if (/critical|must not omit|retry required/.test(ctx)) {
        found = true
        break
      }
      searchFrom = idx + 1
    }
    expect(found).toBe(true)
  })
})
