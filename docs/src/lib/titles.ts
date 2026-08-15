const DESCRIPTION_LIMIT = 160;
// Shortest prefix worth keeping before a word-boundary trim degrades into a hard cut.
const DESCRIPTION_WORD_BOUNDARY_MIN = 120;
const FRONTMATTER = /^---[\t ]*\r?\n[\s\S]*?\r?\n---[\t ]*(?:\r?\n|$)/;
const HIDDEN_BLOCK = /<Hidden\b[^>]*>[\s\S]*?<\/Hidden\s*>/gi;
const FENCED_CODE_BLOCK = /^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm;
const HEADING = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/m;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+.*$/gm;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const MDX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;

const ACRONYMS: Readonly<Record<string, string>> = {
  api: "API",
  ci: "CI",
  cli: "CLI",
  css: "CSS",
  html: "HTML",
  http: "HTTP",
  https: "HTTPS",
  json: "JSON",
  mdx: "MDX",
  php: "PHP",
  sdk: "SDK",
  sql: "SQL",
  ssh: "SSH",
  tls: "TLS",
  url: "URL",
  yaml: "YAML",
};

const visibleSource = (source: string): string => source.replace(FRONTMATTER, "").replace(HIDDEN_BLOCK, "");

const plainText = (source: string): string =>
  source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/[~*_]/g, "")
    .replace(/\\([\\`*{}[\]()#+\-.!_>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const humanize = (value: string): string => {
  const segment = value
    .split("/")
    .filter((part) => part.length > 0)
    .at(-1);
  const words = (segment ?? value)
    .split(/[-_\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
  if (words.length === 0) return "Untitled";

  return words
    .map((word, index) => {
      const acronym = ACRONYMS[word];
      if (acronym !== undefined) return acronym;
      return index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
    })
    .join(" ");
};

const truncateDescription = (description: string): string => {
  if (description.length <= DESCRIPTION_LIMIT) return description;

  const candidate = description.slice(0, DESCRIPTION_LIMIT - 1).trimEnd();
  const wordBoundary = candidate.lastIndexOf(" ");
  const text = wordBoundary >= DESCRIPTION_WORD_BOUNDARY_MIN ? candidate.slice(0, wordBoundary) : candidate;
  return `${text.trimEnd()}…`;
};

/** Non-empty trimmed string only. Non-strings stay undefined so callers can leave them for schema rejection. */
export const authoredText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const deriveTitle = (
  source: string,
  frontmatter: Readonly<Record<string, unknown>>,
  slug: string,
): string => {
  const authoredTitle = authoredText(frontmatter.title);
  if (authoredTitle !== undefined) {
    return authoredTitle;
  }

  const heading = HEADING.exec(visibleSource(source))?.[1];
  if (heading !== undefined) {
    const title = plainText(heading);
    if (title.length > 0) return title;
  }

  const id = frontmatter.id;
  return humanize(typeof id === "string" && id.trim().length > 0 ? id : slug);
};

export const deriveDescription = (source: string): string | undefined => {
  const prose = visibleSource(source)
    .replace(FENCED_CODE_BLOCK, "")
    .replace(HTML_COMMENT, "")
    .replace(MDX_COMMENT, "")
    .replace(ANY_HEADING, "")
    .replace(/^\s*(?:import|export)\s+.*$/gm, "");

  for (const block of prose.split(/\r?\n[\t ]*\r?\n/)) {
    const paragraph = plainText(block.replace(/\r?\n/g, " "));
    if (paragraph.length > 0) return truncateDescription(paragraph);
  }

  return undefined;
};

/**
 * Loader-boundary metadata fill for Starlight docs.
 * Blank strings are treated as absent (derive or omit). Non-string title/description
 * values are preserved so docsSchema can reject them.
 *
 * Always sets `title` (derived or preserved raw). Callers must not treat title as optional.
 */
export type NormalizedContentMetadata<TData extends Record<string, unknown>> = TData & {
  readonly title: unknown;
};

export const normalizeContentMetadata = <TData extends Record<string, unknown>>(
  data: TData,
  source: string,
  id: string,
): NormalizedContentMetadata<TData> => {
  // Rebuild without original title/description so blank keys cannot leak through spreads.
  const rawTitle = data.title;
  const rawDescription = data.description;
  const next = { ...data };
  Reflect.deleteProperty(next, "title");
  Reflect.deleteProperty(next, "description");

  const title: unknown =
    rawTitle === undefined || typeof rawTitle === "string"
      ? (authoredText(rawTitle) ?? deriveTitle(source, data, id))
      : rawTitle;

  if (rawDescription === undefined || typeof rawDescription === "string") {
    const authoredDescription = authoredText(rawDescription);
    const resolved = authoredDescription === undefined ? deriveDescription(source) : authoredDescription;
    if (resolved !== undefined) {
      Reflect.set(next, "description", resolved);
    }
  } else {
    Reflect.set(next, "description", rawDescription);
  }

  return { ...next, title };
};
