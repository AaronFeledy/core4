/**
 * Lando 3 app-name slugging.
 *
 * Lando 3 runs the authored `name` through `slugify(name, {lower: true,
 * strict: true})` before anything else sees it, so a converted app keeps the
 * identity its author already knows. Strict mode drops every character that is
 * not a letter, digit, or separator, which is why accents are folded rather
 * than deleted: `café` stays `cafe` instead of collapsing to `caf`.
 */

const COMBINING_MARKS = /\p{M}/gu;
const SEPARATORS = /[\s_]+/g;
const NON_SLUG = /[^a-zA-Z0-9-]+/g;
const DASH_RUN = /-{2,}/g;
const EDGE_DASH = /^-+|-+$/g;

export const slugifyAppName = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(SEPARATORS, "-")
    .replace(NON_SLUG, "")
    .replace(DASH_RUN, "-")
    .replace(EDGE_DASH, "")
    .toLowerCase();
