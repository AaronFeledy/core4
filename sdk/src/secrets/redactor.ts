/**
 * Secret value redactor — the single source of truth for masking resolved
 * `${secret:…}` values out of renderer / log / event output.
 *
 * This is a pure, dependency-free function: callers (renderers, loggers, event
 * formatters) feed it the set of secret values resolved by the active
 * `SecretStore` and get back a `redact(text)` that replaces every occurrence
 * with the `REDACTED` sentinel. Values are matched literally (no regex
 * interpretation) and longest-first so a shorter secret that is a substring of
 * a longer one cannot leave the remainder of the longer value exposed.
 */

import { replaceLiteralBounded, retainWithinBytes } from "./bounded-redaction.ts";

/** Sentinel written in place of a redacted secret value. */
export const REDACTED = "[redacted]" as const;

/**
 * Exact-value tokens that must never enter the value layer. CSI/SGR
 * parameters are short digits or `n;n` lists; substituting them turns
 * a complete SGR (`ESC[32m`) into `ESC[[redacted]m` and prints a bare `]m`.
 */
export const isUsableExactRedactionValue = (value: string): boolean => {
  const token = value.trim();
  if (token.length < 2) return false;
  return !/^[0-9;]+$/u.test(token);
};

export interface SecretRedactor {
  /** Replace every occurrence of a known secret value with {@link REDACTED}. */
  readonly redact: (text: string) => string;
  readonly redactBounded?: (text: string, maxBytes: number) => string | undefined;
}

/**
 * Build a {@link SecretRedactor} from an iterable of secret values. Empty and
 * whitespace-only values are ignored so the redactor never masks the entire
 * string.
 */
export const createSecretRedactor = (values: Iterable<string>): SecretRedactor => {
  const unique = Array.from(new Set(values)).filter(isUsableExactRedactionValue);
  // Longest-first: prevents a substring secret from partially masking a longer
  // secret and leaking its tail.
  unique.sort((a, b) => b.length - a.length);

  if (unique.length === 0) {
    return {
      redact: (text) => text,
      redactBounded: retainWithinBytes,
    };
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
    redactBounded: (text, maxBytes) => {
      let result: string | undefined = text;
      for (const value of unique) {
        result = replaceLiteralBounded(result, value, REDACTED, maxBytes);
        if (result === undefined) return undefined;
      }
      return result;
    },
  };
};
