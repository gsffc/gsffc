// Per-post defaults and computed data (Jekyll parity):
// - permalink: /:categories/:year/:month/:day/:title.html (Jekyll default)
// - postTags: Jekyll splits a space-separated tags string
// - excerptHtml: content before <!--more-->, Liquid-rendered then markdown
import { engine } from "../_lib/engine.js";
import { md } from "../_lib/md.js";

const pad = (n) => String(n).padStart(2, "0");

export default {
  layout: "post",
  eleventyComputed: {
    // Jekyll skips _posts files without a YYYY-MM-DD filename prefix
    // (e.g. the duplicate draft 2023-11-u-vs-op.md); match that.
    validPost: (data) =>
      /^\d{4}-\d{2}-\d{2}-/.test(data.page.inputPath.split("/").pop()),
    // Jekyll splits a space-separated tags string; Eleventy may hand us one
    // combined array element instead — flatten either shape.
    postTags: (data) => {
      const t = data.tags ?? [];
      return (Array.isArray(t) ? t : [t])
        .flatMap((x) => String(x).split(/\s+/))
        .filter(Boolean);
    },
    permalink: (data) => {
      if (data.validPost === false) return false;
      if (data.permalink) return data.permalink;
      const d = data.page.date;
      const cats = data.categories
        ? Array.isArray(data.categories)
          ? data.categories
          : String(data.categories).split(/\s+/).filter(Boolean)
        : [];
      const prefix = cats.length ? `/${cats.join("/")}` : "";
      return `${prefix}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${data.page.fileSlug}.html`;
    },
    excerptHtml: async (data) => {
      const body = (data.page.rawInput ?? "").replace(/^---[\s\S]*?---\s*/, "");
      const cut = body.split("<!--more-->")[0].trim();
      if (!cut) return "";
      const liquidRendered = await engine.parseAndRender(cut, { ...data });
      return md.render(liquidRendered);
    },
  },
};
