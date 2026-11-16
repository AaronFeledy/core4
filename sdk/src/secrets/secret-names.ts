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
/** Keeps a query separator out of an assignment name (`?token=` is a query, not an assignment). */
export const SECRET_ASSIGNMENT_LEFT_BOUNDARY_SOURCE = "(?<![?&A-Za-z0-9_.-])";
/**
 * Names that are secret only as a whole name: `auth`, `authorization`, and
 * `authtoken`. As a substring `auth` would also match `oauth`, which is not a
 * credential, so the recognizer and every name grammar share this source and
 * accept it only as the complete name.
 */
const SECRET_WHOLE_NAME_SOURCE = "auth(?:token|orization)?";

export const SECRET_FIELD_PATTERN = new RegExp(
  `(?:${SECRET_WORD_SOURCE})|^(?:${SECRET_WHOLE_NAME_SOURCE})$`,
  "iu",
);

/** Every character an assignment name may contain. */
const NAME_CHAR_SOURCE = "A-Za-z0-9_.-";

/**
 * A whole assignment name that contains a secret word, consumed as one maximal
 * run. Pair it with the left boundary above.
 *
 * The membership test is a zero-width lookahead and the name is then consumed
 * once, so a long run of repeated secret words (`tokentokentoken…`) cannot
 * backtrack through suffixes: only the run's start is a candidate after the
 * left boundary, and each attempt costs at most one scan.
 */
export const SECRET_ASSIGNMENT_NAME_SOURCE = `(?=[${NAME_CHAR_SOURCE}]*(?:${SECRET_WORD_SOURCE})|${SECRET_WHOLE_NAME_SOURCE}(?![${NAME_CHAR_SOURCE}]))[${NAME_CHAR_SOURCE}]+`;

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

/**
 * A signed-query key: the broad field vocabulary plus the signature words,
 * which the field recognizer deliberately leaves out. The signature words count
 * as a whole segment, so `?sig=` and `?X-Amz-Signature=` mask while `?design=`
 * stays readable.
 */
export const isSignedQueryName = (name: string): boolean =>
  isSecretFieldName(name) || segments(name).some((segment) => segment === "sig" || segment === "signature");

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
