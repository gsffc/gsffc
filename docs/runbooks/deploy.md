# Deploy runbook

How each half deploys, and how to roll back.

## site/ → GitHub Pages → www.gsffc.org

- **Trigger**: push to `main` touching `site/**` (path-filtered), or manual
  `workflow_dispatch` (Actions → "Build and deploy static site").
- **Pipeline**: `.github/workflows/site-pages.yml` — `npm ci && npm run build`
  in `site/` (two passes: zh at `/`, en at `/en/`), artifact → Pages.
- **Pages settings**: Source = GitHub Actions; custom domain `www.gsffc.org`.
  The domain is verified at the org level (Settings → Pages → verified
  domains; TXT `_github-pages-challenge-gsffc` at the DNS provider must stay).
- **Rollback**: revert the offending commit on `main` (a revert PR redeploys
  in ~2 min), or re-run the last good Pages workflow run (Actions → run →
  Re-run jobs). For a full stop, remove the custom domain in Pages settings.
- **Deploy job gating**: the deploy job is skipped while the repo is private
  (GitHub Free has no Pages on private repos; see #17). Public repo = deploys
  just happen.

## app/ → Netlify → app.gsffc.org

See `netlify.md`. Netlify deploys independently on pushes touching `app/**`;
its rollback is Netlify's "Publish previous deploy". **Rollback of one half
never affects the other.**

## Redirect repo (gsffc/gsffc.github.io)

Serves the org hostname `gsffc.github.io` and redirects everything (root via
`index.html`, deep links via the Pages custom `404.html`) to the same path on
`www.gsffc.org`. It's one commit of static HTML; Pages serves it from `main`.
Update by editing those two files.
