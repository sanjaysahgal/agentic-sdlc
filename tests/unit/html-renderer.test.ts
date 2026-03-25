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
  it("returns HTML content from Claude response", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Preview</h1></body></html>"
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: html }] })

    const result = await generateDesignPreview({
      specContent: "## Screens\n### Login",
      featureName: "onboarding",
    })

    expect(result).toBe(html)
  })

  it("strips leading ```html fence if model adds one", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "```html\n<!DOCTYPE html><html></html>\n```" }],
    })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result).not.toContain("```")
    expect(result).toContain("<!DOCTYPE html>")
  })

  it("strips leading ``` fence without language tag", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "```\n<!DOCTYPE html><html></html>\n```" }],
    })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result).not.toContain("```")
    expect(result).toContain("<!DOCTYPE html>")
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

  it("uses claude-sonnet-4-6 model", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "<!DOCTYPE html><html></html>" }] })

    await generateDesignPreview({ specContent: "spec", featureName: "test" })

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    )
  })

  it("returns empty string when first content block is not text", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }] })

    const result = await generateDesignPreview({ specContent: "spec", featureName: "test" })
    expect(result).toBe("")
  })
})
