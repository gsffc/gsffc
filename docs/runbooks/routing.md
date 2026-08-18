# Routing runbook

URL structure and redirect inventory after the monorepo cutover (#7).

## Hostnames

| Hostname | Served by | Notes |
|---|---|---|
| `www.gsffc.org` | This repo (`site/`) via GitHub Pages | Canonical site |
| `gsffc.org` (apex) | DNS A records → GitHub Pages; 301 → www | Keep the 4 A records (185.199.108–111.153) |
| `app.gsffc.org` | Netlify (Donglin's account, pre-#9) | Member app |
| `gsffc.github.io` | `gsffc/gsffc.github.io` redirect repo | Meta-refresh + JS redirect to same path on www |

## Site URL structure (preserved from the Jekyll site)

- Posts: `/news/YYYY/MM/DD/<slug>.html` (from `_posts/` filename date + slug,
  `categories` front matter as path prefix). `/en/...` mirrors every page with
  English chrome.
- Seasons: `/seasons/<key>/` — GSF-centric page; game pages at
  `/seasons/<key>/games/<id>/` (id sanitized: spaces→`_`, colons stripped);
  team pages `/seasons/<key>/<team>/`; per-season stats
  `goal_scorers.html` / `assists_list.html`.
- Tag pages: `/tag/<tag>/` (jekyll-tagging pretty slug: lowercase,
  punctuation→`-`, percent-encoded).
- `/about.html`, `/404.html`, `/feed.xml`, `/en/feed.xml`.
- League-wide standings are intentionally NOT here — season pages link out to
  nccsf.org. Dropped during migration: game pages for non-GSF games and the
  old broken seasonless duplicates (`/seasons/games/...`).

## Redirect rules

- `gsffc.github.io/*` → `https://www.gsffc.org/*` (same path), via the
  redirect repo's `index.html` + `404.html`.
- GitHub Pages clean-URL aliases work as before: `/about` ≡ `/about.html`,
  `/seasons/25q4` ≡ `/seasons/25q4/`.
- If a page must move, add the redirect to the redirect repo only when the
  old URL lived on the gsffc.github.io hostname; for moves within www, prefer
  keeping the URL stable instead.

## Changing DNS

DNS lives at Squarespace. Records in active use: apex A (×4, GitHub Pages),
`www` CNAME → `gsffc.github.io`, `app` CNAME → Netlify, verification TXT
(`_gh-gsffc-o` and `_github-pages-challenge-gsffc`) — all must stay.
