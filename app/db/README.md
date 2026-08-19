# db/

Database schema and seeds. Conventions:

- `schema.sql` is the single source of truth — it is **applied manually once
  per environment** (local Docker/Postgres or the hosted Supabase). The app
  never auto-creates or migrates tables at runtime.
- Schema changes: edit `schema.sql` in a PR, then apply the delta by hand to
  each environment. Note the change in the PR description so whoever deploys
  first applies it.
- No credentials or connection strings here — ever. `DATABASE_URL` lives in
  Netlify env vars / local `.env` only (see `../README.md`).
