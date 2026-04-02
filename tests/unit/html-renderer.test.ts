import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreate = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } }
  }),
}))

import { generateDesignPreview } from "../../runtime/html-renderer"

beforeEach(() => {
  mockCreate.mockReset()
})

describe("generateDesignPreview", () => {
  it("returns html and warnings from Claude response", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Preview</h1></body></html>"
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
      content: [{ type: "text", text: "```html\n<!DOCTYPE html><html></html>\n```" }],
    })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.html).not.toContain("```")
    expect(result.html).toContain("<!DOCTYPE html>")
  })

  it("strips leading ``` fence without language tag", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "```\n<!DOCTYPE html><html></html>\n```" }],
    })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.html).not.toContain("```")
    expect(result.html).toContain("<!DOCTYPE html>")
  })

  it("passes featureName and specContent to Claude", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

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
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

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

  it("throws when HTML is missing closing </html> tag (truncated response)", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "<!DOCTYPE html><html><body><p>Truncated..." }],
    })

    await expect(generateDesignPreview({ specContent: "spec", featureName: "test" }))
      .rejects.toThrow("truncated before </html>")
  })

  it("uses max_tokens 32000 for complex spec rendering", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 32000 })
    )
  })

  it("system prompt instructs renderer to read opacity from AUTHORITATIVE BRAND TOKENS", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("AUTHORITATIVE BRAND TOKENS")
    expect(call.system).toContain("glow-pulse")
    // No hardcoded opacity value — reads from brand
    expect(call.system).not.toContain('"0.45"')
    expect(call.system).not.toContain("opacity 0.45\u20130.75")
  })

  it("system prompt uses non-prefixed color names to avoid Tailwind class collision", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain('"primary"')
    expect(call.system).toContain('"fg"')
    expect(call.system).toContain("Color naming rule")
  })

  it("system prompt instructs sheets and modals to be own nav tabs", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("OWN named tab")
  })

  it("prepends AUTHORITATIVE BRAND TOKENS block when brandContent is provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    const brandContent = "## Color Palette\n--bg: #0A0A0F\n--violet: #7C6FCD"
    await generateDesignPreview({ specContent: "spec", featureName: "test", brandContent })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).toContain("AUTHORITATIVE BRAND TOKENS")
    expect(userMessage).toContain("## Color Palette")
  })

  it("does not prepend brand block when brandContent is not provided", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    const userMessage = call.messages[0].content as string
    expect(userMessage).not.toContain("AUTHORITATIVE BRAND TOKENS")
  })

  it("returns warnings when bg token from BRAND.md is absent from rendered HTML", async () => {
    const brandContent = "## Color Palette\n--bg: #1A1A2E\n"
    // HTML that does not include the brand bg token
    const html = "<!DOCTYPE html><html><body style='background: #000'></body></html>"
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test", brandContent })
    expect(result.warnings.some(w => w.includes("#1A1A2E"))).toBe(true)
  })

  it("returns empty warnings when HTML is structurally complete", async () => {
    const html = "<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #F8F8F7; }</style></head><body></body></html>"
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings).toHaveLength(0)
  })

  it("returns warning when keyframe animations are missing", async () => {
    const html = "<!DOCTYPE html><html><body></body></html>"
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("keyframe"))).toBe(true)
  })

  it("returns warning when body has no explicit CSS background-color (Tailwind-only silently fails on file:// URLs)", async () => {
    // bg-primary class without explicit background-color in <style> → white page on disk
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {}</style></head><body class="bg-primary"><div>content</div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("background"))).toBe(true)
  })

  it("no background warning when body has explicit CSS background-color in style tag", async () => {
    const html = `<!DOCTYPE html><html><head><style>@keyframes glow-pulse {} body { background-color: #0A0A0F; color: #F8F8F7; }</style></head><body><div>content</div></body></html>`
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result.warnings.some(w => w.toLowerCase().includes("background"))).toBe(false)
  })

  it("system prompt instructs chips to be horizontal row not vertical stack", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("horizontal row")
  })

  it("system prompt requires Alpine.js x-data function pattern to prevent $nextTick escaping", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    // The safe pattern: declare methods in <script>, bind by function name
    expect(call.system).toContain("appData()")
    expect(call.system).toContain("x-data=\"appData()\"")
    // Explicitly warn against inline method declarations
    expect(call.system).toContain("Never write methods inline in the x-data attribute string")
  })

  it("system prompt specifies phone frame + inspector panel preview layout", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    expect(call.system).toContain("phone frame")
    expect(call.system).toContain("inspector panel")
    expect(call.system).toContain("applyMode")
  })

  it("system prompt requires empty-state hero to be separate from nav bar", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    const call = mockCreate.mock.calls[0][0]
    // Hero is a separate div below the nav — nav contains app name left-aligned
    expect(call.system).toContain("SEPARATE div below the nav bar")
    // Hero is only visible in empty state
    expect(call.system).toContain("msgs.length === 0")
  })
})
