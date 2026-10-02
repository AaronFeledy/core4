/**
 * Lando 3 app-name slugging.
 *
 * Lando 3 runs `slugify(name, {lower: true, strict: true})` with no locale.
 * The charmap is the one from slugify 1.6.6, vendored so this package does not
 * grow a dependency. Strict mode keeps letters, digits, and the hyphen that
 * replaced whitespace: `café` stays `cafe`, and the corpus name
 * `ландоьслуггы | Lando-Sluggy` stays `landosluggy-or-lando-sluggy`.
 */
import charMap from "./slug-charmap.json" with { type: "json" };

const REPLACEMENT = "-";
// Same character class slugify applies while it walks the string. `\w` stays
// ASCII, matching that library's non-unicode regular expression.
const DISALLOWED = /[^\w\s$*_+~.()'"!\-:@]+/g;
const NON_STRICT = /[^A-Za-z0-9\s]/g;
const SLUG_CHAR_MAP: ReadonlyMap<string, string> = new Map(Object.entries(charMap));

const slugChar = (ch: string): string => SLUG_CHAR_MAP.get(ch) ?? ch;

export const slugifyAppName = (name: string): string => {
  let slug = "";
  for (const ch of name.normalize().split("")) {
    const append = slugChar(ch);
    slug += append === REPLACEMENT ? " " : append;
  }
  return slug
    .replace(DISALLOWED, "")
    .replace(NON_STRICT, "")
    .trim()
    .replace(/\s+/g, REPLACEMENT)
    .toLowerCase();
};

export const lando3ProjectName = (name: string): string =>
  slugifyAppName(name)
    .toLowerCase()
    .replace(/_|-|\.+/g, "");
