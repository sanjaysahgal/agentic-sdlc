import Anthropic from "@anthropic-ai/sdk"

// 5 minute timeout — consistent with claude-client.ts.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000 })

/**
 * Validates structural properties of rendered HTML without hardcoding brand values.
 * Checks that the renderer produced what the system prompt instructed.
 * Returns a list of issues to surface to the agent (and thus the user).
 */
function validateRenderedHtml(html: string, brandContent?: string): string[] {
  const issues: string[] = []

  if (!html.includes("@keyframes")) {
    issues.push("No CSS keyframe animations found — glow animation likely missing")
  }
  if (!html.trim().endsWith("</html>")) {
    issues.push("HTML appears truncated — missing closing </html>")
  }

  if (brandContent) {
    // Extract the canonical background token from BRAND.md to verify it was applied.
    // This is the only brand-specific check — derived from runtime BRAND.md, never hardcoded.
    const bgMatch = brandContent.match(/--bg:\s*(#[0-9A-Fa-f]{6})/)
    if (bgMatch && !html.includes(bgMatch[1])) {
      issues.push(`Background token ${bgMatch[1]} (--bg from BRAND.md) not found in rendered HTML`)
    }
  }

  return issues
}

// Generates a self-contained HTML preview from a design spec.
// Uses Tailwind CDN + Alpine.js for interactivity — no build step, no external deps.
// Each screen gets a tab. Each screen state (default/loading/empty/error) gets a toggle.
// Non-fatal — caller should catch and handle gracefully.
export async function generateDesignPreview(params: {
  specContent: string
  featureName: string
  brandContent?: string
}): Promise<{ html: string; warnings: string[] }> {
  const { specContent, featureName, brandContent } = params

  // Prepend BRAND.md as an authoritative section when available.
  // The renderer reads color values, animation params, and typography from here —
  // not from the spec's Brand section (which may have drifted).
  const brandBlock = brandContent
    ? `AUTHORITATIVE BRAND TOKENS (from BRAND.md — use these exact values, not the spec's Brand section):
${brandContent}

---

`
    : ""

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 32000,
    system: `You generate beautiful, self-contained HTML preview files directly from design specs. The output will be opened in a browser to let a designer approve or iterate on the spec before it goes to engineering.

## Output requirements

Output ONLY the raw HTML — no explanation, no markdown fences, no preamble. Start with <!DOCTYPE html> and end with </html>.

**Critical: always output a complete, valid HTML file.** If the spec is complex, be concise in your implementation — use Tailwind classes aggressively, keep custom CSS minimal. An incomplete file (cut off before </html>) is a total failure — the designer will see a broken, partially-rendered screen. Concise and complete is always better than verbose and truncated.

## Technical requirements

- Single self-contained file
- Tailwind CSS via CDN with inline config for custom colors/animations
- Alpine.js via CDN for screen switching and state toggles
- No other external JavaScript dependencies
- Works when opened directly from disk (no server needed)

## Brand tokens — use AUTHORITATIVE BRAND TOKENS section above

When the user message begins with "AUTHORITATIVE BRAND TOKENS", those are the production-calibrated values. Use them verbatim — do NOT use values from the spec's Brand section, which may have drifted.

Configure Tailwind with the exact values from AUTHORITATIVE BRAND TOKENS:
\`\`\`html
<script>
  window.tailwind = {
    theme: {
      extend: {
        colors: {
          // Map token names to exact hex values from AUTHORITATIVE BRAND TOKENS
          // "primary" → --bg value, "surface" → --surface value, "fg" → --text value
          // "accent" → --violet value, "accent2" → --teal value
          "primary": "<--bg hex>",
          "surface": "<--surface hex>",
          "fg": "<--text hex>",
          "accent": "<--violet or primary accent hex>",
          "accent2": "<--teal or secondary accent hex>"
          // use the ACTUAL values from AUTHORITATIVE BRAND TOKENS — never invent colors
        },
        keyframes: {
          "glow-pulse": {
            // Use opacity values from AUTHORITATIVE BRAND TOKENS (glow-opacity-min / glow-opacity-max)
            // If not specified, use 0.55 → 1.00 for a prominent visible glow on dark backgrounds
            "0%, 100%": { opacity: "<glow-opacity-min>" },
            "50%": { opacity: "<glow-opacity-max>" }
          }
          // include ALL animations from the spec
        },
        animation: {
          // Use duration from AUTHORITATIVE BRAND TOKENS (glow-duration) if specified
          "glow-pulse": "glow-pulse <glow-duration> ease-in-out infinite"
        }
      }
    }
  }
</script>
<script src="https://cdn.tailwindcss.com"></script>
\`\`\`

**Color naming rule:** Name colors WITHOUT a CSS-property prefix. Use \`"primary"\` not \`"bg-primary"\` — then use them as \`bg-primary\`, \`text-fg\`, \`border-accent\` etc. The prefix comes from Tailwind, not the color name.

**This is how to get custom colors and animations into Tailwind — never skip this step.** If you define colors in the config, you can use them as Tailwind classes. If you skip this, all custom colors will fail to render — the designer will see a broken black screen instead of the designed palette.

## Glow and gradient effects — use this exact pattern, always

When the spec describes a pulsing glow effect, use this EXACT structure. Do not improvise.

**Step 1 — add glow keyframe to \`<head>\`:**
Use the opacity values from AUTHORITATIVE BRAND TOKENS (glow-opacity-min and glow-opacity-max). These are calibrated for dark backgrounds.
\`\`\`html
<style>
  @keyframes glow-pulse {
    0%, 100% { opacity: <glow-opacity-min from BRAND>; }
    50%       { opacity: <glow-opacity-max from BRAND>; }
  }
</style>
\`\`\`

**Step 2 — wrap the target element in a relative container and place the glow div as the FIRST child:**
Use the --violet and --teal hex values converted to rgba for the gradient. Use blur value from AUTHORITATIVE BRAND TOKENS (glow-blur).
\`\`\`html
<div class="relative">
  <!-- glow: first child so it renders behind content -->
  <div aria-hidden="true" class="absolute inset-0 pointer-events-none"
       style="background: radial-gradient(ellipse at 50% 85%, rgba(<--violet as rgb>,0.65) 0%, rgba(<--teal as rgb>,0.35) 45%, transparent 70%);
              filter: blur(<glow-blur from BRAND>);
              animation: glow-pulse <glow-duration from BRAND> ease-in-out infinite;
              z-index: 0;"></div>
  <!-- content: always sits above the glow -->
  <div class="relative" style="z-index: 1;">
    <!-- actual screen content here -->
  </div>
</div>
\`\`\`

**Rules that must not be broken:**
- Always use a \`<style>\` keyframe for glow animation — Tailwind CDN keyframes are unreliable for glow
- Glow div must be the FIRST child inside the relative wrapper — later siblings stack on top via z-index
- Content must be in a div with \`position: relative; z-index: 1\` — without this, content sits behind the glow
- Use blur value from AUTHORITATIVE BRAND TOKENS for \`filter: blur()\` — this creates the soft-bloom look
- Use opacity values from AUTHORITATIVE BRAND TOKENS for the glow keyframe
- Use inline \`style=""\` for radial-gradient and filter — never Tailwind \`from-*/to-*\` classes for arbitrary rgba values
- If the spec names TWO glow locations (e.g. home prompt bar AND auth sheet), implement BOTH independently with separate glow divs

## Gradient text on headings

Primary headings (h1, wordmark, feature name) should use gradient text where the spec describes a gradient accent. Apply:
\`\`\`html
<h1 style="background: linear-gradient(135deg, <--violet hex>, <--teal hex>); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
  Heading Text
</h1>
\`\`\`
Use the actual accent hex values from AUTHORITATIVE BRAND TOKENS.

## Structure

Use Alpine.js x-data on the body to manage:
- activeScreen: index of the currently visible screen (default 0)
- states: object mapping screen index → current state name (default "default")

Navigation bar at the top with one tab per screen. Active tab is visually distinct.

For each screen:
- A row of small pill buttons to switch between its states: Default, Loading, Empty, Error, plus any feature-specific states named in the spec
- The content area renders the correct state

**Suggestion chips and action pills must always be in a horizontal row** — never stacked vertically. Use \`display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px;\` so they wrap at narrow viewports instead of stacking.

## Visual fidelity

This is NOT a wireframe — it should look close to the real product. Apply:
- The exact colors, fonts, and spacing from AUTHORITATIVE BRAND TOKENS and Design Direction sections
- If a Google Font is specified, load it via a <link> tag
- Generous whitespace, careful typography, real-looking content (not Lorem Ipsum — use the feature domain)
- Realistic component states: loading spinners use animated CSS, empty states have an icon and message, error states are visually distinct

## Interactions and animations

Read the spec's Interactions sections carefully. Implement:
- Screen navigation tabs
- State pills per screen
- Any animations described (glow pulses, fade choreography, transitions) — these MUST be implemented, not omitted. Use CSS keyframe animations via the Tailwind config above.
- Smooth transitions between states

## Input fields — always legible

For any text input or textarea:
- Set explicit text color that contrasts with the input background
- On dark backgrounds: text-text-primary or text-white. NEVER leave input color as browser default on a dark-bg page — the default is black, which produces black-on-black text.

## Sheets, modals, and auth flows

If the spec describes an auth sheet, login sheet, or bottom sheet that slides up over a screen:
- Give it its OWN named tab in the navigation bar (e.g. "Auth Sheet", "Login")
- Do NOT hide it as a conditional overlay that requires clicking through another screen
- Render its content fully — SSO buttons, dividers, copy, glow effects — exactly as specified

Every named screen and every named state (auth, onboarding, empty, loading, error) must be reachable directly from the nav bar or state pills. Nothing should require navigating through other states to see.

## Mobile-first
Default width should be a mobile frame (max-w-sm centered) with a toggle to expand to full-width desktop.`,
    messages: [
      {
        role: "user",
        content: `${brandBlock}Feature: ${featureName}

${specContent}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : ""

  const html = text
    .replace(/^```html\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim()

  // Validate completeness — a truncated HTML file renders as a broken screen.
  if (!html.includes("</html>")) {
    throw new Error("HTML preview was truncated before </html> — spec may be too large for a single render pass")
  }

  const warnings = validateRenderedHtml(html, brandContent)
  return { html, warnings }
}
