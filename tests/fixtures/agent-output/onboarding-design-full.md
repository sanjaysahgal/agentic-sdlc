# Onboarding — Design Spec

## Figma
TBD

## Design Direction

**Dark mode primary — Archon Labs aesthetic (getarchon.dev).** Visual language: minimal, high negative space. The interface recedes; the conversation leads. Chrome is nearly invisible until needed.

**Archon Labs Visual Language:**
- Dark navy/charcoal background (#0A0A0F) with off-white text (#F8F8F7) — high contrast, clean
- Accent colors (violet #7C6FCD, teal #4FAFA8) used intentionally on interactive elements, labels, and highlights — never decorative
- Gradient text (135° violet → teal) on primary headings and UI chrome only — hand-authored UI elements like wordmark, prompt placeholder, CTA labels, section headers — never in conversational messages or AI responses
- Typography hierarchy: system-ui, weights 400/500/600, no custom fonts
- Signature treatment: dual independent pulsing glow effect. Violet and teal glows pulse independently (10–15% opacity cycle, 2.5s duration, ease-in-out cubic-bezier(0.4, 0, 0.2, 1), offset -1.25s on teal). Glow shrinks and fades as conversation fills viewport: blur radius 200px → 100px, opacity 10–15% → 4–6% over ~4 messages. Minimum state: 4–6% opacity, ~100px blur radius — still present, nearly imperceptible. Each glow instance is independent; if home and Auth Sheet glows are visible simultaneously, they do not synchronize to each other.
- Minimal chrome — buttons, cards, and surfaces are understated until interaction
- Extreme negative space — 60–70% empty on hero screens, 30–40% empty within containers

**Color Application Rules:**
- Primary text (#F8F8F7): body copy, conversation content, labels
- Muted text (rgba(248, 248, 247, 0.45)): secondary labels, timestamps, disabled states
- Subtle text (rgba(248, 248, 247, 0.18)): placeholders, tertiary information
- Accent (violet #7C6FCD): focus states, active tabs, primary CTAs, badges
- Accent (teal #4FAFA8): secondary CTAs, hover states, accent badges
- Gradient (violet → teal): primary headings, wordmark, prompt placeholder, UI chrome only — never in conversational content
- Border (rgba(255, 255, 255, 0.07)): dividers, card edges, subtle elevation

**Interactive Element Styling:**
- Rounded pill containers: 40–48px border-radius, 1px teal borders at 15% opacity (#4FAFA8)
- Glow effect: faint radial gradient halo positioned behind rounded pills and interactive elements, conveying ambient warmth without distraction
- Glow opacity cycle: 10–15%, shrinking to 4–6% minimum as conversation fills viewport
- Glow animation: 2.5s pulse cycle, cubic-bezier(0.4, 0, 0.2, 1) easing. Violet and teal pulsing independently, offset -1.25s on teal. Each instance independent — no cross-instance synchronization.
- Starter chips fade choreography: 150ms parallel fade-out on first AI message, ease-out easing

## Brand

**Glow (Signature Effect)**

Two independent radial glows — violet and teal — rendered separately and animated asynchronously.

**Violet glow:**
```css
background: radial-gradient(ellipse at center, rgba(124, 111, 205, 0.15) 0%, rgba(124, 111, 205, 0.05) 50%, transparent 100%);
filter: blur(200px);

@keyframes heartbeat-violet {
  0%   { opacity: 0.10; transform: scale(0.97); }
  12%  { opacity: 0.15; transform: scale(1.20); }
  36%  { opacity: 0.13; transform: scale(1.13); }
  60%  { opacity: 0.10; transform: scale(0.98); }
  100% { opacity: 0.10; transform: scale(0.97); }
}
animation: heartbeat-violet 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
```

**Teal glow:**
```css
background: radial-gradient(ellipse at center, rgba(79, 175, 168, 0.12) 0%, rgba(79, 175, 168, 0.04) 50%, transparent 100%);
filter: blur(200px);

@keyframes heartbeat-teal {
  0%   { opacity: 0.10; transform: scale(0.97); }
  12%  { opacity: 0.15; transform: scale(1.20); }
  36%  { opacity: 0.13; transform: scale(1.13); }
  60%  { opacity: 0.10; transform: scale(0.98); }
  100% { opacity: 0.10; transform: scale(0.97); }
}
animation: heartbeat-teal 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
animation-delay: -1.25s;   /* offset so violet and teal pulse out of sync */
```

**Shrinking & Fading Behavior (as conversation fills viewport):**

Triggered approximately after 4 messages or 60% of viewport height occupied by conversation. Glow transitions over ~500ms ease-in-out:
- Blur radius: 200px → 100px
- Opacity cycle: 10–15% → 4–6%
- Minimum state maintained for remainder of session: 4–6% opacity, ~100px blur radius — still present, nearly imperceptible

```css
@keyframes glow-shrink {
  0% {
    filter: blur(200px);
    opacity: 0.10; /* mid-cycle */
  }
  100% {
    filter: blur(100px);
    opacity: 0.04; /* mid-cycle of minimum state */
  }
}

/* Applied to glow containers when conversation active state triggers */
animation: glow-shrink 500ms ease-in-out forwards;
```

**Usage rules:**
- Applied in exactly two places: (1) chat home background behind prompt bar, (2) Auth Sheet behind SSO buttons
- Positioned as a faint radial halo behind rounded pill containers and interactive elements
- Nowhere else in the product
- Each instance is independent — home glow and Auth Sheet glow never synchronize, even if both visible simultaneously
- Both glows are decorative only (aria-hidden="true") and carry no semantic meaning
- Initial opacity cycle: 10–15% over 2.5s duration, ease-in-out cubic-bezier(0.4, 0, 0.2, 1)
- Blur radius: 200px (initial state)
- Shrinks to minimum state (4–6% opacity, ~100px blur) as conversation fills viewport
- Respects `prefers-reduced-motion`: static opacity at 10% (mid-cycle), no pulsing, 200px blur maintained

[END PROPOSED ADDITION]

## Nav Shell
- Top bar: Health360 wordmark left (text, not avatar), account indicator right (44×44pt minimum)
- Logged-out state: muted ghost chip labeled "Sign in" in top-right nav position
- No bottom navigation — single-surface chat experience
- Prompt bar pinned to bottom of viewport — always bottom-anchored
- Starter chips in horizontal scrollable row between top bar and prompt bar

## Screens

### Screen 1: Chat Home (Logged-Out Default)

**Purpose:** The primary conversational interface. Logged-out users land here and can interact with the AI without signing in. Serves user stories US-3, US-4, US-5.

**States:** default | loading | conversation-active | empty | error

**Layout (Mobile & Web):**

**Top Navigation Bar (Fixed, always visible)**
- Background: `--bg` (#0A0A0F)
- Height: 64px on mobile, 56px on web
- Padding: 16px horizontal, 12px vertical
- Layout: flex, space-between

**Left Section (Wordmark only):**
- Health360 wordmark: gradient text (135° violet #7C6FCD → teal #4FAFA8), system-ui 20px 600 weight
- No tagline in top nav

**Right Section (Account Indicator):**
- Logged-out state: ghost chip labeled "Sign in", 44×44pt minimum touch target, teal border 15% opacity (#4FAFA8), rounded pill (40–48px border-radius), transparent background
- Logged-in state: TBD (user avatar or account menu — deferred to logged-in variant screen)

**Conversation Area (Scrollable, centered)**
- Max-width: 680px
- Full-height scrollable container positioned below top bar
- Padding: 32px horizontal (mobile reduces to 16px on very small screens)
- Empty state on load displays: centered "Health360" heading (gradient text, 28px, 600 weight) with tagline "All your health. One conversation" directly below (muted text rgba(248, 248, 247, 0.45), system-ui 12px 400 weight, 4px gap between heading and tagline)

**Starter Chips Row (Positioned between conversation area and prompt bar)**
- Horizontal scrollable row, 16px gap between chips
- Chips displayed as rounded pills (40–48px border-radius), teal border 15% opacity (#4FAFA8), dark surface background (#13131A)
- Chips fade out on first AI message: 150ms parallel fade-out, ease-out easing
- Removed from DOM after fade completes (or hidden with display: none)

**Prompt Bar (Pinned to bottom of viewport)**
- Always accessible, never scrolls out of view
- Rounded pill container (40–48px border-radius), teal border 15% opacity (#4FAFA8), dark surface background (#13131A)
- Input field inside: placeholder text "Ask anything about your health" in subtle text (rgba(248, 248, 247, 0.18))
- Glow effect positioned behind prompt bar: dual radial glows (violet + teal) pulsing asynchronously, 80px blur radius, 10–15% opacity cycle, 4s duration, offset -2s on teal

**Glow behavior as conversation fills:**
- Triggered approximately after 4 messages or 60% of viewport height occupied by conversation
- Glow transitions over ~500ms ease-in-out: blur radius 200px → 100px, opacity cycle 10–15% → 4–6%
- Minimum state maintained: 4–6% opacity, ~100px blur radius — still present, nearly imperceptible

### Screen 2: Auth Sheet

**Purpose:** SSO authentication interface. Opened from "Sign in" ghost chip or warning modal CTAs. Serves user stories US-1, US-2, US-6.

**States:** default | loading | error

**Layout (Mobile & Web):**

**Mobile:**
- Bottom sheet, slides up from bottom over 0.35s cubic-bezier(0.4, 0, 0.6, 1)
- Full viewport height or content-driven height (whichever fits)
- Rounded top corners: 16px border-radius
- Background: `--surface` (#13131A)
- Padding: 24px horizontal, 32px vertical (top and bottom)

**Web:**
- Centered modal overlay
- Fades in + scales up (0.95 → 1.0) over 0.35s cubic-bezier(0.4, 0, 0.6, 1)
- Max-width: 400px
- Rounded corners: 16px border-radius
- Background: `--surface` (#13131A)
- Scrim (darkened background): rgba(0, 0, 0, 0.5), clickable to dismiss
- Padding: 24px horizontal, 32px vertical

**Header Section:**
- Close button: "X" icon, top-left corner (mobile) or top-right corner (web), 44×44pt minimum, transparent background, muted text (#F8F8F7 at 45% opacity) on hover/focus
- Heading: "Sign in to Health360", gradient text (135° violet #7C6FCD → teal #4FAFA8), system-ui 20px 600 weight, centered
- Subheading below heading: "Your conversation will be saved when you sign in.", muted text (rgba(248, 248, 247, 0.45)), system-ui 14px 400 weight, centered, 12px gap below heading

**SSO Buttons Section:**
- Two buttons stacked vertically, 16px gap between them
- Each button: rounded pill (40–48px border-radius), teal border 15% opacity (#4FAFA8), `--surface` background (#13131A), 56px height minimum, full width
- Button text: "Sign in with Google" and "Sign in with Apple", system-ui 16px 500 weight, primary text (#F8F8F7)
- Glow effect: violet-teal dual radial glows pulsing independently behind buttons, 10–15% opacity cycle, 4s duration, offset -2s on teal, 80px blur radius
- Glow positioned absolutely behind button container, not clipped
- On hover (web only): border-color increases to teal 30% opacity, background increases to rgba(19, 19, 26, 1)
- On focus: same styling as hover, outline visible
- On active/press (mobile): background darkens, button remains tappable

**Loading State:**
- Triggered on SSO provider redirect
- Button text changes to "Signing in with [Provider]..."
- Spinner appears left of text inside button (12px diameter, rotating at 1s per rotation, primary text color)
- Button becomes disabled (opacity 0.6, no pointer events)
- Sheet remains open, not dismissible during loading

**Error State:**
- Triggered if SSO provider is unavailable or authentication fails
- Error message displays above buttons: "Sign in failed. Please try again.", error text (#e06c75), system-ui 14px 400 weight, centered, 16px margin below subheading
- Buttons re-enable and are tappable again
- Close button remains functional — user can dismiss and try again later

**Dismiss Behavior:**
- Escape key closes sheet
- Scrim tap (web only) closes sheet
- Close button ("X") closes sheet
- On close: sheet slides down (mobile) or fades out + scales down (web) over 0.35s cubic-bezier(0.4, 0, 0.6, 1)
- Focus returns to trigger element (the "Sign in" ghost chip or CTA button that opened the sheet)
- Sheet does not dismiss during loading state

**Accessibility:**
- Sheet role: dialog, aria-modal="true", aria-labelledby="auth-sheet-heading"
- Heading element: h1 with id="auth-sheet-heading"
- Close button: aria-label="Close", visible focus state
- Focus trap: Tab cycles through close button → subheading → Google button → Apple button → close button (loop)
- Escape key triggers close
- Screen reader announces: "Dialog: Sign in to Health360. Your conversation will be saved when you sign in."
- SSO buttons read as: "Button: Sign in with Google", "Button: Sign in with Apple"
- Error message is announced on state change

**Interactions & Animations:**
- Entry: 0.35s slide-up (mobile) or fade-in + scale (web)
- Exit: 0.35s slide-down (mobile) or fade-out + scale (web)
- Button hover: 0.20s border and background transition
- Loading spinner: continuous rotation, no motion preference respects animation pause
- Glow: independent violet-teal pulse, 10–15% opacity over 4s, offset -2s on teal

**Notes:**
- The glow effect is positioned as a fixed or absolute background layer behind the SSO button container — it extends beyond button edges
- Glow is decorative only (aria-hidden="true")
- No shadow or elevation effect on buttons — only the glow provides depth
- On success (after SSO completes), the sheet dismisses automatically and the user is taken to Chat Home (logged-in state) with conversation preserved
- Session expiry or auth failure during SSO is handled gracefully: user sees error message, buttons re-enable, user can retry or close

## User Flows

### Flow: US-1 — New user sign-up
Landing (logged-out default) → [taps "Sign in" ghost chip] → Auth Sheet (default) → [completes Google or Apple SSO] → Landing (logged-in default)

### Flow: US-2 — Returning user sign-in
Landing (logged-out default) → [taps "Sign in" ghost chip] → Auth Sheet (default) → [completes Google or Apple SSO] → Landing (logged-in default)

### Flow: US-3 — Explore before sign-up
Landing (logged-out default) → [interacts with chat] → Landing (conversation active, logged-out)

### Flow: US-4 — Persistent logged-out indicator
Landing (logged-out default) — "Sign in" ghost chip persistently visible in top-right throughout all logged-out states. Ambient only, never blocking interaction.

### Flow: US-5 — In-conversation sign-in nudge
Landing (conversation active, logged-out) → [after first AI response] → in-conversation nudge surfaces: "Your conversation won't be saved unless you sign in. [Sign in]" → [user taps Sign in CTA] → Auth Sheet → [completes SSO] → Landing (logged-in, conversation preserved)

Alt: user dismisses nudge → continues chatting logged-out → conversation lost on session expiry.

### Flow: US-6 — Conversation preserved on sign-up from logged-out session
Auth Sheet (opened from any nudge or "Sign in" chip) → [completes SSO] → Landing (logged-in) → conversation history preserved and accessible

## Accessibility

**Color & Contrast**
- Text primary (#F5F5F5) on background (#0A0E27): contrast ratio 14.2:1 (WCAG AAA)
- Text primary on surface (#151B38): contrast ratio 13.1:1 (WCAG AAA)
- CTA text (white) on accent gradient: maintains WCAG AA minimum across full gradient range
- Glow treatment: decorative only, carries no meaning. Screen readers unaffected.
- Color is never the only signal for state change. Every state change accompanied by label, icon, or structural change.

**Interactive Elements**
- Logged-out ghost chip: 44×44pt minimum touch target. Screen reader label: "Sign in to your account."
- SSO buttons: 44×44pt minimum. Screen reader labels: "Sign in with Google", "Sign in with Apple".
- Starter chips: 44px height minimum. Screen reader reads each chip as button with descriptive label. Example: "Button: How did I sleep last week?"
- All buttons have visible focus states (outline or background highlight)

**Modals & Sheets**
- Auth Sheet and warning modals trap focus while open
- Escape key closes dismissable sheets and modals
- Focus returned to trigger element (e.g., "Sign in" chip) after sheet closes

**Keyboard Navigation (Web)**
- All interactive elements reachable by Tab
- Starter chips navigable with arrow keys
- Tab order: top-left → top-right → prompt bar → Auth Sheet (if open)
- No keyboard traps

**Screen Readers**
- Page title reads: "Health360 — Chat with your AI health coach"
- Wordmark: ARIA role `presentation` (duplicates page title)
- Tagline reads as static text
- In-conversation nudge: Screen reader reads "System notice: Your conversation won't be saved. Button: Sign in to save."
- Navigation warnings include full context before CTA

**RTL Support**
- Layout mirrors for RTL languages (Arabic, Hebrew)
- Logo moves to right, account indicator to left
- Wordmark and tagline remain centered
- Starter chips scroll direction reverses
- Accent gradient direction reverses (135° becomes 315°)
- All text alignment and spacing mirrors appropriately

**Mobile & Touch**
- One-thumb reachability: all primary actions in bottom third of screen on mobile
- Bottom sheets for all modals on mobile (native interaction model)
- Minimum 44×44pt touch targets, no exceptions

**Motion**
- Glow animation respects `prefers-reduced-motion`: if enabled, glow opacity is static at 30% (middle of cycle) with no pulsing
- All transitions respect user motion preferences

## Design System Updates

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Color Palette]

**Color Palette (Archon Labs, extracted from getarchon.dev)**

```
--bg:       #0A0A0F   // Page background — deep charcoal, near black
--surface:  #13131A   // Card/sheet surfaces — fractionally lighter
--text:     #F8F8F7   // Primary text — off-white, full contrast on dark bg
--muted:    rgba(248, 248, 247, 0.45)   // Secondary text, labels
--subtle:   rgba(248, 248, 247, 0.18)   // Tertiary text, placeholders
--border:   rgba(255, 255, 255, 0.07)   // Borders and dividers

--violet:   #7C6FCD   // Accent — soft violet
--teal:     #4FAFA8   // Accent — muted teal

--error:    #e06c75
--warning:  #e5c07b
```

[END PROPOSED ADDITION]

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Accent Gradient]

**Accent Gradient**

```css
linear-gradient(135deg, #7C6FCD, #4FAFA8)
```

Applied to: primary headings, logo/wordmark, signature UI moments. Never in conversational content.

[END PROPOSED ADDITION]

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Glow Animation]

**Glow (Signature Effect)**

Two independent radial glows — violet and teal — rendered separately and animated asynchronously.

**Violet glow:**
```css
background: radial-gradient(ellipse at center, rgba(124, 111, 205, 0.12) 0%, rgba(124, 111, 205, 0.04) 50%, transparent 100%);
filter: blur(48px);

@keyframes heartbeat-violet {
  0%   { opacity: 0.08; transform: scale(0.97); }
  12%  { opacity: 0.12; transform: scale(1.20); }
  36%  { opacity: 0.10; transform: scale(1.13); }
  60%  { opacity: 0.08; transform: scale(0.98); }
  100% { opacity: 0.08; transform: scale(0.97); }
}
animation: heartbeat-violet 3.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
```

**Teal glow:**
```css
background: radial-gradient(ellipse at center, rgba(79, 175, 168, 0.10) 0%, rgba(79, 175, 168, 0.03) 50%, transparent 100%);
filter: blur(48px);

@keyframes heartbeat-teal {
  0%   { opacity: 0.08; transform: scale(0.97); }
  12%  { opacity: 0.12; transform: scale(1.20); }
  36%  { opacity: 0.10; transform: scale(1.13); }
  60%  { opacity: 0.08; transform: scale(0.98); }
  100% { opacity: 0.08; transform: scale(0.97); }
}
animation: heartbeat-teal 3.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
animation-delay: -1.75s;   /* offset so violet and teal pulse out of sync */
```

**Usage rules:**
- Applied in exactly two places: (1) chat home background behind prompt bar, (2) Auth Sheet behind SSO buttons
- Positioned as a faint radial halo behind rounded pill containers and interactive elements
- Nowhere else in the product
- Each instance is independent — home glow and Auth Sheet glow never synchronize
- Both glows are decorative only (aria-hidden="true") and carry no semantic meaning
- Opacity: 8–12% cycle over 3.5 seconds — ambient warmth, imperceptible unless watched closely
- Blur radius: 48px (subtle, background-only effect)
- Respects `prefers-reduced-motion`: static opacity at 10% (middle of cycle), no pulsing, 48px blur maintained

[END PROPOSED ADDITION]

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Typography]

**Typography**

- Font family: system-ui (no custom fonts required)
- Weights: 400 (regular), 500 (medium), 600 (semibold)
- Scaling: no custom font loading, system fonts only
- Gradient text (violet → teal): applied to primary headings and UI chrome only — never in conversational content
- Body typography: clean, readable, system fonts with generous line-height

[END PROPOSED ADDITION]

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Spacing & Shape]

**Spacing and Shape**

- Border radius: 12px (cards), 16px (sheets), 24px (large containers), 40–48px (rounded pills/interactive containers), 9999px (minimal edge cases)
- Spacing scale: 8pt grid
- Negative space: 60–70% empty on hero screens, 30–40% empty within containers — signature Archon Labs aesthetic

[END PROPOSED ADDITION]

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Transitions]

**Transitions**

- Fast: 0.15s ease
- Default: 0.20s ease
- Slow: 0.35s ease

[END PROPOSED ADDITION]

[PROPOSED ADDITION TO DESIGN_SYSTEM.md — Interactive Element Styling]

**Rounded Pill Containers (Prompt Bar, SSO Buttons)**

```css
border-radius: 40–48px;
border: 1px solid rgba(79, 175, 168, 0.15);   /* teal at 15% opacity */
background: rgba(19, 19, 26, 0.8);
padding: 14–16px;
transition: all 0.20s ease;

&:hover {
  border-color: rgba(79, 175, 168, 0.30);
  background: rgba(19, 19, 26, 1);
}

&:focus-within {
  border-color: rgba(79, 175, 168, 0.30);
  background: rgba(19, 19, 26, 1);
}
```

Glow effect positioned behind: radial halo, 8–12% opacity, 48px blur, independent animation per instance.

[END PROPOSED ADDITION]

## Open Questions
- [type: engineering] [blocking: no] Unauthenticated session TTL is provisionally set at 60 minutes inactivity-based expiry with a warning at 10 minutes remaining — needs infrastructure confirmation before engineering begins.