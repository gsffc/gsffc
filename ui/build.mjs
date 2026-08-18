#!/usr/bin/env node
// Generates the committed per-site partials from ui/ sources (#6).
//
//   site/_includes/shared-header.liquid  — header shell + www nav slot
//   site/assets/ui/ui.css                — tokens.css + header.css
//   site/assets/ui/login-corner.js       — verbatim copy
//   site/favicon.png                     — from ui/logo.png
//
//   app/views/partials/shared-header.ejs — header shell + app nav slot
//   app/public/ui/ui.css, login-corner.js, app/public/favicon.png
//   (app targets only once app/ is onboarded — its views/ dir exists, #2)
//
// Each half builds standalone from the committed outputs; this script runs
// only when ui/ changes. CI verifies outputs are fresh (ci.yml ui job).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const write = (p, content) => {
  mkdirSync(dirname(join(ROOT, p)), { recursive: true });
  writeFileSync(join(ROOT, p), content);
  console.log(`wrote ${p}`);
};
const copy = (from, to) => {
  mkdirSync(dirname(join(ROOT, to)), { recursive: true });
  copyFileSync(join(ROOT, from), join(ROOT, to));
  console.log(`copied ${from} -> ${to}`);
};

const shell = read("ui/header.html");
const css = `${read("ui/tokens.css")}\n${read("ui/header.css")}`;
const SLOT = "<!-- @slot:site-nav -->";

function renderHeader({
  slotFile,
  logoUrl,
  assetPrefix,
  brandHref,
  brandName,
}) {
  const slot = read(`ui/slots/${slotFile}`);
  // Replace the source-of-truth comment with a generated-file notice.
  const notice =
    "<!-- GENERATED from ui/header.html — do not edit; run `npm run ui:build` -->";
  const body = shell.replace(/<!-- Shared header shell[\s\S]*?-->/, notice);
  const out = body
    .replaceAll("{{BRAND_HREF}}", brandHref)
    .replaceAll("{{BRAND_NAME}}", brandName)
    .replaceAll("{{LOGO_URL}}", logoUrl)
    .replaceAll("{{UI_ASSET_PREFIX}}", assetPrefix)
    .replace(SLOT, slot.trimEnd());
  const leftover = out.match(/\{\{[A-Z_]+\}\}|@slot:/);
  if (leftover)
    throw new Error(`unsubstituted marker left in header: ${leftover[0]}`);
  return out;
}

// --- site/ (Eleventy, Liquid) ---
write(
  "site/_includes/shared-header.liquid",
  renderHeader({
    slotFile: "www-nav.html",
    logoUrl: "/favicon.png",
    assetPrefix: "/assets/ui",
    // Brand is www-internal: keep it language-aware (zh / vs en /en/).
    brandHref: '{{ "/" | langUrl }}',
    brandName: '{{ meta | ifield: "title" }}',
  }),
);
write("site/assets/ui/ui.css", css);
copy("ui/login-corner.js", "site/assets/ui/login-corner.js");
copy("ui/logo.png", "site/favicon.png");

// --- app/ (Express/EJS) — only once onboarded (#2) ---
if (existsSync(join(ROOT, "app", "views"))) {
  write(
    "app/views/partials/shared-header.ejs",
    renderHeader({
      slotFile: "app-nav.ejs",
      logoUrl: "/favicon.png",
      assetPrefix: "/ui",
      brandHref: "/",
      brandName: "GSF足球俱乐部",
    }),
  );
  write("app/public/ui/ui.css", css);
  copy("ui/login-corner.js", "app/public/ui/login-corner.js");
  copy("ui/logo.png", "app/public/favicon.png");
} else {
  console.log("app/ not onboarded yet (#2) — skipped app partials");
}
