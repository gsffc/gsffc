# views/

EJS templates. Conventions:

- UI text is primarily Chinese; code and comments in English (AGENTS.md hard
  rule 4).
- `partials/shared-header.ejs` is **generated** from `ui/header.html` by
  `npm run ui:build` at the repo root — never edit it here. It replaces the
  app's own navbar as part of #10; the app-internal nav slot lives in
  `ui/slots/app-nav.ejs`.
- Templates are excluded from Biome (it doesn't handle EJS) — format by hand,
  matching surrounding style.
