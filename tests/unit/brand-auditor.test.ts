import { describe, it, expect } from "vitest"
import { auditBrandTokens, BrandDrift } from "../../runtime/brand-auditor"

const BRAND_MD = `
## Color Palette

\`\`\`
--bg:       #0A0A0F
--surface:  #13131A
--text:     #F8F8F7
--violet:   #7C6FCD
--teal:     #4FAFA8
--error:    #e06c75
\`\`\`
`

const SPEC_CORRECT = `
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

const SPEC_DRIFTED = `
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

const SPEC_NO_BRAND_SECTION = `
## Design Direction
Dark mode, minimal.

## Screens
### Screen: Home
Purpose: Chat entry.
`

describe("auditBrandTokens", () => {
  it("returns empty array when spec Brand section matches BRAND.md exactly", () => {
    const drifts = auditBrandTokens(SPEC_CORRECT, BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("returns drifted tokens when spec Brand section has wrong values", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED, BRAND_MD)
    expect(drifts.length).toBeGreaterThan(0)
  })

  it("identifies the exact drifted tokens by name", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED, BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).toContain("--bg")
    expect(tokens).toContain("--surface")
    expect(tokens).toContain("--violet")
    expect(tokens).toContain("--teal")
  })

  it("does not flag tokens that match BRAND.md (--text and --error are correct)", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED, BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).not.toContain("--text")
    expect(tokens).not.toContain("--error")
  })

  it("includes specValue and brandValue in each drift entry", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED, BRAND_MD)
    const violet = drifts.find(d => d.token === "--violet")
    expect(violet).toBeDefined()
    expect(violet!.specValue).toBe("#8B7FE8")
    expect(violet!.brandValue).toBe("#7C6FCD")
  })

  it("normalizes hex values to uppercase for comparison", () => {
    const brandWithLower = BRAND_MD.replace("#e06c75", "#e06c75") // already lowercase
    const specWithUpper = SPEC_CORRECT.replace("#e06c75", "#E06C75") // uppercase in spec
    const drifts = auditBrandTokens(specWithUpper, brandWithLower)
    // --error should NOT be flagged — same value, different case
    const tokens = drifts.map(d => d.token)
    expect(tokens).not.toContain("--error")
  })

  it("returns empty when spec has no Brand section", () => {
    const drifts = auditBrandTokens(SPEC_NO_BRAND_SECTION, BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when brandMd is empty", () => {
    const drifts = auditBrandTokens(SPEC_DRIFTED, "")
    expect(drifts).toHaveLength(0)
  })

  it("returns empty when specContent is empty", () => {
    const drifts = auditBrandTokens("", BRAND_MD)
    expect(drifts).toHaveLength(0)
  })

  it("does not flag BRAND.md tokens that are absent from the spec Brand section (absent ≠ drifted)", () => {
    // Spec only defines --bg, not --violet. --violet being absent is not drift — it was never set.
    const specPartial = `## Brand\n--bg: #0A0E27\n`
    const drifts = auditBrandTokens(specPartial, BRAND_MD)
    const tokens = drifts.map(d => d.token)
    expect(tokens).toContain("--bg")        // present but wrong — drift
    expect(tokens).not.toContain("--violet") // absent from spec — not drift
  })
})
