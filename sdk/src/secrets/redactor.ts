/**
 * Secret value redactor — the single source of truth for masking resolved
 * `${secret:…}` values out of renderer / log / event output (spec §7.3.1).
 *
 * This is a pure, dependency-free function: callers (renderers, loggers, event
 * formatters) feed it the set of secret values resolved by the active
 * `SecretStore` and get back a `redact(text)` that replaces every occurrence
 * with the `REDACTED` sentinel. Values are matched literally (no regex
 * interpretation) and longest-first so a shorter secret that is a substring of
 * a longer one cannot leave the remainder of the longer value exposed.
 */

/** Sentinel written in place of a redacted secret value. */
export const REDACTED = "[redacted]" as const;

export interface SecretRedactor {
  /** Replace every occurrence of a known secret value with {@link REDACTED}. */
  readonly redact: (text: string) => string;
}

/**
 * Build a {@link SecretRedactor} from an iterable of secret values. Empty and
 * whitespace-only values are ignored so the redactor never masks the entire
 * string.
 */
export const createSecretRedactor = (values: Iterable<string>): SecretRedactor => {
  const unique = Array.from(new Set(values)).filter((value) => value.trim().length > 0);
  // Longest-first: prevents a substring secret from partially masking a longer
  // secret and leaking its tail.
  unique.sort((a, b) => b.length - a.length);

  if (unique.length === 0) {
    return { redact: (text) => text };
  }

  return {
    redact: (text) => {
      let result = text;
      for (const value of unique) {
        if (result.includes(value)) {
          result = result.split(value).join(REDACTED);
        }
      }
      return result;
    },
  };
};
