## Brand

**Color Palette**
- `--bg:` `#0A0A0F` // Page background
- `--surface:` `#13131A` // Card surfaces
- `--text:` `#F8F8F7` // Primary text
- `--violet:` `#7C6FCD` // Accent violet
- `--teal:` `#4FAFA8` // Accent teal
- `--error:` `#e06c75` // Error

**Typography**
Font family: system-ui
Font sizes: text-sm / text-base / text-lg

**Glow (Signature Effect)**

Two independent radial glows — violet and teal — rendered separately and animated asynchronously.

**Violet glow:**
```css
filter: blur(200px);

@keyframes heartbeat-violet {
  0%   { opacity: 0.45; transform: scale(0.97); }
  12%  { opacity: 0.75; transform: scale(1.20); }
  36%  { opacity: 0.60; transform: scale(1.13); }
  60%  { opacity: 0.45; transform: scale(0.98); }
  100% { opacity: 0.45; transform: scale(0.97); }
}
animation: heartbeat-violet 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
```

**Teal glow:**
```css
animation-delay: -0.5s;
```
