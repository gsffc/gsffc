# Contributing

Thanks for helping with the GSF Football Club website!

## Layout

- `site/` — static site (www.gsffc.org), deployed to GitHub Pages
- `app/` — member app (app.gsffc.org), deployed to Netlify
- `ui/` — shared styles and header used by both

Each half deploys independently; you can work on one without touching the other.

## Rules of thumb

1. **Media**: no GIFs (use WebM ≤ 640 px, ≤ 2 MB); photos as JPG ≤ 1600 px,
   ≤ 400 KB; PNG only for graphics. Conversion helpers live in `scripts/`.
   See `AGENTS.md` for the full policy — it applies to humans too.
2. All media is committed in-repo — there is no external host, so the size
   rules are what keep clones fast. Oversized merges get pruned from history
   (a force-push for everyone), so when in doubt, compress first.
3. Don't commit secrets; document new environment variables in `.env.example`.
4. `app/` is maintained by its original author — coordinate before refactoring.
5. Using AI coding tools is fine — any tool, any model. What matters is that
   the result follows this document.

## Workflow

Open a PR against `main`. CI checks asset policy compliance and builds the
affected half. Migration status and open work: see
[issue #1](https://github.com/gsffc/gsffc/issues/1).
