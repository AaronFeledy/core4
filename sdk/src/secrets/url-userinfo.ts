/**
 * URL userinfo masking, the one secret class that never carries open state.
 *
 * A credential in a URL's userinfo is a regex-expressible shape: a scheme, a
 * `user:password@` pair, and the rest of the authority. It is matched before
 * the scanner because a masked credential can change what the scanner sees, and
 * the scanner owns every grammar that can leave a value unterminated.
 *
 * The percent-encoded form is matched left-to-right without lazy runs: `%` may
 * only be consumed when it is not the encoded separator, so an input such as
 * `x%3A` repeated with no `%40` cannot make the engine backtrack through every
 * split of the same run. Both schemes start only at a maximal scheme run, so a
 * failing dotted run (`a.a.a…`) is tried once instead of at every word boundary.
 */
import type { BoundedPatternReplacement } from "./bounded-redaction.ts";
import { SENTINEL } from "./secret-lexeme.ts";

// The lookbehind replaces `\b`: a scheme starts at the maximal run of scheme
// characters, so a failing run is not retried at every word boundary inside it.
export const URL_USERINFO_PATTERN =
  /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:\[redacted\]|[^/\s:@])+:(?:\[redacted\]|[^/\s@])+@/gu;

const ENCODED_URL_USERINFO_PATTERN =
  /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*%3A%2F%2F)(?:\[redacted\]|\[(?!redacted\])|[^&\s"'\]}{%]|%(?!3A))*(?:%3A)(?:\[redacted\]|\[(?!redacted\])|[^&\s"'\]}{%]|%(?!40))*(?:%40)/giu;

const ENCODED_URL_MARKER = /%3a%2f%2f/iu;

const keepScheme = (_match: string, scheme: string): string => `${scheme}${SENTINEL}@`;
const keepEncodedScheme = (_match: string, scheme: string): string => `${scheme}${SENTINEL}%40`;

export const URL_USERINFO_REPLACEMENTS: readonly BoundedPatternReplacement[] = [
  { pattern: URL_USERINFO_PATTERN, replace: keepScheme },
  { pattern: ENCODED_URL_USERINFO_PATTERN, replace: keepEncodedScheme },
];

/** Mask every URL userinfo credential in `text`; no open state, no scanner. */
export const redactUrlUserinfo = (text: string): string => {
  let output = text;
  if (output.includes("://")) output = output.replace(URL_USERINFO_PATTERN, keepScheme);
  // Every encoded `@` is `%40`, so its absence rules the whole class out.
  if (output.includes("%40") && ENCODED_URL_MARKER.test(output))
    output = output.replace(ENCODED_URL_USERINFO_PATTERN, keepEncodedScheme);
  return output;
};
