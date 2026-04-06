// Brand token audit — pure string diff, no API call.
// Compares the design spec's Brand section against BRAND.md canonical token values.
//
// This runs on every design agent response — not as a reaction to a user report,
// but as a standing proactive check. The principle: the specialist agent surfaces
// all known constraint violations without waiting to be asked.

export interface BrandDrift {
  token: string       // CSS variable name e.g. "--violet"
  specValue: string   // value in the spec e.g. "#8B7FE8"
  brandValue: string  // canonical value in BRAND.md e.g. "#7C6FCD"
}

export interface AnimationDrift {
  param: string       // e.g. "glow-duration"
  specValue: string   // e.g. "2.5s"
  brandValue: string  // e.g. "4s"
}

/**
 * Parses CSS-variable color tokens from a markdown document.
 * Handles both standard CSS format (`--token: #RRGGBB`) and the spec's
 * backtick-span format (`` `--token:` `#RRGGBB` ``).
 * Matches token name and hex value anywhere on the same line.
 */
function extractTokenMap(text: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const line of text.split("\n")) {
    const tokenMatch = line.match(/--(\w[\w-]*):/)
    if (!tokenMatch) continue
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})\b/)
    if (!hexMatch) continue
    tokens.set(`--${tokenMatch[1]}`, `#${hexMatch[1].toUpperCase()}`)
  }
  return tokens
}

/**
 * Extracts the Brand section from a design spec (text between ## Brand and the next ##).
 */
function extractBrandSection(specContent: string): string {
  const match = specContent.match(/## Brand\n([\s\S]*?)(?=\n## |\n---|\n# (?!#)|$)/)
  return match?.[1] ?? ""
}

/**
 * Extracts animation parameters from a raw CSS glow section string.
 * Used by both BRAND.md parsing (after isolating the ## Glow section)
 * and spec parsing (after isolating the **Glow...** subsection).
 * Same parser, same format — no wrapper or synthetic headers needed.
 *
 * Extracts:
 *   glow-duration  — from `animation: <name> Xs ...`
 *   glow-blur      — from `filter: blur(Xpx)`
 *   glow-delay     — from `animation-delay: Xs`
 *   glow-opacity-min / glow-opacity-max — from the first @keyframes block (violet glow)
 */
function extractAnimParamsFromCssSection(section: string): Map<string, string> {
  const params = new Map<string, string>()

  const durationMatch = section.match(/animation:\s*\S+\s+([\d.]+s)/)
  if (durationMatch) params.set("glow-duration", durationMatch[1])

  const blurMatch = section.match(/filter:\s*blur\(([\d.]+px)\)/)
  if (blurMatch) params.set("glow-blur", blurMatch[1])

  const delayMatch = section.match(/animation-delay:\s*([-\d.]+s)/)
  if (delayMatch) params.set("glow-delay", delayMatch[1])

  // First @keyframes block is the violet glow — canonical source for opacity values.
  // Matches from @keyframes through the closing } on its own line.
  const keyframeBlock = section.match(/@keyframes[^{]*\{([\s\S]*?)\n\}/)?.[1]
  if (keyframeBlock) {
    const opacityMinMatch = keyframeBlock.match(/0%\s*\{[^}]*opacity:\s*([\d.]+)/)
    if (opacityMinMatch) params.set("glow-opacity-min", opacityMinMatch[1])

    const allOpacities = [...keyframeBlock.matchAll(/opacity:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))
    if (allOpacities.length > 0) {
      params.set("glow-opacity-max", Math.max(...allOpacities).toFixed(2))
    }
  }

  return params
}

/**
 * Finds the ## Glow section in a BRAND.md document and delegates to extractAnimParamsFromCssSection.
 */
function extractBrandAnimationParams(brandMd: string): Map<string, string> {
  const glowSection = brandMd.match(/## Glow[^\n]*\n([\s\S]*?)(?=\n## |\n---|$)/)?.[1] ?? ""
  if (!glowSection) return new Map()
  return extractAnimParamsFromCssSection(glowSection)
}

/**
 * Extracts the Animation/Glow sub-section from a design spec's Brand section.
 * Matches section headers containing "Animation", "Glow", or both.
 */
function extractSpecAnimationSection(specContent: string): string {
  const brandSection = extractBrandSection(specContent)
  // Stop only at markdown section boundaries (## headings, ---, end of string).
  // Previously included \n\*{0,2}[A-Z] which terminated at any bold sub-heading
  // inside the Glow section (e.g. **Violet glow:**), causing the CSS code blocks
  // to be cut off and the parser to return an empty capture.
  const match = brandSection.match(/\*{0,2}(?:Animation|Glow)[^*\n]*\*{0,2}[^\n]*\n([\s\S]*?)(?=\n#{1,4}|\n---|\n\n##|$)/i)
  return match?.[1] ?? ""
}

/**
 * Diffs the design spec's Brand animation section against BRAND.md animation params.
 * Returns any params that exist in both but have different values.
 *
 * Both sides use CSS format — the same format BRAND.md uses and the design agent system
 * prompt prescribes. extractAnimParamsFromCssSection parses both without any wrapping.
 *
 * Pure string operation — no API call, no I/O, no side effects.
 */
export function auditAnimationTokens(specContent: string, brandMd: string): AnimationDrift[] {
  if (!brandMd || !specContent) return []
  const brandParams = extractBrandAnimationParams(brandMd)
  if (brandParams.size === 0) return []
  const specAnimSection = extractSpecAnimationSection(specContent)
  if (!specAnimSection) return []

  const specParams = extractAnimParamsFromCssSection(specAnimSection)
  const drifts: AnimationDrift[] = []
  for (const [param, brandValue] of brandParams) {
    const specValue = specParams.get(param)
    if (specValue && specValue !== brandValue) {
      drifts.push({ param, specValue, brandValue })
    }
  }
  return drifts
}

/**
 * Diffs the design spec against BRAND.md canonical token values.
 * Scans the entire spec — not just the ## Brand section — so drift in Design System
 * Updates, proposed additions, or any other section is surfaced. Each drifted token is
 * reported once regardless of how many times it appears, using the first differing value found.
 *
 * Pure string operation — no API call, no I/O, no side effects.
 * Safe to run on every agent response without latency concern.
 */
export function auditBrandTokens(specContent: string, brandMd: string): BrandDrift[] {
  if (!brandMd || !specContent) return []
  const brandTokens = extractTokenMap(brandMd)
  if (brandTokens.size === 0) return []

  // Collect all token values seen anywhere in the spec. Scan line by line so we
  // can detect multiple differing values for the same token (e.g. Brand section is
  // correct but Design System Updates section uses stale values). Report each drifted
  // token once — the first non-canonical value found wins so the human sees it clearly.
  const driftMap = new Map<string, string>() // token → first drifted specValue
  for (const line of specContent.split("\n")) {
    const tokenMatch = line.match(/--(\w[\w-]*):/)
    if (!tokenMatch) continue
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})\b/)
    if (!hexMatch) continue
    const token = `--${tokenMatch[1]}`
    const specValue = `#${hexMatch[1].toUpperCase()}`
    const brandValue = brandTokens.get(token)
    if (brandValue && specValue !== brandValue && !driftMap.has(token)) {
      driftMap.set(token, specValue)
    }
  }

  return Array.from(driftMap.entries()).map(([token, specValue]) => ({
    token,
    specValue,
    brandValue: brandTokens.get(token)!,
  }))
}

/**
 * Detects canonical tokens from BRAND.md that are entirely absent from the design spec.
 * A token that appears with the wrong value is "drifted" (reported by auditBrandTokens) —
 * this function only flags tokens that do not appear anywhere in the spec at all.
 *
 * Pure string operation — no API call, no I/O, no side effects.
 */
export function auditMissingBrandTokens(specContent: string, brandMd: string): Array<{ token: string; brandValue: string }> {
  if (!brandMd || !specContent) return []
  const brandTokens = extractTokenMap(brandMd)
  if (brandTokens.size === 0) return []

  const missing: Array<{ token: string; brandValue: string }> = []
  for (const [token, brandValue] of brandTokens) {
    // Escape the -- prefix for regex and match case-insensitively
    const escapedToken = token.replace(/[-]/g, "\\-")
    const tokenRegex = new RegExp(escapedToken, "i")
    if (!tokenRegex.test(specContent)) {
      missing.push({ token, brandValue })
    }
  }
  return missing
}
