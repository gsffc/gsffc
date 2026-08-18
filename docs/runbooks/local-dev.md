# Local dev runbook

## Static site (`site/`)

Setup: `cd site && npm ci` (Node 22 per `.nvmrc`; nothing else to install —
no Ruby, no containers).

| Task | Command |
|---|---|
| Live-reload preview | `npm run dev:site` (repo root) or `npm run serve` in `site/` → http://localhost:8080 |
| Production build | `npm run build` in `site/` (or `npm run build:site` at root) → `site/_site/` |

Notes:

- **Languages**: the site builds twice from one content tree — zh at `/`,
  en UI chrome at `/en/`. `serve` previews zh only; `npm run build` produces
  both. Posts are Chinese-language in both variants by design.
- **Styles**: `site/assets/main.scss` (imports `_sass/`) compiles to
  `assets/main.css` automatically on every build/serve rebuild.
- **Adding a post**: new file `site/_posts/YYYY-MM-DD-slug.md` (the date
  prefix is required — files without it are skipped, matching Jekyll). Front
  matter: `layout: game_post` + `season_key`/`game_key` for match reports,
  else `layout: post`. Media via `npm run convert:media` (see
  `media.md`).
- **Season data**: JSON in `site/_data/seasons/<key>/` — games, teams,
  config. The GSF-centric filter (`scripts/filter-season-data.mjs` at root)
  documents what's kept; new seasons are added by hand now.

## Shared UI (`ui/`)

The header and design tokens shared by www and the app live in `ui/` —
single source of truth. After editing anything there:

```bash
npm run ui:build
```

This regenerates the committed per-site outputs (`site/_includes/
shared-header.liquid`, `site/assets/ui/*`, and — once #2 lands —
`app/views/partials/shared-header.ejs`, `app/public/css/ui/*`). Never edit
the generated files; CI fails PRs whose generated outputs are stale. Per-site
internal nav lives in `ui/slots/` (www's seasons/language dropdowns; the
app's nav is #10's). The login corner script's session-endpoint contract is
provisional until #10 defines it — it degrades to a plain 登录 link.

## App (`app/`)

Not onboarded yet — see #2 and `netlify.md`.
