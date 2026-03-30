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
 * Parses animation parameters from BRAND.md's ## Glow section (CSS format).
 * Reads the canonical CSS that the team actually committed — never a platform-invented
 * key-value block. Extracts:
 *   glow-duration  — from `animation: <name> Xs ...`
 *   glow-blur      — from `filter: blur(Xpx)`
 *   glow-delay     — from `animation-delay: Xs`
 *   glow-opacity-min / glow-opacity-max — from the first @keyframes block (violet glow)
 */
function extractBrandAnimationParams(brandMd: string): Map<string, string> {
  const params = new Map<string, string>()
  const glowSection = brandMd.match(/## Glow[^\n]*\n([\s\S]*?)(?=\n## |\n---|$)/)?.[1] ?? ""
  if (!glowSection) return params

  const durationMatch = glowSection.match(/animation:\s*\S+\s+([\d.]+s)/)
  if (durationMatch) params.set("glow-duration", durationMatch[1])

  const blurMatch = glowSection.match(/filter:\s*blur\(([\d.]+px)\)/)
  if (blurMatch) params.set("glow-blur", blurMatch[1])

  const delayMatch = glowSection.match(/animation-delay:\s*([-\d.]+s)/)
  if (delayMatch) params.set("glow-delay", delayMatch[1])

  // First @keyframes block is the violet glow — canonical source for opacity values.
  // Matches from @keyframes through the closing } on its own line.
  const keyframeBlock = glowSection.match(/@keyframes[^{]*\{([\s\S]*?)\n\}/)?.[1]
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
 * Extracts the Animation/Glow sub-section from a design spec's Brand section.
 * Matches section headers containing "Animation", "Glow", or both.
 */
function extractSpecAnimationSection(specContent: string): string {
  const brandSection = extractBrandSection(specContent)
  const match = brandSection.match(/\*{0,2}(?:Animation|Glow)[^*\n]*\*{0,2}[^\n]*\n([\s\S]*?)(?=\n\*{0,2}[A-Z]|\n#{1,4}|\n---|\n\n##|$)/i)
  return match?.[1] ?? ""
}

/**
 * Extracts a numeric value + optional unit from an animation spec line.
 * e.g. "- Duration: `2.5s ease-in-out`" → "2.5s"
 * Uses a non-greedy match before the value to avoid backtracking past the target value itself.
 */
function extractSpecAnimValue(section: string, keyword: string): string | undefined {
  // Avoid greedy [^\n]* before the capture group — it causes backtracking past the target value.
  // Instead match: keyword ... : whitespace tilde? backtick? captured-value
  // The tilde prefix (~200px) is common in spec prose and must be stripped before numeric extraction.
  const re = new RegExp(`${keyword}[^:\\n]*:\\s*~?\`?(-?[\\d.]+(?:px|s|ms))\`?`, "i")
  const match = section.match(re)
  return match?.[1]
}

/**
 * Extracts opacity min and max from the spec's "Opacity cycle: X → Y" line.
 * The design agent writes opacity as a range, not two separate labelled values.
 * e.g. "- Opacity cycle: 0.45 → 0.75" → { min: "0.45", max: "0.75" }
 */
function extractSpecOpacityRange(section: string): { min: string; max: string } | undefined {
  const match = section.match(/opacity[^:\n]*:\s*([\d.]+)\s*→\s*([\d.]+)/i)
  if (!match) return undefined
  return { min: match[1], max: match[2] }
}

/**
 * Diffs the design spec's Brand animation section against BRAND.md animation params.
 * Returns any params that exist in both but have different values.
 *
 * Pure string operation — no API call, no I/O, no side effects.
 */
export function auditAnimationTokens(specContent: string, brandMd: string): AnimationDrift[] {
  if (!brandMd || !specContent) return []
  const brandParams = extractBrandAnimationParams(brandMd)
  if (brandParams.size === 0) return []
  const specAnimSection = extractSpecAnimationSection(specContent)
  if (!specAnimSection) return []

  const drifts: AnimationDrift[] = []

  const checks: Array<{ param: string; keyword: string }> = [
    { param: "glow-duration", keyword: "duration" },
    { param: "glow-blur", keyword: "blur" },
    { param: "glow-delay", keyword: "delay" },
  ]

  for (const { param, keyword } of checks) {
    const brandValue = brandParams.get(param)
    if (!brandValue) continue
    const specValue = extractSpecAnimValue(specAnimSection, keyword)
    if (specValue && specValue !== brandValue) {
      drifts.push({ param, specValue, brandValue })
    }
  }

  // Opacity is written as a range ("Opacity cycle: X → Y") — handled separately.
  const opacityRange = extractSpecOpacityRange(specAnimSection)
  if (opacityRange) {
    const minBrand = brandParams.get("glow-opacity-min")
    if (minBrand && opacityRange.min !== minBrand) {
      drifts.push({ param: "glow-opacity-min", specValue: opacityRange.min, brandValue: minBrand })
    }
    const maxBrand = brandParams.get("glow-opacity-max")
    if (maxBrand && opacityRange.max !== maxBrand) {
      drifts.push({ param: "glow-opacity-max", specValue: opacityRange.max, brandValue: maxBrand })
    }
  }

  return drifts
}

/**
 * Diffs the design spec's Brand section against BRAND.md canonical token values.
 * Returns any CSS variable tokens that exist in both documents but have different hex values in the spec.
 *
 * Pure string operation — no API call, no I/O, no side effects.
 * Safe to run on every agent response without latency concern.
 */
export function auditBrandTokens(specContent: string, brandMd: string): BrandDrift[] {
  if (!brandMd || !specContent) return []
  const brandTokens = extractTokenMap(brandMd)
  if (brandTokens.size === 0) return []
  const brandSection = extractBrandSection(specContent)
  if (!brandSection) return []
  const specTokens = extractTokenMap(brandSection)
  const drifts: BrandDrift[] = []
  for (const [token, brandValue] of brandTokens) {
    const specValue = specTokens.get(token)
    if (specValue && specValue !== brandValue) {
      drifts.push({ token, specValue, brandValue })
    }
  }
  return drifts
}
