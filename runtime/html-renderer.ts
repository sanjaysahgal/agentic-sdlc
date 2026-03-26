import Anthropic from "@anthropic-ai/sdk"

// 5 minute timeout — consistent with claude-client.ts. Without this, the default
// is 10 minutes, which leaves the user staring at "thinking" for far too long.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000 })

// Generates a self-contained HTML preview from a design spec.
// Uses Tailwind CDN + Alpine.js for interactivity — no build step, no external deps.
// Each screen gets a tab. Each screen state (default/loading/empty/error) gets a toggle.
// Non-fatal — caller should catch and handle gracefully.
export async function generateDesignPreview(params: {
  specContent: string
  featureName: string
}): Promise<string> {
  const { specContent, featureName } = params

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
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

## Tailwind custom config — always set BEFORE the Tailwind CDN script

Read the Brand section of the spec for exact hex values. Configure them like this:
\`\`\`html
<script>
  window.tailwind = {
    theme: {
      extend: {
        colors: {
          "primary": "#0A0A0F",
          "surface": "#13131A",
          "fg": "#F8F8F7",
          "accent": "#7C3AED",
          "accent2": "#0EA5E9"
          // use the ACTUAL values from the spec — never invent colors
        },
        keyframes: {
          "glow-pulse": {
            "0%, 100%": { opacity: "0.35" },
            "50%": { opacity: "0.65" }
          }
          // include ALL animations from the spec
        },
        animation: {
          "glow-pulse": "glow-pulse 2.5s ease-in-out infinite"
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

When the spec describes a pulsing glow effect, use this EXACT structure. Do not improvise. Do not use Tailwind keyframes for the glow — use a \`<style>\` tag placed in \`<head>\`.

**Step 1 — add glow keyframe to \`<head>\`:**
\`\`\`html
<style>
  @keyframes glow-pulse {
    0%, 100% { opacity: 0.45; }
    50%       { opacity: 0.75; }
  }
</style>
\`\`\`

**Step 2 — wrap the target element in a relative container and place the glow div as the FIRST child:**
\`\`\`html
<div class="relative">
  <!-- glow: first child so it renders behind content; use colors from spec -->
  <div aria-hidden="true" class="absolute inset-0 pointer-events-none"
       style="background: radial-gradient(ellipse at 50% 85%, rgba(124,111,205,0.65) 0%, rgba(79,175,168,0.35) 45%, transparent 70%);
              filter: blur(48px);
              animation: glow-pulse 2.5s ease-in-out infinite;
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
- Use \`filter: blur(40px)\` or higher on the glow div — this creates the soft-bloom look; without it the gradient has hard edges
- Opacity range 0.40–0.80 — values below 0.30 are invisible on dark backgrounds in practice
- Use inline \`style=""\` for radial-gradient and filter — never Tailwind \`from-*/to-*\` classes for arbitrary rgba values
- If the spec names TWO glow locations (e.g. home prompt bar AND auth sheet), implement BOTH independently with separate glow divs

## Structure

Use Alpine.js x-data on the body to manage:
- activeScreen: index of the currently visible screen (default 0)
- states: object mapping screen index → current state name (default "default")

Navigation bar at the top with one tab per screen. Active tab is visually distinct.

For each screen:
- A row of small pill buttons to switch between its states: Default, Loading, Empty, Error, plus any feature-specific states named in the spec
- The content area renders the correct state

## Visual fidelity

This is NOT a wireframe — it should look close to the real product. Apply:
- The exact colors, fonts, and spacing from the Brand and Design Direction sections
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
        content: `Feature: ${featureName}

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
  // Throw so the caller's non-fatal error handler surfaces a useful message instead
  // of uploading broken HTML to the designer.
  if (!html.includes("</html>")) {
    throw new Error("HTML preview was truncated before </html> — spec may be too large for a single render pass")
  }

  return html
}
