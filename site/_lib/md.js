// Shared markdown-it instance (config + excerpt rendering in 11tydata).
// markdown-it-attrs covers the kramdown {:.class} attribute syntax used by
// posts; html: true passes through the <video>/<figure> markup in posts.
import markdownIt from "markdown-it";
import markdownItAttrs from "markdown-it-attrs";

export const md = markdownIt({ html: true }).use(markdownItAttrs);
