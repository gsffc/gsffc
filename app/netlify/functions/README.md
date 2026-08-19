# netlify/functions/

The whole Express app is packaged by
[`serverless-http`](https://github.com/dougmoscrop/serverless-http) into a
single Netlify Function here. Conventions:

- Keep it one function. `netlify.toml` (repo `app/` root) routes all
  non-static requests to it; static files in `public/` are served by the CDN
  and never reach the function.
- `netlify.toml`'s `external_node_modules = ["ejs"]` and
  `included_files = ["views/**"]` are load-bearing: esbuild can't trace the
  dynamic `require('ejs')` or the template files. If you add a dependency
  loaded by dynamic require, add it there too.
- Functions are stateless — all state lives in Postgres (sessions included).
- Node 22, pinned by the `NODE_VERSION` env var in Netlify (not
  `package.json` `engines` — Netlify ignores it).
