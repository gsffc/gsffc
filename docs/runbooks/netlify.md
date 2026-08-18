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
   - `NODE_VERSION` = `22` — Netlify does **not** read `engines` from
     package.json; this (or an `.nvmrc` in `app/`) is what pins Node.
   - Optional: `CLUB_TIMEZONE` (default `America/Los_Angeles`; governs the
     check-in window). If the site is created via Netlify's Supabase
     integration, `SUPABASE_DATABASE_URL` is set automatically and the app
     accepts it as a `DATABASE_URL` fallback.
4. Point `app.gsffc.org` at the site (Domain settings → add custom domain;
   DNS record per the domain registrar).

> **Hosting decision (2026-08-18):** the site lives on @Dongminator's
> personal Netlify (Free) — no migration from the existing
> `gsffc-test.netlify.app` deployment. He owns the dashboard (env vars,
> settings, rollback); everyone else deploys by git push. A club-owned team
> costs $20/month (Netlify Pro — Free is individual-only); revisit if shared
> dashboard access becomes necessary. Supabase unchanged (free tier allows
> unlimited org members if shared ownership is wanted later).

## How the pieces map (base dir `app/`)

The app's `netlify.toml` (arrives with #2, from the author's original repo):

| Setting | Value | Meaning under base dir `app/` |
|---|---|---|
| `publish` | `public` | Static assets in `app/public/` served from the CDN |
| `functions` | `netlify/functions` | Function sources in `app/netlify/functions/` |
| `node_bundler` | `esbuild` | Required for the two settings below; the default zisi tracing can't follow the dynamic `require('ejs')` |
| `external_node_modules` | `["ejs"]` | EJS is loaded via dynamic `require`; shipped in `node_modules`, not bundled |
| `included_files` | `["views/**"]` | EJS templates read from disk at runtime |
| redirect | `/* → /.netlify/functions/server` (200) | Everything that isn't a static file hits the Express app |

The whole Express app runs as one function via `serverless-http`. Node 22 is
pinned via the `NODE_VERSION` env var (see setup above); `engines` in
package.json is advisory only on Netlify.

## Deploy triggers

- Push to `main` touching `app/**` → production deploy.
- Pull requests → deploy previews (once the site is connected).
- Pre-#2, deploys fail (empty `app/`) — expected; the connection is proven
  when the first real deploy succeeds at #2.

## App CI

`.github/workflows/app-ci.yml` is path-filtered to `app/**` and runs
`npm ci` + `node --check` on the app's JS. It is intentionally standalone —
`app/` is excluded from the root Biome/tooling until @Dongminator opts in
(AGENTS.md hard rule 2), so the root npm-scripts interface does not cover it
yet. Pre-#2 (no `app/package.json`) the job skips cleanly.

## Database

The app needs PostgreSQL for both data and sessions (`connect-pg-simple`).
Schema and seed data: `app/db/schema.sql`, applied manually once per
environment — the app never auto-creates tables. Existing Supabase instance
is the likely home (pending the open decision above). No credentials in git;
`.env` is git-ignored, variables documented in `app/README.md`.
