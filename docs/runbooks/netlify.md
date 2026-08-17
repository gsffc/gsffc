# Netlify runbook

How `app/` (GSFFC App) deploys to Netlify → https://app.gsffc.org.

## One-time site setup

1. Netlify → **Add new site → Import an existing project** → GitHub →
   `gsffc/gsffc`.
2. **Base directory: `app/`**. Leave build command empty (no build step;
   the function is bundled by Netlify) — publish and functions directories
   come from `app/netlify.toml`.
3. Set environment variables (**Site settings → Environment variables**):
   - `DATABASE_URL` — PostgreSQL connection string
   - `SESSION_SECRET` — random string
4. Point `app.gsffc.org` at the site (Domain settings → add custom domain;
   DNS record per the domain registrar).

> **Open decision (needs @Dongminator, tracked in #9):** whether the Netlify
> site and Supabase database live under Donglin's personal accounts (he
> invites @aenon to the team) or under a fresh org-owned Netlify team.
> Repo-side config is identical either way.

## How the pieces map (base dir `app/`)

The app's `netlify.toml` (arrives with #2, from the author's original repo):

| Setting | Value | Meaning under base dir `app/` |
|---|---|---|
| `publish` | `public` | Static assets in `app/public/` served from the CDN |
| `functions` | `netlify/functions` | Function sources in `app/netlify/functions/` |
| `external_node_modules` | `["ejs"]` | EJS is loaded via dynamic `require`; shipped in `node_modules`, not bundled |
| `included_files` | `["views/**"]` | EJS templates read from disk at runtime |
| redirect | `/* → /.netlify/functions/server` (200) | Everything that isn't a static file hits the Express app |

The whole Express app runs as one function via `serverless-http`. Node 22 is
pinned by `app/package.json` `engines`.

## Deploy triggers

- Push to `main` touching `app/**` → production deploy.
- Pull requests → deploy previews (once the site is connected).
- Pre-#2, deploys fail (empty `app/`) — expected; the connection is proven
  when the first real deploy succeeds at #2.

## Database

The app needs PostgreSQL for both data and sessions (`connect-pg-simple`).
Schema and seed data: `app/db/schema.sql`, applied manually once per
environment — the app never auto-creates tables. Existing Supabase instance
is the likely home (pending the open decision above). No credentials in git;
`.env` is git-ignored, variables documented in `app/README.md`.
