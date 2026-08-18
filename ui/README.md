# ui/ — shared header & design tokens

Single source of truth for the visual identity shared by `site/` (www) and
`app/` (GSFFC App). See `docs/runbooks/local-dev.md` ("Shared UI") for usage.

- `header.html` — header shell markup (markers substituted per target)
- `tokens.css`, `header.css` — design tokens + header styles
- `logo.png`, `login-corner.js` — shared assets
- `slots/` — per-site internal nav injected into the shell
- `build.mjs` — generator; run via `npm run ui:build`

Generated outputs are committed to `site/` and `app/` — never edit those
directly; edit here and regenerate. CI enforces freshness.
