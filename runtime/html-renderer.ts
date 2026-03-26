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
          "bg-primary": "#0A0A0F",
          "surface": "#13131A",
          "text-primary": "#F8F8F7",
          "accent": "#7C3AED"
          // etc — use the actual values from the spec
        },
        keyframes: {
          "glow-pulse": {
            "0%, 100%": { opacity: "0.10" },
            "50%": { opacity: "0.15" }
          }
          // etc — include all animations from the spec
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

**This is how to get custom colors and animations into Tailwind — never skip this step.** If you define colors in the config, you can use them as Tailwind classes (bg-bg-primary, text-text-primary, etc). If you skip this, all custom colors will fail to render — the designer will see a broken black screen instead of the designed palette.

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
