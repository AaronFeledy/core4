/**
 * The signed-query reader and the composed value it (and `Bearer`) reads.
 *
 * Stage order is preserved by reading the value in the view the earlier stages
 * produced: grammar forms first, then `Bearer`, then a signed query. When a
 * value ends inside a composed replacement (a space from a masked assignment, a
 * quote from a masked member), the remaining replacement survives as the
 * query's tail, which is exactly what repeated whole-string stages produce.
 */

import { REDACTED } from "./redactor.ts";
import { isBearerWord, matchBearer } from "./secret-bearer.ts";
import {
  type SecretConstruct,
  keptSpan,
  maskedSpan,
  openQuotedConstruct,
  renderConstruct,
} from "./secret-constructs.ts";
import { grammarAt } from "./secret-grammar.ts";
import {
  SENTINEL,
  countBackslashes,
  isNameCode,
  isQueryStop,
  isWordCode,
  plainValueEnd,
  readQuotedWord,
  readUnquoted,
} from "./secret-lexeme.ts";
import { isSignedQueryName } from "./secret-names.ts";
import { keepsReference } from "./secret-value-mask.ts";

const DOLLAR = 36;
const OPEN_BRACE = 123;
const QUESTION = 63;
const AMPERSAND = 38;
const DASH = 45;
const EQUALS = 61;

/** The name characters a signed query allows before its `=`. */
const isQueryNameCode = (code: number): boolean => isWordCode(code) || code === DASH;

/** End of a `?name=` / `&name=` parameter name, at the `=`, or `undefined`. */
const readQueryName = (text: string, at: number): number | undefined => {
  const marker = text.charCodeAt(at);
  if (marker !== QUESTION && marker !== AMPERSAND) return undefined;
  let end = at + 1;
  while (end < text.length && isQueryNameCode(text.charCodeAt(end))) end += 1;
  if (end === at + 1 || text.charCodeAt(end) !== EQUALS) return undefined;
  return end;
};

interface ComposedValue {
  readonly end: number;
  readonly text: string;
  readonly leftover: string;
}

const isReferenceStart = (text: string, at: number): boolean => {
  const position = at + countBackslashes(text, at);
  if (text.charCodeAt(position) !== DOLLAR) return false;
  const braceAt = text.charCodeAt(position + 1) === DOLLAR ? position + 2 : position + 1;
  return text.charCodeAt(braceAt) === OPEN_BRACE;
};

/**
 * Read an unquoted value in the view after the grammar and `Bearer` stages.
 * Constructs that start inside the value are rendered first; when one's
 * replacement leaves the value domain (a space from a masked assignment, a
 * quote from a masked member), the value ends there and the rest of that
 * replacement survives as `leftover`.
 */
const composeValue = (text: string, from: number, isStop: (code: number) => boolean): ComposedValue => {
  let composed = "";
  let position = from;
  while (position < text.length) {
    const runStart = position === from || !isNameCode(text.charCodeAt(position - 1));
    const piece = runStart
      ? isBearerWord(text, position)
        ? matchBearer(text, position)
        : grammarAt(text, position)
      : undefined;
    if (piece !== undefined) {
      composed += renderConstruct(text, piece);
      position = piece.end;
      const visible = plainValueEnd(composed, 0, isStop);
      if (visible < composed.length)
        return { end: position, text: composed.slice(0, visible), leftover: composed.slice(visible) };
      continue;
    }
    if (text.startsWith(SENTINEL, position)) {
      composed += SENTINEL;
      position += SENTINEL.length;
      continue;
    }
    if (composed.length === 0 && isReferenceStart(text, position)) {
      const reference = readUnquoted(text, position, isStop);
      if (reference !== undefined) {
        composed += text.slice(position, reference.end);
        position = reference.end;
        continue;
      }
    }
    if (isStop(text.charCodeAt(position))) break;
    composed += text.charAt(position);
    position += 1;
  }
  return { end: position, text: composed, leftover: "" };
};

/**
 * A signed-query parameter: `?name=value`, where the name is classified with the
 * broad field recognizer plus the signature words, so every query key follows
 * the same vocabulary as the other secret-name surfaces.
 */
export const signedQuery = (text: string, at: number): SecretConstruct | undefined => {
  const nameEnd = readQueryName(text, at);
  if (nameEnd === undefined || !isSignedQueryName(text.slice(at + 1, nameEnd))) return undefined;
  const valueStart = nameEnd + 1;
  const quoted = readQuotedWord(text, valueStart, isQueryStop);
  if (quoted !== undefined && "open" in quoted) {
    const quote = text.charAt(valueStart + countBackslashes(text, valueStart));
    if (at > 0 && text.charAt(at - 1) === quote) return undefined;
    return openQuotedConstruct(text, at, valueStart, false);
  }
  if (quoted !== undefined) {
    const value = text.slice(valueStart, quoted.end);
    if (keepsReference(value, text.charCodeAt(quoted.end), isQueryStop)) return keptSpan(at, quoted.end);
    return maskedSpan(at, valueStart, quoted.end, REDACTED);
  }
  const composed = composeValue(text, valueStart, isQueryStop);
  if (composed.text.length === 0) return undefined;
  if (composed.leftover === "" && keepsReference(composed.text, text.charCodeAt(composed.end), isQueryStop))
    return keptSpan(at, composed.end);
  return maskedSpan(at, valueStart, composed.end, `${REDACTED}${composed.leftover}`);
};
