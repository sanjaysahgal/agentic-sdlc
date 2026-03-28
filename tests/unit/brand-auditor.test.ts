import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { auditBrandTokens, auditAnimationTokens, BrandDrift, AnimationDrift } from "../../runtime/brand-auditor"

// Real agent output — loaded from fixtures, NOT hand-crafted.
// These files must be sourced from actual agent responses.
// Rule: any test that validates parser behavior against agent output must use a fixture file.
// Hand-crafted inline strings are only acceptable for explicit edge cases (empty input, partial input).
const FIXTURE_DIR = join(__dirname, "../fixtures/agent-output")

const REAL_BRAND_MD = readFileSync(join(FIXTURE_DIR, "brand-md.md"), "utf-8")
const REAL_SPEC_DRIFTED = readFileSync(join(FIXTURE_DIR, "design-brand-section-drifted.md"), "utf-8")
const REAL_SPEC_CANONICAL = readFileSync(join(FIXTURE_DIR, "design-brand-section-canonical.md"), "utf-8")

// Animation drift fixtures — BRAND.md with animation section + spec Brand section with animation values.
// The BRAND.md format (glow-duration:, glow-blur:, etc.) is platform-defined, not agent output.
// The spec animation section IS agent output — fixture sourced from the onboarding design spec discussion.
const BRAND_MD_WITH_ANIMATION = readFileSync(join(FIXTURE_DIR, "brand-md-with-animation.md"), "utf-8")
const SPEC_ANIMATION_DRIFTED = readFileSync(join(FIXTURE_DIR, "design-brand-animation-drifted.md"), "utf-8")
const SPEC_ANIMATION_CANONICAL = readFileSync(join(FIXTURE_DIR, "design-brand-animation-canonical.md"), "utf-8")

// Edge-case fixtures — explicit minimal constructions for testing parser boundary behavior.
// These are intentionally synthetic; they test logic paths, not format assumptions.
const SPEC_DRIFTED_CSS_FORMAT = `
## Brand
Color tokens:
--bg: #0A0E27
--surface: #151B38
--text: #F8F8F7
--violet: #8B7FE8
--teal: #4FADA8
--error: #e06c75

Font: system-ui
`

const SPEC_CORRECT_CSS_FORMAT = `
## Brand
Color tokens (from BRAND.md):
--bg: #0A0A0F
--surface: #13131A
--text: #F8F8F7
--violet: #7C6FCD
--teal: #4FAFA8
--error: #e06c75

Font: system-ui
`

const SPEC_NO_BRAND_SECTION = `
## Design Direction
Dark mode, minimal.

## Screens
### Screen: Home
Purpose: Chat entry.
`

describe("auditBrandTokens — real agent output (fixture-sourced)", () => {
  it("returns empty array when spec Brand section matches BRAND.md exactly", () => {
    const drifts = auditBrandTokens(REAL_SPEC_CANONICAL, REAL_BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("detects drift in the real backtick-span format the design agent produces", () => {
    const drifts = auditBrandTokens(REAL_SPEC_DRIFTED, REAL_BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).toContain("--bg")
    expect(tokens).toContain("--surface")
    expect(tokens).toContain("--violet")
    expect(tokens).toContain("--teal")
  })

  it("does not flag tokens that match BRAND.md — --text and --error are correct in drifted fixture", () => {
    const drifts = auditBrandTokens(REAL_SPEC_DRIFTED, REAL_BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).not.toContain("--text")
    expect(tokens).not.toContain("--error")
  })

  it("returns correct specValue and brandValue for each drifted token", () => {
    const drifts = auditBrandTokens(REAL_SPEC_DRIFTED, REAL_BRAND_MD)
    const violet = drifts.find(d => d.token === "--violet")
    expect(violet?.specValue).toBe("#8B7FE8")
    expect(violet?.brandValue).toBe("#7C6FCD")
    const teal = drifts.find(d => d.token === "--teal")
    expect(teal?.specValue).toBe("#4FADA8")
    expect(teal?.brandValue).toBe("#4FAFA8")
  })
})

describe("auditBrandTokens — CSS format (edge-case constructions)", () => {
  it("returns drifted tokens in standard CSS format", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED_CSS_FORMAT, REAL_BRAND_MD)
    expect(drifts.length).toBeGreaterThan(0)
    const tokens = drifts.map(d => d.token)
    expect(tokens).toContain("--bg")
    expect(tokens).toContain("--violet")
  })

  it("returns empty when CSS-format spec matches BRAND.md exactly", () => {
    const drifts = auditBrandTokens(SPEC_CORRECT_CSS_FORMAT, REAL_BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("includes specValue and brandValue in CSS-format drift entry", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED_CSS_FORMAT, REAL_BRAND_MD)
    const violet = drifts.find(d => d.token === "--violet")
    expect(violet).toBeDefined()
    expect(violet!.specValue).toBe("#8B7FE8")
    expect(violet!.brandValue).toBe("#7C6FCD")
  })

  it("normalizes hex values to uppercase for comparison — same value, different case is not drift", () => {
    const specWithUpper = SPEC_CORRECT_CSS_FORMAT.replace("#e06c75", "#E06C75")
    const drifts = auditBrandTokens(specWithUpper, REAL_BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).not.toContain("--error")
  })
})

describe("auditAnimationTokens — fixture-sourced", () => {
  it("detects duration drift (2.5s in spec vs 4s in BRAND.md)", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const params = drifts.map(d => d.param)
    expect(params).toContain("glow-duration")
  })

  it("detects blur drift (200px in spec vs 80px in BRAND.md)", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const params = drifts.map(d => d.param)
    expect(params).toContain("glow-blur")
  })

  it("surfaces correct specValue and brandValue for duration drift", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const dur = drifts.find(d => d.param === "glow-duration")
    expect(dur?.specValue).toBe("2.5s")
    expect(dur?.brandValue).toBe("4s")
  })

  it("surfaces correct specValue and brandValue for blur drift", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const blur = drifts.find(d => d.param === "glow-blur")
    expect(blur?.specValue).toBe("200px")
    expect(blur?.brandValue).toBe("80px")
  })

  it("returns empty when animation params match BRAND.md exactly", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_CANONICAL, BRAND_MD_WITH_ANIMATION)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when BRAND.md has no Animation section", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, REAL_BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when spec has no Animation section in Brand", () => {
    const drifts = auditAnimationTokens(REAL_SPEC_DRIFTED, BRAND_MD_WITH_ANIMATION)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when either input is empty", () => {
    expect(auditAnimationTokens("", BRAND_MD_WITH_ANIMATION)).toHaveLength(0)
    expect(auditAnimationTokens(SPEC_ANIMATION_DRIFTED, "")).toHaveLength(0)
  })
})

describe("auditBrandTokens — boundary conditions", () => {
  it("returns empty when spec has no Brand section", () => {
    const drifts = auditBrandTokens(SPEC_NO_BRAND_SECTION, REAL_BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when brandMd is empty", () => {
    const drifts = auditBrandTokens(REAL_SPEC_DRIFTED, "")
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when specContent is empty", () => {
    const drifts = auditBrandTokens("", REAL_BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("does not flag BRAND.md tokens absent from the spec Brand section — absent is not drifted", () => {
    // Spec only defines --bg (wrong value). --violet is absent — that is not drift.
    const specPartial = `## Brand\n--bg: #0A0E27\n`
    const drifts = auditBrandTokens(specPartial, REAL_BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).toContain("--bg")        // present and wrong — drift
    expect(tokens).not.toContain("--violet") // absent — not drift
  })
})
