// i18n strings, loaded from the ported _i18n/*.yml files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));

export const strings = {
  zh: yaml.load(readFileSync(join(HERE, "..", "_i18n", "zh.yml"), "utf8")),
  en: yaml.load(readFileSync(join(HERE, "..", "_i18n", "en.yml"), "utf8")),
};

// Dot-path lookup ("games.final") with zh fallback. Unknown keys render as
// empty — matching the old Jekyll multiple-languages plugin's behavior.
export function translate(key, lang) {
  if (key == null) return "";
  const lookup = (obj) =>
    String(key)
      .split(".")
      .reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return lookup(strings[lang]) ?? lookup(strings.zh) ?? "";
}
