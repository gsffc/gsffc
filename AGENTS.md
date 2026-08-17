# AGENTS.md — guidance for AI coding agents

This repo welcomes AI-assisted contributions with **any tool and any model**.
No specific assistant, vendor, or configuration is required. Everything below is
plain repo documentation — read it before making changes.

## What this repo is

Monorepo for GSF Football Club: `site/` (Eleventy static site → GitHub Pages →
www.gsffc.org), `app/` (Express serverless app → Netlify → app.gsffc.org),
`ui/` (shared styles/header). The two halves deploy independently and share no
runtime code.

## Hard rules

1. **Media asset policy** (violations fail CI):
   - No GIFs. Motion content is WebM (VP9), max width 640 px, ≤ 2 MB per clip.
   - Photos are JPG, max dimension 1600 px, quality ≈ 82, metadata stripped,
     ≤ 400 KB each.
   - PNG only for graphics with transparency/flat color.
   - ≤ ~10 MB total media per post; beyond that, host externally and link.
   - Convert with `scripts/` helpers — do not hand-roll encoder flags.
2. **Do not refactor `app/`** unless the issue explicitly asks for it — it is
   maintained by its original author.
3. Secrets stay out of git (`.env` is ignored; document new variables in
   `.env.example`).
4. Site UI text is primarily Chinese; code comments and docs are English.

## Tooling

- **JavaScript is linted and formatted with [Biome](https://biomejs.dev/)**
  (root `biome.json`). Run `npx biome check --write` before pushing; CI fails
  on violations. Biome does not lint Liquid/EJS/Markdown — format those
  templates by hand, matching surrounding style.

## Conventions

- Keep the two halves independently deployable: site work must not require
  Netlify, app work must not require the Pages build.
- Preserve existing post URLs on the static site.
- Update docs when you change behavior contributors rely on.
