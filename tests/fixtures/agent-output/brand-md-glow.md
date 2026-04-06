## Glow (Signature Effect)

Two independent radial glows — violet and teal — rendered separately and animated asynchronously.

**Violet glow:**
```css
background: radial-gradient(circle, rgba(124, 111, 205, 0.42) 0%, rgba(124, 111, 205, 0.14) 50%, transparent 100%);
filter: blur(80px);

@keyframes heartbeat-violet {
  0%   { opacity: 0.55; transform: scale(0.97); }
  12%  { opacity: 1.00; transform: scale(1.20); }
  36%  { opacity: 0.90; transform: scale(1.13); }
  60%  { opacity: 0.58; transform: scale(0.98); }
  100% { opacity: 0.55; transform: scale(0.97); }
}
animation: heartbeat-violet 4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
```

**Teal glow:**
```css
background: radial-gradient(circle, rgba(79, 175, 168, 0.34) 0%, rgba(79, 175, 168, 0.11) 50%, transparent 100%);
filter: blur(80px);

@keyframes heartbeat-teal {
  0%   { opacity: 0.50; transform: scale(0.97); }
  12%  { opacity: 0.95; transform: scale(1.20); }
  36%  { opacity: 0.85; transform: scale(1.13); }
  60%  { opacity: 0.55; transform: scale(0.98); }
  100% { opacity: 0.50; transform: scale(0.97); }
}
animation: heartbeat-teal 4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
animation-delay: -1.8s;   /* offset so violet and teal pulse out of sync */
```

**Usage rules:**
- Applied in exactly two places: (1) chat home background behind prompt bar, (2) Auth Sheet behind SSO buttons
- Nowhere else in the product
- Each instance is independent — home glow and Auth Sheet glow never synchronize
- Both glows are decorative only (aria-hidden="true") and carry no semantic meaning
