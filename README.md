# gsffc

Monorepo for GSF Football Club's web properties.

| Directory | What | Deployed to | URL |
|---|---|---|---|
| `site/` | Static site (Eleventy) | GitHub Pages | https://www.gsffc.org |
| `app/` | Member app (Express + PostgreSQL, serverless) | Netlify | https://app.gsffc.org |
| `ui/` | Shared CSS / header consumed by both | — | — |

The two halves deploy **independently**: site changes trigger the Pages workflow
(path-filtered to `site/`), app changes deploy via Netlify with base directory
`app/`. There is no shared runtime code between them.

## Status

🚧 Migration in progress — see the
[migration epic](https://github.com/gsffc/gsffc/issues/1) for the plan and
sequencing. This repo supersedes:

- `gsffc/gsffc.github.io` (Jekyll static site; retired after cutover, kept for history)
- Donglin Pu's `netlify-test` (member app; onboarded via #2)

## Contributing

See `AGENTS.md` — the single canonical contributor doc, written for humans
and AI coding agents alike (any tool, any model). Media assets must follow the
[asset policy](https://github.com/gsffc/gsffc.github.io/blob/asset-conversion/docs/asset-conversion-spec.md#enforcement-policy-for-future-contributions-human-or-ai-agent).
