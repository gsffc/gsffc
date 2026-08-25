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
shared-header.liquid`, `site/assets/ui/*`, `app/views/partials/
shared-header.ejs`, `app/public/ui/*`, and both `favicon.png`s). Never edit
the generated files; CI fails PRs whose generated outputs are stale. Per-site
internal nav lives in `ui/slots/` (www's seasons/language dropdowns; the
app's nav is #10's). The login corner script's session-endpoint contract is
provisional until #10 defines it — it degrades to a plain 登录 link.

## App (`app/`)

Express + EJS + PostgreSQL, run straight from `app/` (Node 22). It keeps its
own `package.json` — the root npm scripts do not cover it (AGENTS.md).

Setup: a `.env` in `app/` (copy `.env.example`) with `DATABASE_URL` and
`SESSION_SECRET`; `PORT` is optional and defaults to 3000. Then:

| Task | Command (from `app/`) |
|---|---|
| Run the app | `npm install && npm start` → http://localhost:3000 |
| Run it as Netlify does | `netlify dev` (needs `npm i -g netlify-cli`) |
| Check DB connectivity | `curl localhost:3000/healthz` |

`/` redirects to `/calendar`, which redirects to `/login` when signed out.

Notes:

- **Which database.** Either point `DATABASE_URL` at the hosted Supabase
  instance — in which case **localhost is writing to production club data** —
  or run a throwaway one:
  `docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`,
  then apply `db/schema.sql` once (idempotent; the app never auto-migrates).
  A fresh database has no users — see the first-admin bootstrap in
  `netlify.md`.
- **`npm start` is not the deploy target.** It runs plain Express and skips
  the function bundling, the `/*` redirect, and the CDN/function split.
  `netlify dev` exercises those; the PR's deploy preview is the real proof.
- **Generated files**: `public/ui/`, `public/favicon.png`, and
  `views/partials/shared-header.ejs` come from `npm run ui:build` at the repo
  root. Never edit them here.
- Node 22 matches Netlify (pinned there by the `NODE_VERSION` env var, not by
  `engines`). Newer Node runs locally fine but won't catch version-specific
  breakage.
