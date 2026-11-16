/**
 * Character-level readers for the secret scanner.
 *
 * The scanner replaces the regex secret grammars, so every value shape the
 * grammars accepted lives here as an explicit reader: a quoted value in each
 * accepted quoting (plain double quote with backslash escapes, an escaped
 * opener that closes at the next quote, single quote), a quoted shell word with
 * its non-stop suffix, an unquoted value with complete environment/secret
 * reference forms and `[redacted]` sentinels as opaque units, and a YAML plain
 * scalar. Each reader returns the end offset it consumed and says whether a
 * quote opener was left unterminated, which is the only open state the scanner
 * reports.
 *
 * Every reader advances forward over each character at most once, so a scan is
 * linear by construction and an adversarial run cannot backtrack.
 */

import { REDACTED as SENTINEL } from "./redactor.ts";

export { SENTINEL };

const QUOTE_DOUBLE = 34;
const QUOTE_SINGLE = 39;
const BACKSLASH = 92;
const DOLLAR = 36;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const CLOSE_BRACKET = 93;
const AMPERSAND = 38;
const COMMA = 44;
const SEMICOLON = 59;
const CLOSE_PAREN = 41;
const BACKTICK = 96;
const SPACE = 32;
const TAB = 9;

/** `[A-Za-z0-9_.-]`, the characters a secret name run may contain. */
export const isNameCode = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95 ||
  code === 46 ||
  code === 45;

export const nameRunEnd = (text: string, at: number): number => {
  let end = at;
  while (end < text.length && isNameCode(text.charCodeAt(end))) end += 1;
  return end;
};

export const isBlank = (code: number): boolean => code === SPACE || code === TAB;

/** `[A-Za-z0-9_]`, the word characters `\b` uses. */
export const isWordCode = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** The ECMAScript `\s` set, spelled out so a reader never compiles a regex per character. */
export const isSpaceCode = (code: number): boolean =>
  code === SPACE ||
  (code >= 9 && code <= 13) ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/** A stop class: the characters a value of one grammar may not contain. */
export type StopCode = (code: number) => boolean;

/** `]`, whitespace, `,`, `;`, `"`, `'`, `}` — the `=` assignment stop class. */
export const isAssignmentStop: StopCode = (code) =>
  isSpaceCode(code) ||
  code === CLOSE_BRACKET ||
  code === COMMA ||
  code === SEMICOLON ||
  code === QUOTE_DOUBLE ||
  code === QUOTE_SINGLE ||
  code === CLOSE_BRACE;

/** `]`, `&`, whitespace, `"`, `'`, `}` — the signed-query stop class. */
export const isQueryStop: StopCode = (code) =>
  isSpaceCode(code) ||
  code === CLOSE_BRACKET ||
  code === AMPERSAND ||
  code === QUOTE_DOUBLE ||
  code === QUOTE_SINGLE ||
  code === CLOSE_BRACE;

/** `]`, whitespace, `,`, `;`, `}`, `"`, `'`, `)`, backtick — the quoted-key member stop class. */
export const isMemberStop: StopCode = (code) =>
  isSpaceCode(code) ||
  code === CLOSE_BRACKET ||
  code === COMMA ||
  code === SEMICOLON ||
  code === CLOSE_BRACE ||
  code === QUOTE_DOUBLE ||
  code === QUOTE_SINGLE ||
  code === CLOSE_PAREN ||
  code === BACKTICK;

export interface ClosedValue {
  /** Offset just past the closing quote. */
  readonly end: number;
}

/** A quoted value read: closed, open (its closer never arrives), or not a quote. */
type QuoteRead = ClosedValue | { readonly open: true } | undefined;

export const isQuoteCode = (code: number): boolean => code === QUOTE_DOUBLE || code === QUOTE_SINGLE;

/**
 * Read one quoted value at `at`, allowing a backslash run as an escaped opener.
 * A plain double-quoted value honors backslash escapes; an escaped opener and
 * every single-quoted value close at the next quote of their kind.
 */
export const readQuoted = (text: string, at: number): QuoteRead => {
  const quoteAt = at + countBackslashes(text, at);
  const quote = text.charCodeAt(quoteAt);
  if (!isQuoteCode(quote)) return undefined;
  const contentStart = quoteAt + 1;
  if (quote === QUOTE_DOUBLE && quoteAt === at) {
    for (let index = contentStart; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === BACKSLASH) {
        index += 1;
        continue;
      }
      if (code === QUOTE_DOUBLE) return { end: index + 1 };
    }
    return { open: true };
  }
  const closer = text.indexOf(quote === QUOTE_DOUBLE ? '"' : "'", contentStart);
  return closer === -1 ? { open: true } : { end: closer + 1 };
};

const referenceBodyEnd = (text: string, from: number): number => {
  for (let index = from; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === CLOSE_BRACE) return index;
    if (code === 13 || code === 10) return -1;
  }
  return -1;
};

export const plainValueEnd = (text: string, at: number, isStop: StopCode): number => {
  let end = at;
  while (end < text.length) {
    if (!isStop(text.charCodeAt(end))) {
      end += 1;
      continue;
    }
    // A complete sentinel is one opaque value character: the grammar never ends
    // a value inside it, so a masked value stays whole.
    if (text.charCodeAt(end) === CLOSE_BRACKET && text.startsWith(SENTINEL, end - (SENTINEL.length - 1))) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
};

/**
 * Read a quoted shell word: the quoted value plus every character the grammar
 * does not stop on (`password="x"suffix` is one word). An unterminated opener
 * propagates as open.
 */
export const readQuotedWord = (text: string, at: number, isStop: StopCode): QuoteRead => {
  const quoted = readQuoted(text, at);
  if (quoted === undefined || "open" in quoted) return quoted;
  // A masked value inside the suffix is one opaque unit, exactly as in the
  // unquoted reader, so `password="a"left[redacted]right` stays one shell word.
  return { end: plainValueEnd(text, quoted.end, isStop) };
};

/**
 * Read one unquoted value at `at`. A quote opener (with or without a backslash
 * run) is never an unquoted value, so an unterminated quoted value is reported
 * by the quoted reader instead of being partly masked. The environment and
 * secret reference forms are consumed with their whole body and trailing
 * non-stop characters so a closing brace is never stranded outside the match.
 */
export const readUnquoted = (text: string, at: number, isStop: StopCode): ClosedValue | undefined => {
  const referenceAt = at + countBackslashes(text, at);
  const code = text.charCodeAt(referenceAt);
  if (isQuoteCode(code)) return undefined;
  if (code === DOLLAR) {
    const doubled = text.charCodeAt(referenceAt + 1) === DOLLAR;
    const braceAt = doubled ? referenceAt + 2 : referenceAt + 1;
    if (text.charCodeAt(braceAt) === OPEN_BRACE) {
      const bodyEnd = referenceBodyEnd(text, braceAt + 1);
      if (bodyEnd !== -1) {
        let end = bodyEnd + 1;
        while (end < text.length && !isStop(text.charCodeAt(end))) end += 1;
        return { end };
      }
      if (!doubled) {
        let end = braceAt + 1;
        while (end < text.length && !isStop(text.charCodeAt(end))) end += 1;
        return { end };
      }
    }
  }
  const end = plainValueEnd(text, at, isStop);
  return end > at ? { end } : undefined;
};

/**
 * Read a YAML plain scalar: the rest of the line with trailing blanks removed.
 * It cannot start with a blank or a (possibly escaped) quote opener, because
 * the separator's blank run already belongs to the key.
 */
export const readYamlScalar = (text: string, at: number): ClosedValue | undefined => {
  const first = text.charCodeAt(at);
  if (Number.isNaN(first) || first === SPACE || first === TAB) return undefined;
  const quoteAt = at + countBackslashes(text, at);
  if (isQuoteCode(text.charCodeAt(quoteAt))) return undefined;
  let end = at;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code === 13 || code === 10) break;
    end += 1;
  }
  while (end > at) {
    const code = text.charCodeAt(end - 1);
    if (code !== SPACE && code !== TAB) break;
    end -= 1;
  }
  return end > at ? { end } : undefined;
};

/** Count the backslashes at `at`; a value opener keeps its whole run. */
export const countBackslashes = (text: string, at: number): number => {
  let end = at;
  while (text.charCodeAt(end) === BACKSLASH) end += 1;
  return end - at;
};
