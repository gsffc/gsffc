# Netlify runbook

How `app/` (GSFFC App) deploys to Netlify → https://app.gsffc.org.

## One-time site setup

The app moved here from `Dongminator/netlify-test`, which already had a
Netlify site. **Relink that site rather than creating a new one** — relinking
keeps the site ID, custom domain, environment variables, and deploy history
(so "Publish previous deploy" still reaches pre-migration builds).

1. Netlify → the existing site → **Site configuration → Build & deploy →
   Continuous deployment → Manage repository → Link to a different
   repository** → GitHub → `gsffc/gsffc`, production branch `main`. The
   Netlify GitHub App must be authorized on the `gsffc` org first (an org
   owner approves the installation).
2. **Base directory: `app`**. Leave build command, publish directory, and
   functions directory **empty** — there is no build step, and
   `app/netlify.toml` supplies the rest. Settings in `netlify.toml` win over
   the UI fields, so filling them in only creates two places to disagree.
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

The app's `netlify.toml` lives at `app/netlify.toml`; every path in it is
relative to the base directory:

| Setting | Value | Meaning under base dir `app/` |
|---|---|---|
| `publish` | `public` | Static assets in `app/public/` served from the CDN |
| `functions` | `netlify/functions` | Function sources in `app/netlify/functions/` |
| `node_bundler` | `esbuild` | Required for the two settings below; the default zisi tracing can't follow the dynamic `require('ejs')` |
| `external_node_modules` | `["ejs"]` | EJS is loaded via dynamic `require`; shipped in `node_modules`, not bundled |
| `included_files` | `["views/**"]` | EJS templates read from disk at runtime |
| redirect | `/* → /.netlify/functions/server` (200) | Everything that isn't a static file hits the Express app |
| `ignore` | `git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- .` | Cancels the build when the commit range touched nothing in `app/` (the command runs from the base directory) |

The whole Express app runs as one function via `serverless-http`. Node 22 is
pinned via the `NODE_VERSION` env var (see setup above); `engines` in
package.json is advisory only on Netlify.

## Deploy triggers

- Push to `main` → production deploy, **but only when the push touched
  `app/`**. Netlify has no commit path filtering of its own, so the `ignore`
  command in `netlify.toml` supplies it; a site-only commit shows up as
  "Build canceled", which is the rule working, not a failure.
- Pull requests → deploy previews, under the same `ignore` rule. A preview
  URL looks like `deploy-preview-<PR#>--<site>.netlify.app`.
- `$CACHED_COMMIT_REF` is empty on a first build and after a cleared cache.
  The command then fails and Netlify builds anyway — the safe direction.
- **Deploy previews inherit production's environment variables** unless a
  variable is scoped to a specific deploy context. Today that means a preview
  talks to the production database. Scope `DATABASE_URL` per context before
  previewing anything that writes.

## App CI

`.github/workflows/app-ci.yml` is path-filtered to `app/**` and runs
`npm ci` + `node --check` on the app's JS. It is intentionally standalone —
`app/` is excluded from the root Biome/tooling until @Dongminator opts in
(AGENTS.md hard rule 2), so the root npm-scripts interface does not cover it
yet. The job is guarded on `app/package.json` existing, so it also skips
cleanly on a checkout that predates the app.

## Database

The app needs PostgreSQL for both data and sessions. `app/db/schema.sql` is
applied manually (safe to re-apply: it's `IF NOT EXISTS`-idempotent); the
session table is the one exception — `connect-pg-simple` auto-creates it at
runtime. **First-admin bootstrap** (fresh databases only): hand-INSERT one
user with a bcrypt hash, then `UPDATE gsffc.users SET role='ADMIN'` — the
bulk-add-members admin page needs an existing login. The production Supabase
instance already has users, so this matters mainly for fresh dev DBs.
Health-check endpoint: `GET /healthz` reports DB connectivity + table count. Existing Supabase instance (decided, #9). No credentials in git;
`.env` is git-ignored, variables documented in `app/README.md`.
