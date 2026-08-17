# app/ — GSFFC App

Member app (Express serverless) → Netlify → https://app.gsffc.org.
Onboarded by its author via #2 — **this placeholder README is replaced/merged
into the app's real README when that lands.**

## Environment variables (set in Netlify → Site settings → Environment variables)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Netlify Functions are stateless; sessions are also stored in this DB) |
| `SESSION_SECRET` | Random string signing session cookies |

Never commit real values — `.env` is git-ignored.

## Local dev (once #2 lands)

Two supported ways to get a database:

1. **Hosted** — point `DATABASE_URL` at the Supabase instance (or any
   Postgres) in a local `.env`.
2. **Local container** — `docker compose up` a throwaway Postgres, apply
   `db/schema.sql` once (the app does not auto-create tables).

Then `npm install && npm start` inside `app/` (Node 22). `netlify dev`
simulates the Netlify Functions environment (`npm i -g netlify-cli`).

## Deployment

Netlify deploys on pushes to `main` touching `app/**`, with **base directory
`app/`**. The whole Express app is bundled via `serverless-http` into a single
Netlify Function; `public/` static assets are served from the CDN directly.
Setup details: `docs/runbooks/netlify.md`.
