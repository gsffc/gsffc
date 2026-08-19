# db/

Database schema. Conventions:

- `schema.sql` is the single source of truth, applied manually per
  environment (local Docker/Postgres or the hosted Supabase). It is
  idempotent (`CREATE/ALTER ... IF NOT EXISTS`) — re-apply the whole file
  freely. The app never auto-applies it; the one exception is the session
  table, auto-created by connect-pg-simple at runtime.
- Schema changes: edit `schema.sql` in a PR and re-apply to each
  environment. Watch out: new columns occasionally lack their `ALTER` line
  (check the PR diff) — apply those by hand to existing databases. Note it in
  the PR description so whoever deploys first applies it.
- No credentials or connection strings here — ever. `DATABASE_URL` lives in
  Netlify env vars / local `.env` only (see `../README.md`).
