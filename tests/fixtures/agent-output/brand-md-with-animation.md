## Color Palette

```
--bg:       #0A0A0F
--surface:  #13131A
--text:     #F8F8F7
--violet:   #7C6FCD
--teal:     #4FAFA8
--error:    #e06c75
```

## Typography

Font: system-ui
Weights: 400 (body), 500 (label), 600 (heading)
Scale: text-xs / text-sm / text-base / text-lg / text-xl / text-2xl

## Glow (Signature Effect)

Two independent radial glows — violet and teal — rendered separately and animated asynchronously.

**Violet glow:**
```css
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
filter: blur(80px);

@keyframes heartbeat-teal {
  0%   { opacity: 0.50; transform: scale(0.97); }
  12%  { opacity: 0.95; transform: scale(1.20); }
  36%  { opacity: 0.85; transform: scale(1.13); }
  60%  { opacity: 0.55; transform: scale(0.98); }
  100% { opacity: 0.50; transform: scale(0.97); }
}
animation: heartbeat-teal 4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
animation-delay: -1.8s;
```
