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

## App (`app/`)

Not onboarded yet — see #2 and `netlify.md`.
