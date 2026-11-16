/**
 * Complete environment-variable references, in every form Lando documents.
 *
 * Pattern-layer secret assignment and signed-query classes leave a value alone
 * when it is exactly one environment-variable reference, so remediation and
 * config examples that name an env var stay readable. Lando's guides and load
 * errors tell users to write bare `$NAME` or `"$NAME"` for `:host` commands
 * (Bun Shell expands `$NAME` but not `${NAME}`), `$${NAME}` is the Landofile
 * escape for a literal `${NAME}`, and lowered secret bindings read a quoted
 * `"$LANDO_BOUND_SECRET_<hex>"` word that a shell-escaped copy keeps as
 * `\"$LANDO_BOUND_SECRET_<hex>\"`.
 *
 * A value is complete when it is exactly one reference, bare, inside double
 * quotes, or inside double quotes with an EQUAL backslash run on both sides.
 * Completeness also needs a verified terminator: the character after the whole
 * value (after the closing quote for the quoted forms) is end of input or a stop
 * character of that grammar's stop class. A suffix, a single-quoted or
 * escaped-dollar form, unequal backslash runs, and a malformed or truncated body
 * all stay masked; a `$${...}` form that is not a complete reference is masked
 * whole, including its closing brace. Registered secret values still win in the
 * value layer that runs first.
 */

/** Identifier body shared with npm `${VAR}` / `${VAR?}` expansion and bare `$NAME`. */
export const ENV_PLACEHOLDER_IDENT_SOURCE = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * One complete environment-variable reference: `$${IDENT}`, `$${IDENT?}`,
 * `${IDENT}`, `${IDENT?}`, or `$IDENT`. Longest alternatives first so a `$${IDENT}`
 * form never falls back to a shorter match.
 */
export const ENV_REFERENCE_SOURCE = `(?:\\$\\$\\{${ENV_PLACEHOLDER_IDENT_SOURCE}(?:\\?)?\\}|\\$\\{${ENV_PLACEHOLDER_IDENT_SOURCE}(?:\\?)?\\}|\\$${ENV_PLACEHOLDER_IDENT_SOURCE})`;

const COMPLETE_ENV_REFERENCE = new RegExp(
  String.raw`^(?:${ENV_REFERENCE_SOURCE}|(\\*)"${ENV_REFERENCE_SOURCE}\1")$`,
  "u",
);

/**
 * True when `value` is exactly one complete environment-variable reference:
 * bare, double-quoted, or double-quoted with an equal backslash run on both
 * sides.
 */
export const isCompleteEnvReference = (value: string): boolean => COMPLETE_ENV_REFERENCE.test(value);

/** Quote characters that open a plain quoted secret value; such a value may span newlines. */
export const SECRET_VALUE_QUOTE_CHARS = ['"', "'"] as const;

/** Escaped double-quoted value: one or more backslashes on each side of the quotes. */
export const ESCAPED_DOUBLE_QUOTED_SOURCE = String.raw`\\+"[^"]*\\+"`;

export const DOUBLE_QUOTED_SOURCE = '"[^"]*"';

/** Both double-quoted alternatives, shared by every secret-value grammar. */
export const DOUBLE_QUOTED_VALUE_SOURCE = `${ESCAPED_DOUBLE_QUOTED_SOURCE}|${DOUBLE_QUOTED_SOURCE}`;

/**
 * Trailing lookahead for one value's terminator. It captures the single character
 * that follows the value, or leaves the group unset at end of input, and consumes
 * neither: a query value's `&` also introduces the next parameter, so eating it
 * would hide that parameter from the grammar that owns it. The replacer compares
 * the capture with its own grammar's stop class.
 */
export const SECRET_VALUE_TERMINATOR_SOURCE = "(?=([\\s\\S])|$)";

/**
 * Unquoted assignment/query value alternatives that prefer a complete or
 * suffixed reference form so a trailing `}` is never left outside the match.
 * After those, a value the value layer already masked anywhere inside it
 * (`$[redacted]`, `pre[redacted]post`) matches whole: every stop class contains
 * `]`, so the plain alternative would end inside the sentinel and strand its `]`.
 *
 * `stopClassBody` is inserted into `[^...]` and must already be a safe
 * character-class body under the `u` flag (`]` / `}` written as `\\]` / `\\}`).
 */
export const unquotedSecretValueSource = (stopClassBody: string): string =>
  `(?:\\\\*\\$\\$\\{[^}\\r\\n]*\\}[^${stopClassBody}]*|\\\\*\\$\\{[^}\\r\\n]*\\}[^${stopClassBody}]*|\\\\*\\$\\{[^${stopClassBody}]*|(?:[^${stopClassBody}]*\\[redacted\\])+[^${stopClassBody}]*|[^${stopClassBody}]+)`;

/**
 * Build the pattern replacer for one grammar's stop class. A complete
 * environment-variable reference is kept only when the character after it is absent
 * (end of input) or a stop character; every other value is replaced whole, leaving
 * the following character in place.
 */
export const keepCompleteEnvReferenceReplacer = (stopClassBody: string) => {
  const isStop = new RegExp(`^[${stopClassBody}]$`, "u");
  return (match: string, redacted: string, value: string, terminator: string | undefined): string =>
    (terminator === undefined || isStop.test(terminator)) && isCompleteEnvReference(value) ? match : redacted;
};

/** Safe stop bodies: runtime value begins with \] so unicode-mode classes accept ]. */
export const ASSIGNMENT_STOP_CLASS = "\\]\\s,;\"'}";
export const QUERY_STOP_CLASS = "\\]&\\s\"'}";
export const TRANSCRIPT_SHORT_STOP_CLASS = "\\]\\s\"'`&?=)";
export const TRANSCRIPT_KEY_STOP_CLASS = "\\]\\s\"'`&?}";
