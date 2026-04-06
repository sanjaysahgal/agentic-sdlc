import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { auditBrandTokens, auditAnimationTokens, auditMissingBrandTokens, BrandDrift, AnimationDrift } from "../../runtime/brand-auditor"

// Real agent output — loaded from fixtures, NOT hand-crafted.
// These files must be sourced from actual agent responses.
// Rule: any test that validates parser behavior against agent output must use a fixture file.
// Hand-crafted inline strings are only acceptable for explicit edge cases (empty input, partial input).
const FIXTURE_DIR = join(__dirname, "../fixtures/agent-output")

const REAL_BRAND_MD = readFileSync(join(FIXTURE_DIR, "brand-md.md"), "utf-8")
const REAL_SPEC_DRIFTED = readFileSync(join(FIXTURE_DIR, "design-brand-section-drifted.md"), "utf-8")
const REAL_SPEC_CANONICAL = readFileSync(join(FIXTURE_DIR, "design-brand-section-canonical.md"), "utf-8")

// Animation drift fixtures — BRAND.md with Glow CSS section + spec Brand section with animation values.
// brand-md-with-animation.md mirrors the real BRAND.md's ## Glow (Signature Effect) CSS format —
// the parser reads from what the team committed, not a platform-invented key-value section.
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

  it("detects opacity-min drift (0.45 in spec vs 0.55 in BRAND.md)", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const opMin = drifts.find(d => d.param === "glow-opacity-min")
    expect(opMin?.specValue).toBe("0.45")
    expect(opMin?.brandValue).toBe("0.55")
  })

  it("detects opacity-max drift (0.75 in spec vs 1.00 in BRAND.md)", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const opMax = drifts.find(d => d.param === "glow-opacity-max")
    expect(opMax?.specValue).toBe("0.75")
    expect(opMax?.brandValue).toBe("1.00")
  })

  it("returns empty when animation params match BRAND.md exactly", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_CANONICAL, BRAND_MD_WITH_ANIMATION)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when BRAND.md has no Glow section", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, REAL_BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when spec has no Animation section in Brand", () => {
    const drifts = auditAnimationTokens(REAL_SPEC_DRIFTED, BRAND_MD_WITH_ANIMATION)
    expect(drifts).toHaveLength(0)
  })

  it("detects delay drift (-0.5s in spec vs -1.8s in BRAND.md)", () => {
    const drifts = auditAnimationTokens(SPEC_ANIMATION_DRIFTED, BRAND_MD_WITH_ANIMATION)
    const delay = drifts.find(d => d.param === "glow-delay")
    expect(delay?.specValue).toBe("-0.5s")
    expect(delay?.brandValue).toBe("-1.8s")
  })

  it("returns empty when either input is empty", () => {
    expect(auditAnimationTokens("", BRAND_MD_WITH_ANIMATION)).toHaveLength(0)
    expect(auditAnimationTokens(SPEC_ANIMATION_DRIFTED, "")).toHaveLength(0)
  })
})

describe("auditAnimationTokens — section header format resilience", () => {
  // The design agent may write the Animation/Glow header in several ways.
  // These tests document which formats are handled and catch regressions if the
  // section extractor breaks on a variant the model starts producing.
  // Tests run via auditAnimationTokens (public API) — a parse failure means
  // zero drifts returned when drifts exist.
  // Values use CSS format (the format the design agent produces and the parser expects).

  const DRIFTED_CSS = [
    "**Violet glow:**",
    "```css",
    "filter: blur(200px);",
    "@keyframes h {",
    "  0%   { opacity: 0.45; }",
    "  12%  { opacity: 0.75; }",
    "  100% { opacity: 0.45; }",
    "}",
    "animation: h 2.5s linear infinite;",
    "```",
    "",
    "**Teal glow:**",
    "```css",
    "animation-delay: -0.5s;",
    "```",
  ].join("\n")

  function specWithHeader(header: string): string {
    return `## Brand\n\n**Color Palette**\n- \`--violet:\` \`#7C6FCD\`\n\n${header}\n${DRIFTED_CSS}\n`
  }

  it("**Animation & Glow** (standard format — must never regress)", () => {
    const drifts = auditAnimationTokens(specWithHeader("**Animation & Glow**"), BRAND_MD_WITH_ANIMATION)
    expect(drifts.some(d => d.param === "glow-duration")).toBe(true)
  })

  it("**Glow & Animation** (reversed order)", () => {
    const drifts = auditAnimationTokens(specWithHeader("**Glow & Animation**"), BRAND_MD_WITH_ANIMATION)
    expect(drifts.some(d => d.param === "glow-duration")).toBe(true)
  })

  it("**Glow** (minimal header, no 'Animation' word)", () => {
    const drifts = auditAnimationTokens(specWithHeader("**Glow**"), BRAND_MD_WITH_ANIMATION)
    expect(drifts.some(d => d.param === "glow-duration")).toBe(true)
  })

  it("**Animation & Glow:** (with colon)", () => {
    const drifts = auditAnimationTokens(specWithHeader("**Animation & Glow:**"), BRAND_MD_WITH_ANIMATION)
    expect(drifts.some(d => d.param === "glow-duration")).toBe(true)
  })

  it("Animation & Glow (no bold)", () => {
    const drifts = auditAnimationTokens(specWithHeader("Animation & Glow"), BRAND_MD_WITH_ANIMATION)
    expect(drifts.some(d => d.param === "glow-duration")).toBe(true)
  })
})

describe("auditAnimationTokens — CSS-format spec (real onboarding design fixture)", () => {
  // The real onboarding design spec writes the Brand section using CSS code blocks,
  // not prose key-value lines. These tests verify the parser handles the actual
  // format the design agent produces — not the prose format it was originally written for.
  const ONBOARDING_BRAND_SECTION = readFileSync(join(FIXTURE_DIR, "onboarding-design-brand-section.md"), "utf-8")
  const BRAND_MD_GLOW = readFileSync(join(FIXTURE_DIR, "brand-md-glow.md"), "utf-8")

  it("detects all 5 animation drifts in the real CSS-format spec", () => {
    const drifts = auditAnimationTokens(ONBOARDING_BRAND_SECTION, BRAND_MD_GLOW)
    expect(drifts).toHaveLength(5)
  })

  it("detects duration drift (spec 2.5s vs BRAND.md 4s)", () => {
    const drifts = auditAnimationTokens(ONBOARDING_BRAND_SECTION, BRAND_MD_GLOW)
    const d = drifts.find(x => x.param === "glow-duration")
    expect(d?.specValue).toBe("2.5s")
    expect(d?.brandValue).toBe("4s")
  })

  it("detects blur drift (spec 200px vs BRAND.md 80px)", () => {
    const drifts = auditAnimationTokens(ONBOARDING_BRAND_SECTION, BRAND_MD_GLOW)
    const d = drifts.find(x => x.param === "glow-blur")
    expect(d?.specValue).toBe("200px")
    expect(d?.brandValue).toBe("80px")
  })

  it("detects delay drift (spec -1.25s vs BRAND.md -1.8s)", () => {
    const drifts = auditAnimationTokens(ONBOARDING_BRAND_SECTION, BRAND_MD_GLOW)
    const d = drifts.find(x => x.param === "glow-delay")
    expect(d?.specValue).toBe("-1.25s")
    expect(d?.brandValue).toBe("-1.8s")
  })

  it("detects opacity-min drift (spec 0.10 vs BRAND.md 0.55)", () => {
    const drifts = auditAnimationTokens(ONBOARDING_BRAND_SECTION, BRAND_MD_GLOW)
    const d = drifts.find(x => x.param === "glow-opacity-min")
    expect(d?.specValue).toBe("0.10")
    expect(d?.brandValue).toBe("0.55")
  })

  it("detects opacity-max drift (spec 0.15 vs BRAND.md 1.00)", () => {
    const drifts = auditAnimationTokens(ONBOARDING_BRAND_SECTION, BRAND_MD_GLOW)
    const d = drifts.find(x => x.param === "glow-opacity-max")
    expect(d?.specValue).toBe("0.15")
    expect(d?.brandValue).toBe("1.00")
  })
})

describe("auditMissingBrandTokens", () => {
  it("detects a token in BRAND.md that is entirely absent from the spec", () => {
    // --accent is in brand, spec only has --bg
    const brandWithAccent = `${REAL_BRAND_MD}\n--accent: #FF6B35\n`
    const specWithoutAccent = `## Brand\n--bg: #0A0A0F\n`
    const missing = auditMissingBrandTokens(specWithoutAccent, brandWithAccent)
    expect(missing.map(m => m.token)).toContain("--accent")
  })

  it("does NOT flag drifted tokens as missing — wrong value present is not absent", () => {
    // spec has --violet but with wrong value — that's drift, not missing
    const spec = `## Brand\n--violet: #8B7FE8\n`
    const missing = auditMissingBrandTokens(spec, REAL_BRAND_MD)
    expect(missing.map(m => m.token)).not.toContain("--violet")
  })

  it("returns empty when brand has no tokens", () => {
    const brandNoTokens = `## Brand\nNo CSS variables here.\n`
    const missing = auditMissingBrandTokens(REAL_SPEC_CANONICAL, brandNoTokens)
    expect(missing).toHaveLength(0)
  })

  it("case-insensitive token matching — --PRIMARY in brand matches --primary in spec", () => {
    const brandUppercase = `--PRIMARY: #7C6FCD\n`
    const specLowercase = `## Brand\n--primary: #7C6FCD\n`
    const missing = auditMissingBrandTokens(specLowercase, brandUppercase)
    expect(missing).toHaveLength(0)
  })

  it("returns empty when both inputs are empty", () => {
    expect(auditMissingBrandTokens("", REAL_BRAND_MD)).toHaveLength(0)
    expect(auditMissingBrandTokens(REAL_SPEC_CANONICAL, "")).toHaveLength(0)
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

  it("does not flag BRAND.md tokens absent from the spec — absent is not drifted", () => {
    // Spec only defines --bg (wrong value). --violet is absent — that is not drift.
    const specPartial = `## Brand\n--bg: #0A0E27\n`
    const drifts = auditBrandTokens(specPartial, REAL_BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).toContain("--bg")        // present and wrong — drift
    expect(tokens).not.toContain("--violet") // absent — not drift
  })

  it("detects drift in Design System Updates section — not just ## Brand", () => {
    // Brand section is correct; Design System Updates proposes stale values.
    // The full-spec scan must surface the stale tokens — previously invisible to the auditor.
    const specWithStaleDSU = `## Brand

**Color Palette**
- \`--bg:\` \`#0A0A0F\`
- \`--violet:\` \`#7C6FCD\`
- \`--teal:\` \`#4FAFA8\`

## Design System Updates

[PROPOSED ADDITION]

\`\`\`
--bg:     #0A0E27
--violet: #8B7FE8
--teal:   #4FADA8
\`\`\`
`
    const drifts = auditBrandTokens(specWithStaleDSU, REAL_BRAND_MD)
    const tokens = drifts.map(d => d.token)
    // Stale values in Design System Updates section must be caught
    expect(tokens).toContain("--bg")
    expect(tokens).toContain("--violet")
    expect(tokens).toContain("--teal")
  })

  it("reports each drifted token once even if it appears multiple times in the spec", () => {
    const specRepeated = `## Brand\n--violet: #7C6FCD\n\n## Design System Updates\n--violet: #8B7FE8\n--violet: #9999FF\n`
    const drifts = auditBrandTokens(specRepeated, REAL_BRAND_MD)
    const violetDrifts = drifts.filter(d => d.token === "--violet")
    expect(violetDrifts).toHaveLength(1)
    expect(violetDrifts[0].specValue).toBe("#8B7FE8") // first drifted value wins
  })
})
