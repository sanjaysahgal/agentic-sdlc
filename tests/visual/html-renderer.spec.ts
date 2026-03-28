/**
 * Visual regression tests for the HTML preview renderer.
 *
 * These tests catch rendering bugs that unit tests cannot:
 * - Invisible glow (opacity too low, wrong z-index, animation not firing)
 * - Black-on-black text (input color defaulting to browser black)
 * - Dark background not applied
 * - Missing animations (keyframe not found in computed style)
 *
 * They do NOT test LLM output quality — they test that the HTML pattern
 * the renderer is instructed to use actually works in a real browser.
 * The fixture (glow-preview.html) uses the exact template from
 * runtime/html-renderer.ts. If the template changes, update the fixture too.
 *
 * Run: npx playwright test tests/visual/
 */

import { test, expect } from "@playwright/test"
import path from "path"

const FIXTURE = `file://${path.join(__dirname, "fixtures", "glow-preview.html")}`

test.describe("HTML preview — glow visibility", () => {
  test("home glow element exists and is not hidden", async ({ page }) => {
    await page.goto(FIXTURE)
    const glow = page.locator("#home-glow")
    await expect(glow).toBeAttached()
    // Must not be hidden by display:none or visibility:hidden
    await expect(glow).toBeVisible()
  })

  test("home glow has animation applied (not 'none')", async ({ page }) => {
    await page.goto(FIXTURE)
    const animationName = await page.evaluate(() => {
      const el = document.getElementById("home-glow")
      return el ? getComputedStyle(el).animationName : "none"
    })
    expect(animationName).toContain("glow-pulse")
  })

  test("home glow has non-zero opacity in computed style", async ({ page }) => {
    await page.goto(FIXTURE)
    const opacity = await page.evaluate(() => {
      const el = document.getElementById("home-glow")
      return el ? parseFloat(getComputedStyle(el).opacity) : 0
    })
    // Opacity animates between 0.45 and 0.75 — at any snapshot it must be > 0
    expect(opacity).toBeGreaterThan(0)
  })

  test("home glow has blur filter applied", async ({ page }) => {
    await page.goto(FIXTURE)
    const filter = await page.evaluate(() => {
      const el = document.getElementById("home-glow")
      return el ? getComputedStyle(el).filter : ""
    })
    // blur(48px) or similar must be present — "none" means the glow has no soft bloom
    expect(filter).toMatch(/blur/)
  })

  test("auth sheet glow exists and has animation (independent instance)", async ({ page }) => {
    await page.goto(FIXTURE)
    const animationName = await page.evaluate(() => {
      const el = document.getElementById("auth-glow")
      return el ? getComputedStyle(el).animationName : "none"
    })
    expect(animationName).toContain("glow-pulse")
  })

  test("glow element is behind content (z-index: 0, content is z-index: 1)", async ({ page }) => {
    await page.goto(FIXTURE)
    const [glowZ, contentZ] = await page.evaluate(() => {
      const glow = document.getElementById("home-glow")
      const container = document.getElementById("prompt-bar-container")
      const content = container?.querySelector("[style*='z-index: 1']") as HTMLElement | null
      return [
        glow ? getComputedStyle(glow).zIndex : "auto",
        content ? getComputedStyle(content).zIndex : "auto",
      ]
    })
    // glow must be at a lower z-index than content
    expect(parseInt(glowZ as string)).toBeLessThan(parseInt(contentZ as string))
  })
})

test.describe("HTML preview — color palette and contrast", () => {
  test("page background is dark (#0A0A0F)", async ({ page }) => {
    await page.goto(FIXTURE)
    const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    // rgb(10, 10, 15) is #0A0A0F
    expect(bgColor).toMatch(/rgb\(10,\s*10,\s*15\)/)
  })

  test("primary text is light (not black-on-black)", async ({ page }) => {
    await page.goto(FIXTURE)
    const textColor = await page.evaluate(() => {
      const el = document.getElementById("wordmark")
      return el ? getComputedStyle(el).color : ""
    })
    // Parse rgb values and check luminance — must not be dark text on dark bg
    const match = textColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
    if (match) {
      const [, r, g, b] = match.map(Number)
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      expect(luminance).toBeGreaterThan(0.5) // text must be light (>50% luminance)
    } else {
      throw new Error(`Unexpected color format: ${textColor}`)
    }
  })

  test("prompt input text color is light — not browser-default black", async ({ page }) => {
    await page.goto(FIXTURE)
    const inputColor = await page.evaluate(() => {
      const el = document.getElementById("prompt-input")
      return el ? getComputedStyle(el).color : ""
    })
    const match = inputColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
    if (match) {
      const [, r, g, b] = match.map(Number)
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      // Black-on-black failure: luminance near 0 means black text on dark bg
      expect(luminance).toBeGreaterThan(0.5)
    } else {
      throw new Error(`Unexpected color format: ${inputColor}`)
    }
  })
})

test.describe("HTML preview — glow keyframe is defined", () => {
  test("glow-pulse keyframe is present in document stylesheets", async ({ page }) => {
    await page.goto(FIXTURE)
    const hasKeyframe = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSKeyframesRule && rule.name === "glow-pulse") return true
          }
        } catch {
          // cross-origin stylesheets (Tailwind CDN) are not readable — skip
        }
      }
      return false
    })
    expect(hasKeyframe).toBe(true)
  })
})

test.describe("HTML preview — structural completeness", () => {
  test("nav bar has more than one screen tab", async ({ page }) => {
    await page.goto(FIXTURE)
    const tabCount = await page.locator("#nav-tabs button").count()
    // A meaningful preview has at least two screens (e.g. Home + Auth Sheet)
    expect(tabCount).toBeGreaterThan(1)
  })

  test("suggestion chips container has flex-direction: row (not stacked vertically)", async ({ page }) => {
    await page.goto(FIXTURE)
    const flexDir = await page.evaluate(() => {
      const chips = document.getElementById("suggestion-chips")
      return chips ? getComputedStyle(chips).flexDirection : ""
    })
    // Chips must be in a row — vertical stacking is a mobile layout bug
    expect(flexDir).toBe("row")
  })

  test("suggestion chips remain in a row at iPhone viewport (no vertical stacking)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(FIXTURE)
    const flexDir = await page.evaluate(() => {
      const chips = document.getElementById("suggestion-chips")
      return chips ? getComputedStyle(chips).flexDirection : ""
    })
    expect(flexDir).toBe("row")
  })
})
