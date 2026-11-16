/** Vocabulary shared by key masking, value discovery, and textual secret grammars. */
const STRONG_WORDS = ["password", "passwd", "secret", "token", "credential", "bearer", "apikey"] as const;
const WEAK_WORDS = new Set(["key", "keys", "pass"]);
const ENV_ALIASES = new Set(["rediscli_auth"]);
// A structural `key` is usually an identity or file path (cacheKey, certs.key); these qualifiers make it key material.
const KEY_QUALIFIERS = new Set([
  "api",
  "auth",
  "secret",
  "private",
  "access",
  "signing",
  "encryption",
  "master",
]);

// API key admits separators in text grammars and broad field-name masking.
export const SECRET_WORD_SOURCE = STRONG_WORDS.map((word) => (word === "apikey" ? "api[_-]?key" : word)).join(
  "|",
);
export const SIGNED_QUERY_WORD_SOURCE = [SECRET_WORD_SOURCE, "signature", "sig"].join("|");
/** A whole assignment name that contains a secret word. Pair it with the left boundary below. */
export const SECRET_ASSIGNMENT_NAME_SOURCE = `[A-Za-z0-9_.-]*(?:${SECRET_WORD_SOURCE})[A-Za-z0-9_.-]*`;
/** Keeps a query separator out of an assignment name (`?token=` is a query, not an assignment). */
export const SECRET_ASSIGNMENT_LEFT_BOUNDARY_SOURCE = "(?<![?&A-Za-z0-9_.-])";
export const SIGNED_QUERY_PREFIX_SOURCE = String.raw`[?&](?:[\w-]*[-_])?`;
export const SECRET_FIELD_PATTERN = new RegExp(`${SECRET_WORD_SOURCE}|^auth(?:token|orization)?$`, "iu");

// Whole segments only. Guessing suffixes (PGPASSWORD, MYSQL_PWD) collects host defaults such as GitHub's
// Windows-image PGPASSWORD=root, which then masks "root" in every line of output.
const STRONG_SEGMENTS = new Set(
  [...STRONG_WORDS, "authkey", "authtoken"].flatMap((word) => [word, `${word}s`]),
);
const segments = (name: string): readonly string[] =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[._-]+/u)
    .filter((segment) => segment.length > 0);

/** Broad substring matching: a false positive masks only its own structured field. */
export const isSecretFieldName = (name: string): boolean => SECRET_FIELD_PATTERN.test(name);

/** Precise env/label discovery: a strong or weak whole segment, or a whole-name alias. */
export const isSecretEnvName = (name: string): boolean =>
  ENV_ALIASES.has(name.toLowerCase()) ||
  [...name.toLowerCase().split(/[._-]+/u), ...segments(name)].some(
    (segment) => STRONG_SEGMENTS.has(segment) || WEAK_WORDS.has(segment),
  );

/** Structural discovery requires a sensitive last segment; a bare `key` counts only when qualified. */
export const isSecretStructuralName = (name: string): boolean => {
  const parts = segments(name);
  const last = parts.at(-1);
  if (last === undefined) return false;
  if (STRONG_SEGMENTS.has(last)) return true;
  const qualifier = parts.at(-2);
  return (last === "key" || last === "keys") && qualifier !== undefined && KEY_QUALIFIERS.has(qualifier);
};
