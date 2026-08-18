// Eleventy config for the GSF static site.
//
// Bilingual scheme: the site is built twice from the same content tree.
// zh (default) writes _site/; LANG=en writes _site/en/ with translated UI
// chrome (posts are Chinese-language in both). Asset passthrough runs in the
// zh pass only, so media is never duplicated.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sass from "sass";
import { engine, LANG } from "./_lib/engine.js";
import { md } from "./_lib/md.js";
import {
  gamesFlat,
  navLists,
  seasonPages,
  seasonsList,
  statsSeasons,
  teamHistory,
  teamsFlat,
} from "./_lib/seasonsView.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default function (eleventyConfig) {
  eleventyConfig.setLibrary("liquid", engine);
  eleventyConfig.setLibrary("md", md);

  eleventyConfig.addGlobalData("lang", LANG);
  eleventyConfig.addGlobalData("pathPrefix", LANG === "en" ? "/en" : "");
  eleventyConfig.addGlobalData("seasonPages", seasonPages);
  eleventyConfig.addGlobalData("teamHistory", teamHistory);
  eleventyConfig.addGlobalData("navLists", navLists);
  // For pagination front matter.
  eleventyConfig.addGlobalData("seasonsList", seasonsList);
  eleventyConfig.addGlobalData("statsSeasons", statsSeasons);
  eleventyConfig.addGlobalData("gamesFlat", gamesFlat);
  eleventyConfig.addGlobalData("teamsFlat", teamsFlat);

  eleventyConfig.addCollection("posts", (api) =>
    api
      .getFilteredByGlob("_posts/*.md")
      .filter((item) => item.data.validPost)
      .sort((a, b) => b.date - a.date),
  );

  eleventyConfig.addCollection("tagPages", (api) => {
    const byTag = new Map();
    for (const item of api
      .getFilteredByGlob("_posts/*.md")
      .filter((item) => item.data.validPost)) {
      for (const tag of item.data.postTags ?? []) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(item);
      }
    }
    return [...byTag.entries()]
      .map(([tag, posts]) => ({
        tag,
        posts: posts.sort((a, b) => b.date - a.date),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  });

  if (LANG === "zh") {
    eleventyConfig.addPassthroughCopy("assets");
    eleventyConfig.addPassthroughCopy("favicon.png");
    eleventyConfig.addPassthroughCopy("CNAME");
  }

  // SCSS: assets/main.scss -> assets/main.css (loadPaths covers _sass/).
  eleventyConfig.addWatchTarget("_sass/");
  eleventyConfig.on("eleventy.before", ({ dir }) => {
    if (LANG !== "zh") return;
    const compiled = sass.compile(path.join(ROOT, "_sass", "main.scss"), {
      loadPaths: [path.join(ROOT, "_sass")],
    });
    fs.mkdirSync(path.join(dir.output, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir.output, "assets", "main.css"), compiled.css);
  });

  return {
    dir: {
      input: ".",
      output: "_site",
      includes: "_includes",
      layouts: "_layouts",
      data: "_data",
    },
    markdownTemplateEngine: "liquid",
    htmlTemplateEngine: "liquid",
  };
}
