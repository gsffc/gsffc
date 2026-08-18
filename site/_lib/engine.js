// Shared Liquid engine (liquidjs) with Jekyll-compat shims:
//  - {% include name.html k=v %}  (Jekyll include syntax used by 249 post
//    includes; resolves to _includes/<name>.liquid, shares the caller scope)
//  - {% translate key %} / {% t key %}  (multiple-languages-plugin syntax;
//    keys may be literals or {{ expr }} interpolations)
// Filters: t, dname, ifield, langUrl, asset, assetImg, encodeUri, findGame.
// Globals: lang, site (minimal Jekyll shape: site.lang, site.languages,
// site.data.seasons — used by one legacy post body).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Liquid } from "liquidjs";
import { translate } from "./i18n.js";
import { findGame, seasonsJekyll } from "./seasonsView.js";

export const LANG = process.env.LANG === "en" ? "en" : "zh";
export const PREFIX = LANG === "en" ? "/en" : "";

const HERE = dirname(fileURLToPath(import.meta.url));
const INCLUDES = join(HERE, "..", "_includes");

export const engine = new Liquid({
  root: INCLUDES,
  extname: ".liquid",
  timezoneOffset: 0,
  globals: {
    lang: LANG,
    site: {
      lang: LANG,
      languages: ["zh", "en"],
      data: { seasons: seasonsJekyll },
    },
  },
});

// ---------------------------------------------------------------- tags ---

engine.registerTag("include", {
  parse(token) {
    const m = /^["']?([\w./-]+)["']?[\s,]*([\s\S]*)$/.exec(token.args.trim());
    this.name = m[1].replace(/\.(html|md|liquid)$/, "");
    this.assigns = [];
    // Accept both Jekyll (k=v) and liquidjs (k: v) argument styles.
    const re = /(\w+)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,]+)/g;
    for (const mm of m[2]?.matchAll(re) ?? [])
      this.assigns.push([mm[1], mm[2]]);
  },
  async render(context) {
    const scope = { ...context.getAll() };
    for (const [key, raw] of this.assigns) {
      scope[key] =
        raw.startsWith('"') || raw.startsWith("'")
          ? raw.slice(1, -1)
          : await this.liquid.evalValue(raw, context);
    }
    const src = readFileSync(join(INCLUDES, `${this.name}.liquid`), "utf8");
    return this.liquid.parseAndRender(src, scope);
  },
});

function makeTranslateTag() {
  return {
    parse(token) {
      let expr = token.args.trim();
      if (/^\{\{[\s\S]*\}\}$/.test(expr)) expr = expr.slice(2, -2).trim();
      this.expr = expr;
    },
    async render(context) {
      const value = await this.liquid.evalValue(this.expr, context);
      // Bare identifiers are literal i18n keys (Jekyll translate semantics),
      // not variable lookups.
      const key = value ?? this.expr;
      return translate(key, LANG);
    },
  };
}
engine.registerTag("t", makeTranslateTag());
engine.registerTag("translate", makeTranslateTag());

// ------------------------------------------------------------ filters ---

engine.registerFilter("t", (key) => translate(key, LANG));

// i18n_display_name include as a filter.
engine.registerFilter(
  "dname",
  (entity) =>
    entity?.[`display_name_${LANG}`] ??
    entity?.display_name ??
    (typeof entity === "string" ? entity : ""),
);

// i18n_field include as a filter: {{ meta | ifield: "title" }}.
engine.registerFilter(
  "ifield",
  (entity, field) => entity?.[`${field}_${LANG}`] ?? entity?.[field] ?? "",
);

// Page links get the /en prefix in the en pass; assets never do.
engine.registerFilter("langUrl", (path) => `${PREFIX}${path}`);
engine.registerFilter("asset", (path) =>
  String(path).startsWith("/") ? path : `/${path}`,
);
engine.registerFilter("assetImg", (path) => `/assets/img/${path}`);

engine.registerFilter("encodeUri", (s) => encodeURIComponent(s));

// jekyll/tagging pretty permalinks: downcase, non-alphanumeric runs -> "-",
// then percent-encode (Chinese characters survive both steps).
engine.registerFilter("tagSlug", (s) =>
  encodeURIComponent(
    String(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._~!$&'()+,;=:@-]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  ),
);

engine.registerFilter("findGame", (gameKey, seasonKey) =>
  findGame(gameKey, seasonKey),
);
