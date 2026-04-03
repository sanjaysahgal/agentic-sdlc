import Anthropic from "@anthropic-ai/sdk"

// 5 minute timeout, no retries — a timed-out 32k-token render won't succeed on retry,
// it just triples the user's wait. Fail fast and let the caller handle gracefully.
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 0 })

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
  // Body background must be in explicit CSS — Tailwind custom classes fail on file:// URLs
  if (!html.match(/body\s*\{[^}]*background(?:-color)?:/s)) {
    issues.push("Body has no explicit CSS background-color in <style> — dark background will not render when opened from disk. Use background-color in the <style> tag, not just a Tailwind class.")
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

/**
 * Checks that spec-defined text literals appear verbatim in the rendered HTML.
 * Deterministic string matching — no LLM needed. Catches renderer hallucination where
 * the renderer substitutes its own text ("Your AI health coach") for spec-defined text
 * ("Health360"). Matches patterns like: Heading: "..." / Tagline: "..." / Header: "..."
 */
function validateTextFidelity(html: string, specContent: string): string[] {
  const issues: string[] = []
  // Match labeled text literals: Heading: "...", Tagline: "...", Header: "...", Description: "..."
  const pattern = /(?:Heading|Tagline|Header|Description|placeholder):\s*"([^"]{4,})"/gi
  for (const match of specContent.matchAll(pattern)) {
    const specText = match[1].trim()
    if (!html.includes(specText)) {
      issues.push(`Spec text "${specText}" not found in rendered HTML — renderer substituted different content`)
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

## TEXT FIDELITY — NON-NEGOTIABLE

Use ONLY the exact text content from the spec. Do not paraphrase, improve, or substitute.

- If the spec defines a heading: use that exact string. Spec says \`Heading: "Health360"\` → render "Health360", never "Your AI Health Coach" or any variation.
- If the spec defines chip labels: use those exact labels, in that exact order.
- If the spec defines button text, placeholder text, or descriptions: use those exact strings.
- If a text element has NO value in the spec: leave it absent. Do not invent plausible-sounding copy.
- If the spec says "bottom sheet": the element enters from the bottom with a translate-Y animation. If "centered modal": it is a centered overlay. Respect layout direction exactly as written.

Any text visible in the rendered HTML that does not appear verbatim in the spec is a renderer error.

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

## Mandatory <style> block — ALWAYS add this to <head>, no exceptions

This block is required on every page, even if the spec has no glow effect.

**Why:** Tailwind CDN custom classes (\`bg-primary\`, \`text-fg\`, etc.) require CDN JavaScript to load and process \`window.tailwind\` config before they resolve. When HTML is opened from disk (file://) or as a Slack attachment, the CDN may not load before the browser paints — the page renders white. Explicit CSS in \`<style>\` always works.

**The rule: ALL critical visual properties (background, text color) MUST be set in the \`<style>\` tag. Tailwind classes are an enhancement layer for spacing and interactive states only — never rely on them for the primary background or text color.**

\`\`\`html
<style>
  @keyframes glow-pulse {
    0%, 100% { opacity: <glow-opacity-min from BRAND, default 0.55>; }
    50%       { opacity: <glow-opacity-max from BRAND, default 1.00>; }
  }
  body {
    background-color: <--bg from AUTHORITATIVE BRAND TOKENS>;
    color: <--text from AUTHORITATIVE BRAND TOKENS>;
    margin: 0;
    min-height: 100vh;
    font-family: system-ui, sans-serif;
  }
</style>
\`\`\`

Use the exact hex values from AUTHORITATIVE BRAND TOKENS for \`background-color\` and \`color\`. Do not use Tailwind class names here — write the actual values.

## Glow and gradient effects — use this exact pattern, always

When the spec describes a pulsing glow effect, use this EXACT structure. Do not improvise.

**The \`@keyframes glow-pulse\` is already in the mandatory \`<style>\` block above — do not repeat it.**

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
- **Body background-color and text color MUST be in the \`<style>\` tag** (set above) — not only Tailwind classes. Tailwind-only fails silently on file:// URLs.
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

**Alpine.js data pattern — REQUIRED:**

Declare ALL state and methods in a \`<script>\` block, NOT inline in the x-data attribute string. Then reference the function by name on the root element:

\`\`\`html
<script>
  function appData() {
    return {
      msgs: [],
      draft: '',
      typing: false,
      loggedIn: false,
      authOpen: false,
      authState: 'idle',
      sendMsg(text) {
        if (!text.trim()) return
        this.msgs.push({ role: 'user', text: text.trim() })
        this.draft = ''
        this.typing = true
        setTimeout(() => {
          this.typing = false
          this.msgs.push({ role: 'agent', text: '...' })
          this.$nextTick(() => {
            const t = document.getElementById('thread')
            if (t) t.scrollTop = t.scrollHeight
          })
        }, 900)
      }
    }
  }
</script>
<body x-data="appData()">
\`\`\`

**Never write methods inline in the x-data attribute string.** Alpine magic properties (\`$nextTick\`, \`$el\`, \`$refs\`, \`$dispatch\`) are safe inside \`<script>\` tags and break when written inside HTML attribute values. A broken \`$nextTick\` means auto-scroll never fires and state transitions fail silently.

The \`appData()\` function manages:
- \`msgs\`: array of { role: "user"|"agent", text: string } for live conversation
- \`draft\`: string bound to the prompt input
- \`typing\`: boolean — true during the 900ms agent "thinking" delay
- \`loggedIn\`: boolean — true after successful SSO
- \`authOpen\`: boolean — true when auth sheet overlay is visible
- \`authState\`: "idle" | "loading" | "success" | "error"
- \`inspectorMode\`: string — current inspector state selection (for the inspector panel)

**Preview shell: phone frame + inspector panel**

The preview is NOT a full-width wireframe. Structure:

Left panel — Phone frame (390px wide, 844px tall, border-radius 44px, border: 1px solid rgba(255,255,255,0.12), background: --bg color from BRAND tokens):
- iOS-style status bar at top (time "9:41", signal/wifi/battery SVG icons)
- The app renders inside this frame exactly as it would on device
- The phone frame is the PRIMARY interactive experience — users tap chips, type messages, click through flows directly in the frame

Right panel — Inspector panel (280px wide, darker background than --bg, rounded border):
- Heading row: "Inspector" label
- Grouped buttons for every named screen and state from the spec
- Group "Chat Home": Default, In Conversation, Nudge (logged-out)
- Group "Auth Sheet": Default, Loading, Error, Success
- "Logged In" state as its own entry
- Clicking any button calls \`applyMode(mode)\` which resets the phone frame to that exact state
- Active button is highlighted with an accent border/background
- The inspector is ADDITIVE — it exists to let the designer jump to any edge state without clicking through the flow

Both panels sit horizontally in a centered viewport with a thin top meta bar showing:
feature name · BRAND.md ✓ · N screens · N flows

**Suggestion chips and action pills must always be in a horizontal row** — never stacked vertically. Use \`display: flex; flex-direction: row; flex-wrap: nowrap; overflow-x: auto;\` so they scroll horizontally at narrow viewports instead of stacking.

## Full interactivity — REQUIRED

The preview must be fully interactive. Passive mock-ups are not acceptable. Implement all of the following:

**Prompt bar:**
- Bind the text input to \`draft\` with x-model
- Hitting Enter or clicking Send appends \`{ role: "user", text: draft }\` to \`messages\`, clears \`draft\`, then after a 900ms delay appends a plausible AI reply based on the feature domain
- The input must accept real keyboard input — use \`<input type="text"\` or \`<textarea\`, never a fake div
- Once a message is sent, starter chips disappear and the conversation thread is shown

**Starter chips (if spec describes them):**
- Each chip is a real \`<button>\` that, when clicked, fills the prompt with the chip text and immediately sends it (same as pressing Enter)
- Chips must be in a single horizontal scrollable row — never stacked

**Auth / sign-in flow:**
- "Sign in" button/chip opens the auth sheet overlay directly — no tab switch required
- The auth sheet slides up with a CSS animation
- Clicking a SSO button triggers: \`authState = 'loading'\` (1.2s) → \`authState = 'success'\` (0.8s) → sheet closes, user state becomes logged-in
- Error state: reachable via an "Error" pill, NOT by default behavior
- The overlay can be dismissed by clicking the backdrop

**State transitions:**
- All state changes animate: fade-in for new content, slide-up for sheets, opacity transitions for loading/disabled states
- Logged-out → conversation state happens automatically when the first message is sent
- The in-conversation nudge appears after the first AI reply, with a working "Sign in" link that opens the auth sheet

**Live conversation:**
- The messages array drives a scrollable thread
- New messages animate in with fade-in
- The thread auto-scrolls to the latest message
- Agent "typing" indicator (three pulsing dots) appears during the 900ms delay before the AI reply

## Visual fidelity

This is NOT a wireframe — it should look close to the real product. Apply:
- The exact colors, fonts, and spacing from AUTHORITATIVE BRAND TOKENS and Design Direction sections
- If a Google Font is specified, load it via a <link> tag
- Generous whitespace, careful typography, real-looking content (not Lorem Ipsum — use the feature domain)
- Realistic component states: loading spinners use animated CSS, empty states have an icon and message, error states are visually distinct

## Input fields — always legible

For any text input or textarea:
- Set explicit text color that contrasts with the input background
- On dark backgrounds: text-text-primary or text-white. NEVER leave input color as browser default on a dark-bg page — the default is black, which produces black-on-black text.

## Sheets, modals, and auth flows

If the spec describes an auth sheet, login sheet, or bottom sheet that slides up over a screen:
- It exists as an OVERLAY on the current screen, triggered by user action (clicking Sign in)
- ALSO give it its OWN named tab in the nav for direct inspection (e.g. "Auth Sheet", "Login")
- Render its content fully — SSO buttons, dividers, copy, glow effects — exactly as specified
- Backdrop click dismisses it

Every named screen and state must also be reachable directly from nav tabs and state pills — so the designer can jump to any state without clicking through the flow.

## Empty-state hero — REQUIRED for chat/assistant screens

When the spec describes a chat home screen, the default (empty) state MUST show a centered hero section:
- This hero is a SEPARATE div below the nav bar — it is NOT inside the nav
- The nav bar contains the app name left-aligned (always visible) — the hero heading is CENTERED and only visible when \`msgs.length === 0 && !typing\`
- Hero content: \`<h1>\` with the app name in gradient text matching the spec, centered
- Tagline below the h1, centered, in muted text color
- Glow effect behind the hero (per glow pattern above)
- Starter chips row below the tagline (horizontal, nowrap, scrollable)
- The prompt bar is always pinned at the bottom of the phone frame

When the user sends a message: hide the hero, show the conversation thread.`,
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

  const warnings = [...validateRenderedHtml(html, brandContent), ...validateTextFidelity(html, specContent)]
  return { html, warnings }
}

// Applies targeted updates to an existing HTML preview based on the spec sections that changed.
// Unlike generateDesignPreview (full rewrite from spec), this receives only the changed sections
// as a patch string — the renderer knows exactly what to update and leaves everything else identical.
// Use this after apply_design_spec_patch saves so approved inspector states, animations, and
// brand values are not re-improvised from scratch.
export async function updateDesignPreview(params: {
  existingHtml: string
  specPatch: string      // Only the changed spec sections — not the full spec
  featureName: string
  brandContent?: string
}): Promise<{ html: string; warnings: string[] }> {
  const { existingHtml, specPatch, featureName, brandContent } = params

  const brandBlock = brandContent
    ? `AUTHORITATIVE BRAND TOKENS (from BRAND.md — use these exact values):
${brandContent}

---

`
    : ""

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 32000,
    system: `You are applying targeted updates to an existing HTML design preview.

CRITICAL RULES:
1. You are given ONLY the spec sections that changed. Do not modify HTML for any other section.
2. Do NOT restructure the HTML, change CSS class names, or rename Alpine.js properties.
3. Do NOT add or remove inspector states unless the patch explicitly defines new screens.
4. Do NOT change animation keyframe names, timing values, or color values unless the patch specifies new values.
5. Output ONLY the complete updated HTML — no explanation, no markdown fences.
6. TEXT FIDELITY: Use ONLY the exact text from the patch. Do not paraphrase or substitute. If the patch defines Heading "X", render "X" not any variation. If layout direction changes (e.g. "bottom sheet"), apply it exactly.

The output must be a complete valid HTML file starting with <!DOCTYPE html>.`,
    messages: [
      {
        role: "user",
        content: `${brandBlock}Feature: ${featureName}

EXISTING HTML (preserve everything not covered by the patch below):
${existingHtml}

SPEC PATCH — only these sections changed (update ONLY the HTML elements for these sections, leave everything else identical):
${specPatch}

Apply the patch to the HTML. Return the complete HTML file.`,
      },
    ],
  })

  const text = response.content[0].type === "text" ? response.content[0].text.trim() : ""
  const html = text
    .replace(/^```html\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim()

  if (!html.includes("</html>")) {
    throw new Error("HTML preview was truncated before </html>")
  }

  const warnings = [...validateRenderedHtml(html, brandContent), ...validateTextFidelity(html, specPatch)]
  return { html, warnings }
}
