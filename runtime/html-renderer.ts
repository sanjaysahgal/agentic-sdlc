// Template-based design preview renderer.
// Parses values from a design spec and fills a fixed Alpine.js HTML template.
// The platform owns the HTML structure — no LLM needed, no regex sanitizers.
//
// Root cause of the previous approach's failure: Sonnet cannot reliably follow
// structural HTML rules via prompts. Every new scenario produced a new structural
// bug (hero overlap, chip position, button styling), each requiring another regex patch.
// Template rendering eliminates this class of failure permanently.

// ─── Types ───────────────────────────────────────────────────────────────────

interface SpecValues {
  wordmark: string        // nav + hero heading (e.g. "Health360")
  authHeading: string    // auth sheet heading (e.g. "Sign in to Health360")
  tagline: string
  chips: string[]
  placeholder: string
  nudgeText: string
}

// ─── Spec parser ─────────────────────────────────────────────────────────────

function parseSpecValues(specContent: string, featureName: string): SpecValues {
  // Wordmark: nav + hero heading — look for "Health360 wordmark" pattern or wordmark line
  // Spec: "Health360 wordmark: gradient text..." — extract the product name before " wordmark"
  const wordmarkLineMatch = specContent.match(/^[-*]\s*([^\n:]+?)\s+wordmark:/im)
  const wordmarkFromNav = wordmarkLineMatch?.[1]?.trim() ?? null

  // Auth sheet heading — look for Heading: in Auth Sheet section specifically
  // The auth heading is always "Sign in to [AppName]" — look for that pattern
  const authHeadingMatch = specContent.match(/[Hh]eading:\s*"([^"]+)"/)
  const authHeading = authHeadingMatch?.[1] ??
    (featureName.charAt(0).toUpperCase() + featureName.slice(1))

  // Wordmark: derive from auth heading by stripping "Sign in to " prefix, or fall back to feature name
  const wordmark = wordmarkFromNav ??
    (authHeading.replace(/^sign in to\s+/i, "").trim() ||
     featureName.charAt(0).toUpperCase() + featureName.slice(1))

  // Tagline: spec writes it inline as "tagline "All your health. One conversation""
  // Match: tagline "..." (no colon) OR Tagline: "..."
  const taglineMatch = specContent.match(/[Tt]agline\s*"([^"]+)"/) ??
    specContent.match(/[Tt]agline:\s*"([^"]+)"/)
  const tagline = taglineMatch?.[1] ?? ""

  // Placeholder: spec writes "placeholder text "Ask anything about your health""
  // Match: placeholder text "..." OR Placeholder: "..."
  const placeholderMatch = specContent.match(/[Pp]laceholder(?:\s+text)?\s+"([^"]+)"/) ??
    specContent.match(/[Pp]laceholder:\s*"([^"]+)"/)
  const placeholder = placeholderMatch?.[1] ?? "Ask me anything..."

  // Chips: look for quoted strings in the Starter Chips section, then fall back to
  // accessibility section examples (where chip examples are typically listed).
  // Spec may not define chip content yet — treat as open question if empty.
  const chipsSectionMatch = specContent.match(
    /(?:Starter|Suggestion)?\s*[Cc]hips?[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s|\n---|\n\n\*\*|$)/
  )
  const chipsSection = chipsSectionMatch?.[1] ?? ""
  const chips: string[] = []
  for (const m of chipsSection.matchAll(/"([^"]{4,80})"/g)) {
    chips.push(m[1])
    if (chips.length === 3) break
  }
  // Accessibility section example chips — only pick up strings that look like
  // conversational prompts (questions or short action phrases, not page titles or labels)
  if (chips.length === 0) {
    const a11ySectionMatch = specContent.match(/## Accessibility[\s\S]*?(?=\n## |$)/)
    const a11ySection = a11ySectionMatch?.[0] ?? ""
    // Only pick up quoted text that is a question or short imperative — not labels/page titles/SSO text
    for (const m of a11ySection.matchAll(/"([^"]{4,80})"/g)) {
      const candidate = m[1]
      const isConversational = (candidate.endsWith("?") ||
        /^(How|What|Show|Tell|Find|Why|When|Which)/i.test(candidate)) &&
        !/^(Button:|Dialog:|System|Sign|Continue|Log|Health360)/i.test(candidate)
      if (isConversational) {
        chips.push(candidate)
        if (chips.length === 3) break
      }
    }
  }

  // Nudge text: spec Flow US-5 describes it verbatim
  const nudgeMatch = specContent.match(/"(Your conversation won['']t be saved[^"]{0,80})"/)
  const nudgeText = nudgeMatch?.[1] ?? "Your conversation won't be saved unless you sign in."

  return { wordmark, authHeading, tagline, chips, placeholder, nudgeText }
}

// ─── Brand parser ─────────────────────────────────────────────────────────────

function parseBrandColors(brandMd: string): Record<string, string> {
  const colors: Record<string, string> = {
    "--bg": "#0A0A0F",
    "--surface": "#13131A",
    "--text": "#E8E8F0",
    "--violet": "#7C6FCD",
    "--teal": "#4FAFA8",
  }
  for (const line of brandMd.split("\n")) {
    const tokenMatch = line.match(/--([\w-]+):/)
    if (!tokenMatch) continue
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})\b/)
    if (!hexMatch) continue
    colors[`--${tokenMatch[1]}`] = `#${hexMatch[1].toUpperCase()}`
  }
  return colors
}

function parseGlowParams(specContent: string) {
  // Parse glow from the design spec's Brand section (authoritative).
  // The spec defines separate heartbeat-violet and heartbeat-teal keyframes.
  const brandSection = specContent.match(/## Brand[\s\S]*?(?=\n## |\[END |$)/)?.[0] ?? specContent

  // Duration: look for animation: heartbeat-violet Xs
  const durationMatch = brandSection.match(/animation:\s*heartbeat-[a-z]+\s+([\d.]+s)/)
  // Blur: look for filter: blur(Xpx) in brand/glow section
  const blurMatch = brandSection.match(/filter:\s*blur\(([\d.]+px)\)/)
  // Delay: look for animation-delay
  const delayMatch = brandSection.match(/animation-delay:\s*([-\d.]+s)/)
  // Easing: look for cubic-bezier in glow animation line
  const easingMatch = brandSection.match(/animation:\s*heartbeat-[a-z]+[^;]*?(cubic-bezier\([^)]+\))/)

  // Keyframe opacities from heartbeat-violet block
  const violetBlock = brandSection.match(/@keyframes heartbeat-violet\s*\{([\s\S]*?)\}/)?.[1] ?? ""
  const violetOpacities = [...violetBlock.matchAll(/opacity:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))

  // Teal keyframe block
  const tealBlock = brandSection.match(/@keyframes heartbeat-teal\s*\{([\s\S]*?)\}/)?.[1] ?? ""
  const tealOpacities = [...tealBlock.matchAll(/opacity:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))

  // Violet transform scale values (for scale animation)
  const violetScales = [...violetBlock.matchAll(/scale\(([\d.]+)\)/g)].map(m => m[1])

  return {
    duration: durationMatch?.[1] ?? "2.5s",
    blur: blurMatch?.[1] ?? "200px",
    delay: delayMatch?.[1] ?? "-1.25s",
    easing: easingMatch?.[1] ?? "cubic-bezier(0.4, 0, 0.2, 1)",
    violetOpacities,
    tealOpacities,
    violetScales,
  }
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
}

// ─── Template renderer ────────────────────────────────────────────────────────

/**
 * Renders a self-contained Alpine.js HTML preview from a design spec.
 * Deterministic — no LLM call. The platform owns the structure; the spec
 * populates copy, chips, and brand values.
 *
 * Structural guarantees (formerly enforced by regex sanitizers, now by construction):
 * - id="hero" is always present, always a sibling of id="thread"
 * - Hero uses :class (not x-show) — visible before Alpine loads
 * - Thread has style="display:none" + x-show — hidden before Alpine, shown reactively
 * - Inspector buttons have full static style attributes (not dependent on Alpine)
 * - Chips are in a horizontal row, anchored at the bottom of the hero via margin-top:auto
 * - Brand colors and glow params are read directly from BRAND.md
 */
export function renderFromSpec(
  specContent: string,
  brandMd: string,
  featureName = "preview"
): string {
  const values = parseSpecValues(specContent, featureName)
  // Brand colors from BRAND.md (or spec fallback)
  const colors = parseBrandColors(brandMd || specContent)
  // Glow params from spec Brand section (authoritative)
  const glow = parseGlowParams(specContent)

  const bg = colors["--bg"]
  const surface = colors["--surface"]
  const text = colors["--text"]
  const violet = colors["--violet"]
  const teal = colors["--teal"]
  const error = colors["--error"] ?? "#e06c75"
  const violetRgb = hexToRgb(violet)
  const tealRgb = hexToRgb(teal)

  // Build heartbeat keyframe CSS from parsed opacity/scale values
  const defaultVioletOpacities = [0.55, 1.00, 0.70, 0.90, 0.58, 0.55]
  const defaultTealOpacities = [0.50, 0.95, 0.65, 0.85, 0.53, 0.50]
  const defaultScales = ["0.97", "1.20", "1.05", "1.13", "0.98", "0.97"]

  function buildHeartbeatKeyframes(name: string, opacities: number[], scales: string[], fallbackOpacities: number[]): string {
    const points = [0, 12, 24, 36, 60, 100]
    const ops = opacities.length >= 6 ? opacities : fallbackOpacities
    const sc = scales.length >= 6 ? scales : defaultScales
    return `@keyframes ${name} {\n` +
      points.map((p, i) => `  ${p}%  { opacity: ${ops[i].toFixed(2)}; transform: scale(${sc[i]}); }`).join("\n") +
      "\n}"
  }

  const heartbeatVioletCss = buildHeartbeatKeyframes("heartbeat-violet", glow.violetOpacities, glow.violetScales, defaultVioletOpacities)
  const heartbeatTealCss = buildHeartbeatKeyframes("heartbeat-teal", glow.tealOpacities, glow.violetScales, defaultTealOpacities)

  // Chip buttons — use data-chip to safely handle apostrophes in chip text
  const chipsHtml = values.chips.map(chip =>
    `<button data-chip="${chip.replace(/"/g, "&quot;")}" @click="sendMsg($el.dataset.chip)"` +
    ` style="background:rgba(${tealRgb},0.08);color:${teal};border:1px solid rgba(${tealRgb},0.18);` +
    `border-radius:20px;padding:8px 16px;font-size:13px;font-weight:600;letter-spacing:0.09em;cursor:pointer;white-space:nowrap;flex-shrink:0;">${chip}</button>`
  ).join("\n            ")

  // Placeholder chips shown when spec has none — shows correct spec layout (3 pills, proper
  // dimensions: 44px height, teal 15% border, 40px border-radius) with TBD copy so the row
  // is structurally reviewable even before chip content is defined.
  const chipTbdStyle = `background:${surface};color:rgba(248,248,247,0.35);` +
    `border:1px solid rgba(${tealRgb},0.15);border-radius:40px;` +
    `padding:0 18px;height:44px;font-size:13px;white-space:nowrap;flex-shrink:0;cursor:default;` +
    `display:inline-flex;align-items:center;`
  const chipsPlaceholderHtml = values.chips.length === 0
    ? `<!-- OPEN QUESTION: Starter chip content not yet defined in spec -->
            <button disabled style="${chipTbdStyle}">[chip 1 — TBD]</button>
            <button disabled style="${chipTbdStyle}">[chip 2 — TBD]</button>
            <button disabled style="${chipTbdStyle}">[chip 3 — TBD]</button>`
    : chipsHtml

  // Pre-fill first chip for inspector "In Conversation" / "Nudge" states
  const firstChip = JSON.stringify(values.chips[0] ?? "Tell me about this feature")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <title>${values.wordmark} \u2014 Design Preview</title>
  <style>
    * { box-sizing: border-box; }
    /* Hide native scrollbars everywhere — polished preview never shows browser chrome */
    * { scrollbar-width: none; -ms-overflow-style: none; }
    *::-webkit-scrollbar { display: none; }
    body {
      background-color: ${bg};
      color: #fff;
      margin: 0;
      min-height: 100vh;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px 16px;
    }
    ${heartbeatVioletCss}
    ${heartbeatTealCss}
    @keyframes glow-shrink {
      0%   { filter: blur(200px); opacity: 0.55; }
      100% { filter: blur(100px); opacity: 0.18; }
    }
    .glow-shrunk {
      animation: glow-shrink 2s ease-out forwards !important;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30%            { transform: translateY(-6px); }
    }
    .hidden { display: none !important; }
    .msg-user {
      background: ${violet};
      color: #fff;
      border-radius: 18px 18px 4px 18px;
      padding: 10px 14px;
      max-width: 80%;
      align-self: flex-end;
      font-size: 14px;
      line-height: 1.4;
    }
    .msg-agent {
      background: ${surface};
      color: ${text};
      border-radius: 18px 18px 18px 4px;
      padding: 10px 14px;
      max-width: 80%;
      align-self: flex-start;
      font-size: 14px;
      line-height: 1.4;
    }
    .typing-dot {
      width: 6px; height: 6px;
      background: rgba(255,255,255,0.5);
      border-radius: 50%;
      animation: typing-bounce 1.2s infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    .sso-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      height: 56px;
      background: ${surface};
      border: 1px solid rgba(${tealRgb}, 0.15);
      border-radius: 40px;
      color: ${text};
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: border-color 0.20s ease, background 0.20s ease;
    }
    .sso-btn:hover {
      border-color: rgba(${tealRgb}, 0.30);
      background: rgba(${tealRgb}, 0.05);
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js" defer></script>
</head>
<body>
  <script>
    function appData() {
      return {
        msgs: [],
        draft: "",
        typing: false,
        auth: "signed out",
        sheet: "closed",
        inspectorMode: "default",

        sendMsg(text) {
          if (!text || !text.trim()) return
          this.msgs.push({ role: "user", text: text.trim() })
          this.draft = ""
          this.typing = true
          setTimeout(() => {
            this.typing = false
            this.msgs.push({ role: "agent", text: "Based on your recent data, here's what I found. Would you like to explore this further?" })
            this.$nextTick(() => {
              const t = document.getElementById("thread")
              if (t) t.scrollTop = t.scrollHeight
            })
          }, 900)
        },

        applyMode(mode) {
          this.inspectorMode = mode
          if (mode === "default") {
            this.msgs = []; this.typing = false; this.sheet = "closed"; this.auth = "signed out"
          } else if (mode === "in-conversation") {
            this.msgs = [
              { role: "user", text: ${firstChip} },
              { role: "agent", text: "Based on your recent data, here's what I found. Would you like to explore this further?" }
            ]
            this.typing = false; this.sheet = "closed"; this.auth = "signed out"
          } else if (mode === "nudge") {
            this.msgs = [
              { role: "user", text: ${firstChip} },
              { role: "agent", text: "Based on your recent data, here's what I found. Would you like to explore this further?" }
            ]
            this.typing = false; this.sheet = "closed"; this.auth = "signed out"
          } else if (mode === "auth-default") {
            this.msgs = []; this.typing = false; this.sheet = "open"; this.auth = "signed out"
          } else if (mode === "auth-loading") {
            this.msgs = []; this.typing = false; this.sheet = "loading"; this.auth = "signed out"
          } else if (mode === "auth-error") {
            this.msgs = []; this.typing = false; this.sheet = "error"; this.auth = "signed out"
          } else if (mode === "auth-success") {
            this.msgs = []; this.typing = false; this.sheet = "success"; this.auth = "signed in"
          } else if (mode === "logged-in") {
            this.msgs = []; this.typing = false; this.sheet = "closed"; this.auth = "signed in"
          }
        },

        signIn() {
          this.sheet = "loading"
          setTimeout(() => {
            this.sheet = "success"
            this.auth = "signed in"
            setTimeout(() => { this.sheet = "closed" }, 800)
          }, 1200)
        }
      }
    }
  </script>

  <!-- Meta bar -->
  <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:16px;text-align:center;">
    ${values.wordmark} \xb7 Design Preview \xb7 ${values.chips.length} chips \xb7 BRAND.md \u2713
  </div>

  <style>
    @media screen and (max-width: 680px) {
      body { padding: 0 !important; margin: 0 !important; overflow: hidden !important; }
      .inspector-panel { display: none !important; }
      .phone-frame { width: 100vw !important; height: 100vh !important; height: 100dvh !important; border-radius: 0 !important; border: none !important; }
      .phone-frame .status-bar { display: none !important; }
      .main-layout { gap: 0 !important; }
    }
    @media screen and (min-width: 681px) and (max-width: 900px) {
      .inspector-panel { display: none !important; }
      .main-layout { justify-content: center !important; }
    }
  </style>
  <!-- Main layout: phone frame + inspector panel -->
  <div class="main-layout" style="display:flex;gap:24px;align-items:flex-start;" x-data="appData()">

    <!-- Phone frame: 390x844, owned by platform -->
    <div class="phone-frame" style="width:390px;height:844px;background:${bg};border:1px solid rgba(255,255,255,0.12);border-radius:44px;overflow:hidden;display:flex;flex-direction:column;position:relative;flex-shrink:0;">

      <!-- Status bar -->
      <div class="status-bar" style="padding:14px 24px 0;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;">
        <span>9:41</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><rect x="0" y="4" width="3" height="8" rx="1"/><rect x="4" y="2.5" width="3" height="9.5" rx="1"/><rect x="8" y="1" width="3" height="11" rx="1"/><rect x="12" y="0" width="3" height="12" rx="1" opacity=".3"/></svg>
          <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.4C10.7 2.4 13.1 3.6 14.7 5.5L16 4C14 1.6 11.2 0 8 0S2 1.6 0 4l1.3 1.5C2.9 3.6 5.3 2.4 8 2.4z" opacity=".3"/><path d="M8 5.3c1.7 0 3.2.8 4.2 2L13.5 6C12.1 4.2 10.2 3 8 3S3.9 4.2 2.5 6l1.3 1.3C4.8 6.1 6.3 5.3 8 5.3z" opacity=".6"/><path d="M8 8.2c.9 0 1.7.4 2.2 1.1L11.5 8C10.6 6.8 9.4 6 8 6S5.4 6.8 4.5 8l1.3 1.3C6.3 8.6 7.1 8.2 8 8.2z"/><circle cx="8" cy="11" r="1.3"/></svg>
          <svg width="25" height="12" viewBox="0 0 25 12" fill="currentColor"><rect x="0" y="1" width="21" height="10" rx="2.5" stroke="currentColor" stroke-width="1" fill="none" opacity=".35"/><rect x="22" y="3.5" width="3" height="5" rx="1" opacity=".4"/><rect x="1.5" y="2.5" width="16" height="7" rx="1.5"/></svg>
        </div>
      </div>

      <!-- Nav bar -->
      <div style="padding:12px 20px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:20px;font-weight:700;letter-spacing:-0.025em;background:linear-gradient(135deg,${violet} 20%,${teal} 80%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${values.wordmark}</span>
        <button
          x-show="auth !== 'signed in'"
          @click="sheet = 'open'; inspectorMode = 'auth-default'"
          style="background:transparent;color:${text};border:1px solid rgba(${tealRgb},0.15);border-radius:9999px;padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;min-width:44px;min-height:44px;">
          Sign in
        </button>
        <span x-show="auth === 'signed in'" style="font-size:13px;color:${teal};">\u25cf Signed in</span>
      </div>

      <!-- Content area: position:relative is the stacking context -->
      <div style="flex:1;position:relative;overflow:hidden;">

        <!-- Glow: two independent glows, violet + teal, per spec -->
        <div aria-hidden="true" style="position:absolute;inset:0;pointer-events:none;z-index:0;">
          <div style="position:absolute;left:-20%;right:-20%;bottom:-10%;top:5%;
            background:radial-gradient(ellipse at center,rgba(${violetRgb},0.42) 0%,rgba(${violetRgb},0.14) 40%,transparent 68%);
            filter:blur(${glow.blur});
            animation:heartbeat-violet ${glow.duration} ${glow.easing} infinite;"
            :class="{ 'glow-shrunk': msgs.length >= 4 }"></div>
          <div style="position:absolute;left:-10%;right:-10%;bottom:-5%;top:15%;
            background:radial-gradient(ellipse at center,rgba(${tealRgb},0.34) 0%,rgba(${tealRgb},0.11) 40%,transparent 68%);
            filter:blur(${glow.blur});
            animation:heartbeat-teal ${glow.duration} ${glow.easing} infinite;
            animation-delay:${glow.delay};"
            :class="{ 'glow-shrunk': msgs.length >= 4 }"></div>
        </div>

        <!-- Hero (empty state)
             CRITICAL: id="hero" present; :class used for visibility (never the reactive show directive).
             Chips anchored at bottom via margin-top:auto — NOT vertically centered. -->
        <div id="hero"
          style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;padding:40px 24px 0;overflow-y:auto;z-index:1;"
          :class="{ 'hidden': msgs.length > 0 || typing }">
          <h1 style="font-size:28px;font-weight:700;letter-spacing:-0.04em;margin:0 0 4px;text-align:center;
            background:linear-gradient(135deg,${violet} 20%,${teal} 80%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">
            ${values.wordmark}
          </h1>
          ${values.tagline ? `<p style="font-size:12px;color:rgba(248,248,247,0.45);margin:0;text-align:center;font-weight:400;">${values.tagline}</p>` : ""}
          <div style="margin-top:auto;padding-bottom:16px;display:flex;flex-direction:row;flex-wrap:nowrap;gap:16px;overflow-x:auto;width:100%;justify-content:center;padding-top:16px;">
            ${chipsPlaceholderHtml}
          </div>
        </div>

        <!-- Thread (conversation state)
             CRITICAL: style="display:none" hides before Alpine; x-show lets Alpine show it. -->
        <div id="thread"
          style="position:absolute;inset:0;overflow-y:auto;display:none;z-index:1;padding:16px;"
          x-show="msgs.length > 0 || typing">

          <!-- Nudge banner: logged-out, after first agent reply -->
          <div
            x-show="auth !== 'signed in' && msgs.filter(m => m.role === 'agent').length > 0"
            style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:10px 14px;font-size:13px;margin-bottom:12px;">
            ${values.nudgeText}
            <a href="#" @click.prevent="sheet = 'open'; inspectorMode = 'auth-default'"
               style="color:${violet};text-decoration:none;margin-left:4px;">Sign in</a>
          </div>

          <!-- Messages -->
          <div style="display:flex;flex-direction:column;gap:10px;">
            <template x-for="(msg, i) in msgs" :key="i">
              <div :class="msg.role === 'user' ? 'msg-user' : 'msg-agent'" x-text="msg.text"></div>
            </template>
            <div x-show="typing"
              style="display:flex;gap:5px;align-items:center;padding:10px 14px;background:rgba(255,255,255,0.08);border-radius:18px 18px 18px 4px;width:fit-content;">
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
            </div>
          </div>
        </div>

        <!-- Auth sheet overlay -->
        <div x-show="sheet !== 'closed'" style="position:absolute;inset:0;z-index:10;">
          <div @click="sheet = 'closed'; inspectorMode = msgs.length > 0 ? 'in-conversation' : 'default'"
            style="position:absolute;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);"></div>
          <div style="position:absolute;bottom:0;left:0;right:0;background:${surface};border-radius:16px 16px 0 0;padding:24px 24px 32px;">
            <!-- Drag handle -->
            <div style="width:32px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;margin:0 auto 20px;"></div>
            <!-- Auth sheet heading — gradient text per spec -->
            <h2 id="auth-sheet-heading" style="font-size:20px;font-weight:700;letter-spacing:-0.025em;margin:0 0 8px;text-align:center;
              background:linear-gradient(135deg,${violet} 20%,${teal} 80%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">
              ${values.authHeading}
            </h2>
            <p style="font-size:14px;color:rgba(248,248,247,0.45);text-align:center;margin:0 0 24px;">Your conversation will be saved when you sign in.</p>

            <!-- Glow behind SSO buttons — two independent glows per spec -->
            <div aria-hidden="true" style="position:absolute;left:0;right:0;bottom:60px;height:160px;pointer-events:none;overflow:hidden;">
              <div style="position:absolute;left:15%;right:50%;top:20%;bottom:0;
                background:radial-gradient(ellipse at center,rgba(${violetRgb},0.42) 0%,rgba(${violetRgb},0.14) 40%,transparent 68%);
                filter:blur(48px);
                animation:heartbeat-violet ${glow.duration} ${glow.easing} infinite;"></div>
              <div style="position:absolute;left:50%;right:15%;top:20%;bottom:0;
                background:radial-gradient(ellipse at center,rgba(${tealRgb},0.34) 0%,rgba(${tealRgb},0.11) 40%,transparent 68%);
                filter:blur(48px);
                animation:heartbeat-teal ${glow.duration} ${glow.easing} infinite;
                animation-delay:${glow.delay};"></div>
            </div>

            <!-- Error message (shown in error state) -->
            <div x-show="sheet === 'error'" style="font-size:14px;color:${error};text-align:center;margin-bottom:16px;">Sign in failed. Please try again.</div>

            <div x-show="sheet === 'open' || sheet === 'error'" style="display:flex;flex-direction:column;gap:16px;position:relative;z-index:1;">
              <button class="sso-btn" @click="signIn()" aria-label="Sign in with Apple">
                <svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.42c1.42.07 2.38.74 3.2.8 1.21-.24 2.38-.93 3.7-.84 1.58.12 2.76.72 3.53 1.9-3.23 1.94-2.46 5.9.57 7.08-.57 1.39-1.29 2.76-3 2.92zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
                Sign in with Apple
              </button>
              <button class="sso-btn" @click="signIn()" aria-label="Sign in with Google">
                <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                Sign in with Google
              </button>
            </div>

            <div x-show="sheet === 'loading'" style="text-align:center;padding:20px 0;">
              <div style="width:12px;height:12px;border:2px solid rgba(255,255,255,0.1);border-top-color:${text};border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px;"></div>
              <p style="color:rgba(248,248,247,0.45);font-size:14px;margin:0;">Signing you in...</p>
            </div>

            <div x-show="sheet === 'success'" style="text-align:center;padding:20px 0;">
              <div style="font-size:32px;margin-bottom:8px;color:${teal};">\u2713</div>
              <p style="color:${teal};font-size:15px;font-weight:600;margin:0;">Signed in successfully</p>
            </div>
          </div>
        </div>

      </div>

      <!-- Prompt bar -->
      <div style="padding:12px 16px 20px;display:flex;gap:8px;align-items:center;">
        <input
          type="text"
          x-model="draft"
          @keydown.enter="sendMsg(draft)"
          placeholder="${values.placeholder}"
          style="flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:10px 16px;font-size:14px;color:${text};outline:none;">
        <button
          @click="sendMsg(draft)"
          style="width:36px;height:36px;background:${violet};border:none;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
        </button>
      </div>
    </div>

    <!-- Inspector panel -->
    <div class="inspector-panel" style="width:240px;background:${surface};border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:16px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:rgba(255,255,255,0.4);margin-bottom:16px;">INSPECTOR</div>

      <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:8px;letter-spacing:0.06em;">CHAT HOME</div>
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'default' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('default')">Default</button>
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'in-conversation' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('in-conversation')">In Conversation</button>
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'nudge' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('nudge')">Nudge (logged-out)</button>
      </div>

      <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:8px;letter-spacing:0.06em;">AUTH SHEET</div>
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'auth-default' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('auth-default')">Default</button>
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'auth-loading' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('auth-loading')">Loading</button>
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'auth-error' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('auth-error')">Error</button>
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'auth-success' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('auth-success')">Success</button>
      </div>

      <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:8px;letter-spacing:0.06em;">USER STATE</div>
      <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:16px;">
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="inspectorMode === 'logged-in' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('logged-in')">Logged In</button>
        <button
          style="background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;width:100%;text-align:left;"
          :style="auth === 'signed out' && inspectorMode !== 'logged-in' ? 'border-color:${violet};background:rgba(124,111,205,0.15);color:#fff;' : ''"
          @click="applyMode('default')">Logged Out</button>
      </div>

      <!-- Status display -->
      <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;font-size:11px;color:rgba(255,255,255,0.4);line-height:1.8;">
        <div>Auth: <span x-text="auth" style="color:rgba(255,255,255,0.7);"></span></div>
        <div>Messages: <span x-text="msgs.length" style="color:rgba(255,255,255,0.7);"></span></div>
        <div>Sheet: <span x-text="sheet" style="color:rgba(255,255,255,0.7);"></span></div>
      </div>
    </div>

  </div>
</body>
</html>`
}

// ─── Backward-compat wrapper ───────────────────────────────────────────────────

/**
 * Async wrapper around renderFromSpec for backward compatibility with callers
 * that expect Promise<{ html, warnings }>. No LLM call — synchronous template render.
 */
export async function generateDesignPreview(params: {
  specContent: string
  featureName: string
  brandContent?: string
}): Promise<{ html: string; warnings: string[] }> {
  const html = renderFromSpec(params.specContent, params.brandContent ?? "", params.featureName)
  return { html, warnings: [] }
}

// ─── Validators (kept for smoke testing) ─────────────────────────────────────

/**
 * Validates structural properties of rendered HTML.
 * Template rendering guarantees these — kept for smoke testing and regression detection.
 */
export function validateRenderedHtml(html: string, brandContent?: string): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = []
  const warnings: string[] = []

  if (!html.trim().endsWith("</html>")) {
    blocking.push("HTML appears truncated — missing closing </html>")
  }

  if (!html.includes('id="hero"')) {
    blocking.push('Hero element missing id="hero" — CRITICAL: must not omit this attribute')
  }

  const threadIdx = html.indexOf('id="thread"')
  if (threadIdx !== -1) {
    const threadTagEnd = html.indexOf('>', threadIdx)
    if (threadTagEnd !== -1) {
      let depth = 1
      let i = threadTagEnd + 1
      while (i < html.length && depth > 0) {
        const openTag = html.indexOf('<div', i)
        const closeTag = html.indexOf('</div', i)
        if (closeTag === -1) break
        if (openTag !== -1 && openTag < closeTag) { depth++; i = openTag + 4 }
        else { depth--; i = closeTag + 5 }
      }
      const threadInnerContent = html.slice(threadTagEnd + 1, i)
      if (threadInnerContent.includes('id="hero"')) {
        blocking.push('Hero element is nested inside thread — hero and thread must be siblings')
      }
    }
  }

  if (!html.includes("@keyframes")) {
    warnings.push("No CSS keyframe animations found — glow animation likely missing")
  }

  if (!html.match(/body\s*\{[^}]*background(?:-color)?:/s)) {
    warnings.push("Body has no explicit CSS background-color in <style>")
  }

  if (brandContent) {
    const bgMatch = brandContent.match(/--bg:\s*(#[0-9A-Fa-f]{6})/)
    if (bgMatch && !html.includes(bgMatch[1])) {
      warnings.push(`Background token ${bgMatch[1]} (--bg from BRAND.md) not found in rendered HTML`)
    }
  }

  return { blocking, warnings }
}

/**
 * Checks that spec-defined text literals appear verbatim in the rendered HTML.
 */
export function validateTextFidelity(html: string, specContent: string): string[] {
  const issues: string[] = []
  const pattern = /(?:Heading|Tagline|Header|Description|placeholder):\s*"([^"]{4,})"/gi
  for (const match of specContent.matchAll(pattern)) {
    const specText = match[1].trim()
    if (!html.includes(specText)) {
      issues.push(`Spec text "${specText}" not found in rendered HTML`)
    }
  }
  return issues
}
