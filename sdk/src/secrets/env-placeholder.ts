/**
 * Complete npm-style `${IDENT}` / `${IDENT?}` placeholders.
 *
 * Pattern-layer secret assignment and signed-query classes leave these values
 * alone so remediation and config examples that name an env var are readable.
 * Incomplete, suffixed, quoted, escaped, and malformed forms stay masked.
 * Registered secret values still win in the value layer that runs first.
 */

/** Identifier body shared with npm `${VAR}` / `${VAR?}` expansion. */
export const ENV_PLACEHOLDER_IDENT_SOURCE = "[A-Za-z_][A-Za-z0-9_]*";

/** Complete placeholder only (no suffix, quotes, or escapes). */
export const COMPLETE_ENV_PLACEHOLDER_SOURCE = `\\$\\{${ENV_PLACEHOLDER_IDENT_SOURCE}(?:\\?)?\\}`;

const COMPLETE_ENV_PLACEHOLDER = new RegExp(`^${COMPLETE_ENV_PLACEHOLDER_SOURCE}$`, "u");

/** True when `value` is exactly `${IDENT}` or `${IDENT?}`. */
export const isCompleteEnvPlaceholder = (value: string): boolean => COMPLETE_ENV_PLACEHOLDER.test(value);

/**
 * Unquoted assignment/query value alternatives that prefer a complete or
 * suffixed placeholder form so a trailing `}` is not left outside the match.
 *
 * `stopClassBody` is inserted into `[^...]` and must already be a safe
 * character-class body under the `u` flag (`]` / `}` written as `\\]` / `\\}`).
 */
export const unquotedSecretValueSource = (stopClassBody: string): string =>
  `(?:\\[redacted\\][^${stopClassBody}]*|\\\\*\\$\\{[^}\\r\\n]*\\}[^${stopClassBody}]*|\\\\*\\$\\{[^${stopClassBody}]*|[^${stopClassBody}]+)`;

/** Keep a complete bare placeholder; otherwise emit the redacted form. */
export const keepCompleteEnvPlaceholderOrRedact = (
  match: string,
  redacted: string,
  value: string | undefined,
): string => (value !== undefined && isCompleteEnvPlaceholder(value) ? match : redacted);

/** Safe stop bodies: runtime value begins with \] so unicode-mode classes accept ]. */
export const ASSIGNMENT_STOP_CLASS = "\\]\\s,;\"'}";
export const QUERY_STOP_CLASS = "\\]&\\s\"'}";
export const TRANSCRIPT_SHORT_STOP_CLASS = "\\]\\s\"'`&?=)";
export const TRANSCRIPT_KEY_STOP_CLASS = "\\]\\s\"'`&?}";
