# app/ — GSFFC App

Member app (Express serverless) → Netlify → https://app.gsffc.org.
Onboarded by its author via #2 — **this placeholder README is replaced/merged
into the app's real README when that lands.**

## Environment variables (set in Netlify → Site settings → Environment variables)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Netlify Functions are stateless; sessions are also stored in this DB). `SUPABASE_DATABASE_URL` is accepted as a fallback |
| `SESSION_SECRET` | Random string signing session cookies |
| `CLUB_TIMEZONE` | Optional; default `America/Los_Angeles` — governs the check-in window |
| `NODE_VERSION` | `22` — Netlify ignores `engines`; this pins the function runtime |

Never commit real values — `.env` is git-ignored.

## Local dev (once #2 lands)

Two supported ways to get a database:

1. **Hosted** — point `DATABASE_URL` at the Supabase instance (or any
   Postgres) in a local `.env`.
2. **Local container** — `docker run --rm -e POSTGRES_PASSWORD=postgres
   -p 5432:5432 postgres:16`, then
   `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` in
   `.env`. Apply `db/schema.sql` once (the app does not auto-create tables;
   the schema self-creates its namespace, so a fresh database works).

Then `npm install && npm start` inside `app/` (Node 22). `netlify dev`
simulates the Netlify Functions environment (`npm i -g netlify-cli`).

## Deployment

Netlify deploys on pushes to `main` touching `app/**`, with **base directory
`app/`**. The whole Express app is bundled via `serverless-http` into a single
Netlify Function; `public/` static assets are served from the CDN directly.
Setup details: `docs/runbooks/netlify.md`.
