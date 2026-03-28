The spec's Brand section has drifted from BRAND.md. Here's what's wrong:

1. `--bg`: spec `#0A0E27` → BRAND.md `#0A0A0F`
2. `--surface`: spec `#151B38` → BRAND.md `#13131A`
3. `--violet`: spec `#8B7FE8` → BRAND.md `#7C6FCD`
4. `--teal`: spec `#4FADA8` → BRAND.md `#4FAFA8`

Patching the spec to align with BRAND.md.

DESIGN_PATCH_START
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
DESIGN_PATCH_END

Draft saved to GitHub. Review it and say *approved* when you're ready to commit and hand off to engineering.
