# Bountyhall brand kit

| file | use |
| --- | --- |
| `x-profile-400.png` | X profile picture (400×400; the gem stays inside the circular crop) |
| `x-header-1500x500.png` | X header (text sits right, clear of the profile picture) |
| `article-cover-1600x640.png` | X Article cover (5:2) |
| `article-how-it-works-1600x900.png` | figure for the article |
| `logo-mark.svg` / `logo-mark-1024.png` | the mark, vector and high-resolution |
| `logo-wordmark.png` | mark + name, transparent background |
| `ARTICLE.md` | launch article, a 5-post thread, and the profile bio |

Colors: background `#0b0f17`, panel `#121826`, amber `#f5b544`, text `#e8ecf4`, muted `#8b97ad`.
Type: Inter (headings 800, body 500), JetBrains Mono (code). Both are in `fonts/` under the SIL Open Font License.

To change anything, edit `logo-mark.svg` or the pages in `src/`, then run `node brand/render.mjs` (needs Playwright).
