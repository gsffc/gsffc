# AGENTS.md — contributor guide (humans and AI agents)

This is the repo's single canonical contributor document. It is written for AI
coding agents (**any tool, any model** — no specific assistant, vendor, or
configuration is required) and is equally the contributor guide for humans.
Read it before making changes.

Scoped contributor docs may exist in subtrees (e.g. `app/AGENTS.md`). They may
only *add* subtree-specific guidance — on any conflict, this file wins.

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
   - PNG only for graphics with transparency/flat color, ≤ 400 KB.
   - ≤ ~10 MB total media per post; beyond that, host externally and link.
   - Convert with `npm run convert:media` (see `docs/runbooks/media.md`) —
     do not hand-roll encoder flags. Verify with `npm run check:assets`.
2. **`app/` is owned by @Dongminator.** He has full latitude there — this rule
   governs everyone else: make only issue-scoped changes to `app/`, and
   coordinate with the owner before anything beyond that. Same courtesy in
   reverse for `site/` (@aenon).
3. Secrets stay out of git (`.env` is ignored; document new variables in
   `.env.example`).
4. Site UI text is primarily Chinese; code comments and docs are English.

## Standardized behaviors (whoever or whatever writes the code)

1. **Commit identity**: real name + real email in `git config user.name` /
   `user.email` (set per-clone, matching your GitHub account). Never commit as a
   bot or placeholder identity. AI assistance may be credited with a
   `Co-Authored-By:` trailer; the human stays the author.
2. **No direct pushes to `main`.** Work on a branch, open a PR, reference its
   issue (`Refs #N`). No force-pushes, no history rewrites — the sole exception
   is maintainer-only media pruning documented above. (Enforced by branch
   protection on `main` since cutover (#7): the `biome` and `assets` checks
   must pass before merge.)
3. **CI must pass** (Biome + asset policy) before merge.
4. **Squash-merge always.** Every PR lands as one commit on `main` (enforced in
   repo settings — merge commits and rebase merges are disabled). Write the PR
   title as the commit message you want to see on `main`.
5. **Docs travel with behavior**: if your change alters a command, env var, or
   convention, update AGENTS.md/README in the same PR.

## Tooling

- **All dev commands go through the root `package.json` npm scripts**
  (`npm run dev:site`, `lint`, `format`, `check:assets`, ...). That file is the
  single place commands are defined — CI calls the same scripts. No Makefile or
  parallel interface.

- **`app/` exception**: the app keeps its own `package.json` scripts
  (`npm start`, ...) and is excluded from root Biome until @Dongminator opts
  in (one `biome check --write` pass or stays excluded — his call, #2).

- **JavaScript is linted and formatted with [Biome](https://biomejs.dev/)**
  (root `biome.json`). Run `npm run format` before pushing; CI fails on
  violations. HTML templates (Liquid/EJS) and Markdown are excluded from
  Biome — format those by hand, matching surrounding style.

## Where documentation lives

- **AGENTS.md (this file)** — durable rules and policies only. If it's not
  expected to be true a year from now, it doesn't belong here.
- **`docs/runbooks/`** — operational how-tos, one file per procedure: local dev
  setup, Netlify setup, deployments, routing/redirect updates, media
  conversion. Update the runbook in the same PR that changes the procedure.
- **Issues** — development specs and in-flight decisions. Transient by nature;
  closed when done. Only promote to markdown when a decision becomes durable
  policy (here) or a repeatable procedure (runbook). Labels: `type:epic` /
  `type:task` (one-off) / `type:spec` (implementable design), `area:site` /
  `area:app` / `area:both` / `area:meta`, and `status:future` for parking-lot
  items.

## Conventions

- Keep the two halves independently deployable: site work must not require
  Netlify, app work must not require the Pages build.
- Preserve existing post URLs on the static site.
- Update docs when you change behavior contributors rely on.
