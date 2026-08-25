# Onboarding a codebase into the monorepo

The drop-day pattern, learned from #3 (site) and #2/#28 (app). Use it if
another property ever joins the repo.

1. **Verbatim snapshot, no git history.** One commit (or a PR) with the tree
   as-is. Refactors land as follow-ups, never mixed into the import.
2. **Name the source in the PR body**: source repo + exact SHA, so reviewers
   know what they're diffing against (the PR template prompts for this).
3. **Run `npm run ui:build`** after the drop and commit the generated outputs
   in the same PR — the ui-freshness CI job fails otherwise.
4. **README merge strategy**: the placeholder `README.md` in the target
   directory is replaced by the imported one — but first check it for rows the
   placeholder documented that the import would lose (env vars, version pins).
   The directory-guide READMEs (`app/*/README.md`) stay alongside.
5. **Docs travel with behavior**: update the affected runbooks in the same PR
   (`netlify.md` for deploy wiring, `local-dev.md` for dev commands).
6. **Post-drop**: verify CI (root lint/assets/ui-freshness + the area's own
   workflow), the first real deploy, and a live smoke test before closing the
   import issue. File known caveats as follow-up issues instead of fixing them
   in the import.
