/**
 * Secret value redactor — the single source of truth for masking resolved
 * `${secret:…}` values out of renderer / log / event output.
 *
 * This is a pure, dependency-free function: callers (renderers, loggers, event
 * formatters) feed it the set of secret values resolved by the active
 * `SecretStore` and get back a `redact(text)` that replaces every occurrence
 * with the `REDACTED` sentinel. Values are matched literally (no regex
 * interpretation); overlapping occurrences are masked as a single union so no
 * portion of any occurrence survives.
 */

import { replaceLiteralMatchesBounded, retainWithinBytes } from "./bounded-redaction.ts";
import { redactedInspection } from "./inspection.ts";
import { LiteralMatcher, stringUnits } from "./literal-matcher.ts";

/** Sentinel written in place of a redacted secret value. */
export const REDACTED = "[redacted]" as const;

/**
 * Exact-value tokens that must never enter the value layer. CSI/SGR
 * parameters are short decimal codes (`0`, `32`, `95`) or `n;n` lists
 * (`0;1`, `38;2;255;0;0`); substituting them turns a complete SGR
 * (`ESC[32m`) into `ESC[[redacted]m` and prints a bare `]m`.
 *
 * Real secrets stay usable: long numeric tokens (`12345678`), one-character
 * letters (`a`), and mixed tokens (`plan-secret`). Empty / whitespace-only
 * values are ignored so the redactor never masks the entire string.
 */
export const isUsableExactRedactionValue = (value: string): boolean => {
  const token = value.trim();
  if (token.length === 0) return false;
  if (/^[0-9;]+$/u.test(token) && token.includes(";")) return false;
  if (/^[0-9]+$/u.test(token) && token.length <= 4) return false;
  return true;
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
export const createSecretRedactor = (
  values: Iterable<string>,
  authoritativeValues: Iterable<string> = [],
  wholeTokenValues: Iterable<string> = [],
): SecretRedactor &
  typeof redactedInspection & {
    /** Replay pre-redacted fragments as one lexical stream, preserving fragment order. */
    readonly redactChunks: (chunks: readonly string[]) => readonly string[];
  } => {
  const authoritative = [...authoritativeValues].filter((value) => value.length > 0);
  const unsafe = authoritative.filter((value) => !isUsableExactRedactionValue(value));
  const unique = Array.from(new Set([...values, ...authoritative])).filter(isUsableExactRedactionValue);
  const wholeToken = [...new Set(wholeTokenValues)].filter(isUsableExactRedactionValue);
  const matcher = new LiteralMatcher(unique.map(stringUnits), wholeToken.map(stringUnits));
  const canCrossSentinel = [...unique, ...wholeToken].some((value) => {
    if (value.includes(REDACTED)) return true;
    for (let length = 1; length < Math.min(value.length, REDACTED.length + 1); length += 1) {
      if (value.endsWith(REDACTED.slice(0, length)) || value.startsWith(REDACTED.slice(-length))) {
        return true;
      }
    }
    return false;
  });

  if (matcher.empty && unsafe.length === 0) {
    return {
      ...redactedInspection,
      redact: (text) => text,
      redactBounded: retainWithinBytes,
      redactChunks: (chunks) => chunks,
    };
  }

  // Only sentinel-crossing values can create new occurrences in emitted output.
  const redactWithin = (
    text: string,
    maxBytes: number,
    onPass?: (replacements: readonly (readonly [number, number])[]) => void,
  ): string | undefined => {
    let result = text;
    for (let pass = 0; pass < 8; pass += 1) {
      const replacements: Array<readonly [number, number]> | undefined =
        onPass === undefined ? undefined : [];
      const replaced = replaceLiteralMatchesBounded(result, matcher, {
        replacement: REDACTED,
        maxBytes,
        ...(replacements === undefined
          ? {}
          : { onReplacement: (start: number, end: number) => replacements.push([start, end]) }),
      });
      if (replaced === undefined) return undefined;
      if (replacements !== undefined) onPass?.(replacements);
      if (!canCrossSentinel || replaced === result) return replaced;
      result = replaced;
    }
    onPass?.([[0, result.length]]);
    return retainWithinBytes(REDACTED, maxBytes);
  };
  // Suppress the entire detail rather than corrupt an ANSI sequence with a numeric replacement.
  const containsUnsafe = (text: string): boolean => unsafe.some((value) => text.includes(value));

  return {
    ...redactedInspection,
    redact: (text) =>
      containsUnsafe(text) ? REDACTED : (redactWithin(text, Number.MAX_SAFE_INTEGER) ?? REDACTED),
    redactBounded: (text, maxBytes) => {
      if (containsUnsafe(text)) return retainWithinBytes(REDACTED, maxBytes);
      return redactWithin(text, maxBytes);
    },
    redactChunks: (chunks) => {
      const text = chunks.join("");
      if (containsUnsafe(text)) return chunks.map((_, index) => (index === 0 ? REDACTED : ""));
      let result = chunks;
      redactWithin(text, Number.MAX_SAFE_INTEGER, (replacements) => {
        let offset = 0;
        let replacementIndex = 0;
        result = result.map((chunk) => {
          const start = offset;
          offset += chunk.length;
          let cursor = start;
          const pieces: string[] = [];
          for (let match = replacements[replacementIndex]; match !== undefined && match[0] < offset; ) {
            pieces.push(chunk.slice(cursor - start, Math.max(cursor, match[0]) - start));
            if (match[0] >= start) pieces.push(REDACTED);
            cursor = Math.min(match[1], offset);
            if (match[1] > offset) break;
            replacementIndex++;
            match = replacements[replacementIndex];
          }
          pieces.push(chunk.slice(cursor - start));
          return pieces.join("");
        });
      });
      return result;
    },
  };
};
