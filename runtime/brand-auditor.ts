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
