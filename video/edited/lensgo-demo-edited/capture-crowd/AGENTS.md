# LensGo 模拟数据发布器

Source: http://47.82.123.50:18001/

To create a video from this capture, use the `product-launch-video` skill.

## What's in This Capture

| File | Contents |
|------|----------|
| `screenshots/contact-sheet.jpg` | **View this first.** All scroll screenshots in labeled grid — see the entire page at a glance |
| `screenshots/scroll-*.png` | Individual viewport screenshots if you need detail on a specific section. |
| `extracted/tokens.json` | Design tokens: 16 colors, 2 fonts, 2 headings, 0 CTAs |
| `extracted/design-styles.json` | Computed styles from live DOM: typography hierarchy, button/card/nav styles, spacing scale, border-radius, box shadows. Primary data source for DESIGN.md. |
| `extracted/asset-descriptions.md` | One-line description of every downloaded asset. Read this for asset selection — only open individual files for safe-zone checking. |
| `extracted/visible-text.txt` | Page text in DOM order, prefixed with HTML tag (`[h1]`, `[p]`, `[a]`). Use as context — rephrase freely. |
| `assets/contact-sheet.jpg` | Downloaded images in labeled grid — view before opening individual files |
| `assets/svgs/contact-sheet.jpg` | SVGs rendered as thumbnails in labeled grid |
| `assets/` | Individual downloaded images, SVGs, and font files. |

## Brand Summary

- **Colors**: #1C1F24 (surface-dark), #FAFBFC (bg-light), #656D78 (neutral), #E2E5EA (surface-light), #FFFFFF (bg-light), #F5F6F8 (bg-light), #10141A (surface-dark), #000000 (bg-dark), #FF7F16 (accent), #D9483F (accent)
- **Fonts**: Segoe UI (400,600,620,650,700), Lucida Console (700)
