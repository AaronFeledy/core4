/**
 * Detect a secret construct in already-redacted text whose closer has not
 * arrived yet.
 *
 * The assignment and signed-query grammars admit quoted values that may span
 * arbitrary newlines, and the bearer grammar admits whitespace (including
 * newlines) after `Bearer`. A consumer that redacts one framed line at a time
 * therefore leaks such a value one line at a time. This detector runs on the
 * output of the canonical redactor over a held block, not on raw input, so it
 * sees exactly what the ordered pattern stages left: a surviving secret-name
 * `=` (or `?name=` / `&name=`) immediately followed by an opening quote with no
 * closer after it, or `Bearer` followed only by whitespace.
 *
 * Escaped openers (`\"value`) are not held. When the escaped alternative cannot
 * complete, the unquoted alternative masks the leading backslash, so the
 * redacted block reads `=[redacted]"`: the same shape an ordinary value leaves
 * before a closing shell quote (`sh -c "mysql --password=secret"`). Holding on
 * it would mask unrelated output after every such line, and escaped quotes
 * belong to encoded text, where a value's newlines are escapes too.
 *
 * The one deliberate exclusion is an assignment whose name is immediately
 * preceded by the same quote character as its value opener (`"token="`, as in
 * `RUN echo "token=" > f`). That quote almost always closes a shell string
 * opened just before the name, so holding there would hide unrelated output.
 */
import { SECRET_VALUE_QUOTE_CHARS } from "./env-placeholder.ts";
import {
  SECRET_ASSIGNMENT_LEFT_BOUNDARY_SOURCE,
  SECRET_ASSIGNMENT_NAME_SOURCE,
  SIGNED_QUERY_PREFIX_SOURCE,
  SIGNED_QUERY_WORD_SOURCE,
} from "./secret-names.ts";

/** A construct that the canonical secret patterns could still complete. */
export interface OpenSecretConstruct {
  /** Index where the construct begins: its name, query prefix, or `Bearer`. */
  readonly start: number;
  /** Index where its value begins; everything from here on is unproven. */
  readonly valueStart: number;
}

const quoteClassSource = `[${SECRET_VALUE_QUOTE_CHARS.join("")}]`;

const ASSIGNMENT_OPEN_PATTERN = new RegExp(
  `${SECRET_ASSIGNMENT_LEFT_BOUNDARY_SOURCE}(${SECRET_ASSIGNMENT_NAME_SOURCE})=(${quoteClassSource})`,
  "giu",
);

const QUERY_OPEN_PATTERN = new RegExp(
  `(${SIGNED_QUERY_PREFIX_SOURCE}(?:${SIGNED_QUERY_WORD_SOURCE})=)(${quoteClassSource})`,
  "giu",
);

const BEARER_OPEN_PATTERN = /\bBearer\s*/giu;

/**
 * Return the leftmost construct in `text` that the canonical secret patterns
 * could still complete if more text arrived, or `undefined` when nothing is
 * open. `text` MUST already be the redacted held block.
 */
export const findOpenSecretConstruct = (text: string): OpenSecretConstruct | undefined => {
  let found: OpenSecretConstruct | undefined;
  const consider = (candidate: OpenSecretConstruct): void => {
    if (found === undefined || candidate.start < found.start) found = candidate;
  };

  for (const match of text.matchAll(ASSIGNMENT_OPEN_PATTERN)) {
    const quote = match[2] ?? "";
    const nameStart = match.index;
    // `"token="` closes a shell string opened before the name; never hold it.
    if (text[nameStart - 1] === quote) continue;
    const valueStart = match.index + match[0].length - quote.length;
    if (text.indexOf(quote, valueStart + quote.length) !== -1) continue;
    consider({ start: nameStart, valueStart });
  }

  for (const match of text.matchAll(QUERY_OPEN_PATTERN)) {
    const quote = match[2] ?? "";
    const valueStart = match.index + (match[1] ?? "").length;
    if (text.indexOf(quote, valueStart + quote.length) !== -1) continue;
    consider({ start: match.index, valueStart });
  }

  for (const match of text.matchAll(BEARER_OPEN_PATTERN)) {
    const end = match.index + match[0].length;
    if (end !== text.length) continue;
    consider({ start: match.index, valueStart: end });
  }

  return found;
};
