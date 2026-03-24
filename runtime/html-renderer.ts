import Anthropic from "@anthropic-ai/sdk"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
    max_tokens: 8000,
    system: `You generate beautiful, self-contained HTML preview files directly from design specs. The output will be opened in a browser to let a designer approve or iterate on the spec before it goes to engineering.

## Output requirements

Output ONLY the raw HTML — no explanation, no markdown fences, no preamble. Start with <!DOCTYPE html> and end with </html>.

## Technical requirements

- Single self-contained file
- Tailwind CSS via CDN: <script src="https://cdn.tailwindcss.com"></script>
- Alpine.js via CDN: <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
- No other external JavaScript dependencies
- Works when opened directly from disk (no server needed)

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
- If custom colors are specified, configure them via Tailwind's inline config (window.tailwind = { theme: { extend: { colors: {...} } } }) before the Tailwind script
- Generous whitespace, careful typography, real-looking content (not Lorem Ipsum — use the feature domain)
- Realistic component states: loading spinners use actual animated CSS, empty states have an icon and helpful message, error states are visually distinct (red accent, clear message)

## Interactions
- Screen navigation tabs: clicking switches the visible screen
- State pills: clicking switches that screen's visible state
- Any key interactions from the spec (e.g. button clicks that reveal a next screen): wire them up so the designer can feel the flow
- Smooth transitions between states (CSS transition on opacity)

## Mobile-first
Default width should be a mobile frame (max-w-sm centered) with a toggle to expand to full-width desktop. Show which breakpoint is active.`,
    messages: [
      {
        role: "user",
        content: `Feature: ${featureName}

${specContent}`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : ""

  // Strip any accidental markdown fences the model may have added
  return text
    .replace(/^```html\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim()
}
