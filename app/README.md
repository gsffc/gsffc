# app/ — GSFFC App

The member app: Express + PostgreSQL, running as a single Netlify Function →
https://app.gsffc.org. Event calendar, signup, and GPS check-in.

UI text is Chinese; code, comments, and docs are English (AGENTS.md hard
rule 4).

## Features

- Login / logout (session auth; protected pages redirect to `/login`)
- `/calendar` — upcoming and past events
- `/event/:id` — details, signup and cancellation (with a capacity limit),
  the attendee list, and comments
- **GPS check-in** — a signed-up member taps 📍 签到, the browser reports its
  location, and the server accepts it only if the distance to the pitch is
  within the event's check-in radius (stored per event, default 10 m).
  Checked-in members are marked in the list; cancelling a signup clears the
  check-in.
- Admins set the check-in point and radius on a map in the add/edit event
  dialog — search by place name, drag the pin, drag the green handle on the
  circle's edge to resize.
- `/members` — member list
- `GET /healthz` — health check: reports DB connectivity and table count

## Environment variables

Set in Netlify → Site settings → Environment variables; locally in `app/.env`
(git-ignored — see `.env.example`).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Netlify Functions are stateless; sessions are also stored in this DB). `SUPABASE_DATABASE_URL` is accepted as a fallback |
| `SESSION_SECRET` | Random string signing session cookies. **Set it** — `server.js` falls back to a hardcoded development value |
| `CLUB_TIMEZONE` | Optional; default `America/Los_Angeles` — governs the check-in window |
| `NODE_VERSION` | `22` — Netlify ignores `engines`; this is what pins the function runtime |

Never commit real values.

## Local dev

Two supported ways to get a database:

1. **Hosted** — point `DATABASE_URL` at the Supabase instance (or any
   Postgres) in a local `.env`.
2. **Local container** — `docker run --rm -e POSTGRES_PASSWORD=postgres
   -p 5432:5432 postgres:16`, then
   `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` in
   `.env`.

Apply `db/schema.sql` once — the app does not auto-create tables (the schema
self-creates its namespace, so a fresh database works). Then, inside `app/`:

```bash
npm install
npm start
```

http://localhost:3000 redirects to the event calendar; if you are not logged
in it redirects to the login page first. `netlify dev` simulates the Netlify
Functions environment (`npm i -g netlify-cli`).

### Checking in from a phone

The browser geolocation API only works over **HTTPS or on localhost**, so
hitting `http://<your-ip>:3000` from a phone gets no location. Either:

- tunnel it — `ngrok http 3000` (or cloudflared) gives the phone an HTTPS URL, or
- simulate coordinates in DevTools → Sensors (pitch coordinates are in
  `db/schema.sql`).

Phone GPS is typically accurate to 5–20 m, so the 10 m default can be strict
in practice; admins can raise the radius per event in the edit dialog.

## Accounts

`db/schema.sql` seeds event data only — **no users**. Members are created from
the member list page (`/members`) via 批量添加会员, one `username:password` per
line in the dialog:

```
someone@gsffc.org:their-password
```

Split on the first colon (so passwords may contain colons); blank lines and
`#` comments are ignored. An existing account has only its password updated —
name and position are preserved — so this doubles as the password-reset path.

> **First admin on a fresh database**: the page above requires an existing
> login, so bootstrap by hand — INSERT one user with a bcryptjs hash, then
> `UPDATE gsffc.users SET role='ADMIN'`. The production Supabase instance
> already has users, so this only matters for new dev databases.

## Deployment

Netlify, with **base directory `app/`**; the whole Express app is bundled by
[`serverless-http`](https://github.com/dougmoscrop/serverless-http) into one
function, and `public/` is served straight from the CDN. `netlify.toml` holds
the publish/functions directories, the esbuild settings, the `/*` redirect
into the app, and an `ignore` rule so site-only commits don't redeploy the
app. Setup, env vars, and rollback: `docs/runbooks/netlify.md`.

## Directory map (conventions live in each directory's README)

- `db/` — schema, applied manually and idempotent; the app never auto-migrates
- `netlify/functions/` — the single serverless-http function
- `public/` — static assets (CDN); `ui/` and `favicon.png` here are generated
  by `npm run ui:build` at the repo root, never edited
- `views/` — EJS templates; `partials/shared-header.ejs` is likewise generated
- `server.js`, `db.js` — app entrypoint and DB layer

## TODO

- After an event is deleted, stop rewriting the URL with markers like
  `?delete=1`.
