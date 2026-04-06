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
