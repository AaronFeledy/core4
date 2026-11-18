/**
 * Grammar constructs the secret scanner recognizes.
 *
 * Each matcher takes the name run it is asked about and returns the value span
 * and its masked replacement, or an open construct when a quote opener has no
 * closer yet. The assignment, quoted-key member, and block-mapping key forms
 * share the same name vocabulary as the recognizers in `secret-names.ts`, so a
 * name is classified exactly once and grammar and recognizer cannot disagree.
 *
 * The `=` and signed-query forms replace a quoted value with a bare sentinel;
 * the colon forms keep the value's own quoting (and escaped-JSON backslash run)
 * so a masked document still parses the value as a string. Published defaults,
 * typed YAML/JSON scalars, and complete environment or secret references stay
 * readable.
 */

import { REDACTED } from "./redactor.ts";
import {
  type ClosedValue,
  SENTINEL,
  countBackslashes,
  isAssignmentStop,
  isBlank,
  isMemberStop,
  isNameCode,
  isQuoteCode,
  readQuoted,
  readQuotedWord,
  readUnquoted,
} from "./secret-lexeme.ts";
import { isSecretFieldName, isSecretStructuralName } from "./secret-names.ts";
import {
  MEMBER_TYPED_LITERAL,
  isQuotedOrBarePublishedDefault,
  keepsReference,
  sentinelInQuotesOf,
} from "./secret-value-mask.ts";

const BACKSLASH = 92;
const COLON = 58;
const EQUALS = 61;
const DOT_CHAR = 46;
const UNDERSCORE = 95;
const DASH = 45;
const OPEN_BRACKET = 91;
const OPEN_BRACE = 123;
const QUESTION = 63;
const AMPERSAND = 38;

/** A construct that the secret grammar could still complete if more text arrived. */
export interface OpenSecretConstruct {
  /** Index where the construct begins: its name, query prefix, or `Bearer`. */
  readonly start: number;
  /** Index where its value begins; everything from here on is unproven. */
  readonly valueStart: number;
  /** The value's opener quote, or `undefined` for a `Bearer` introducer with no value. */
  readonly quote: string | undefined;
  /** True when masking keeps the value's own quoting (the colon forms). */
  readonly keepsValueQuoting: boolean;
}

/**
 * One recognized construct. `replacement` is `undefined` when the construct is
 * kept as written; `spanStart`..`spanEnd` is the value range it would replace.
 */
export interface SecretConstruct {
  readonly start: number;
  readonly end: number;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly replacement: string | undefined;
  readonly open?: OpenSecretConstruct;
}

/**
 * A structural name must end with its sensitive segment: a trailing separator
 * (`api_key_`) has an empty last segment, which the generated name grammar
 * never accepted, so the recognizer and the grammar stay in agreement.
 */
export const isStructuralRun = (name: string): boolean => {
  const last = name.charCodeAt(name.length - 1);
  return last !== DOT_CHAR && last !== UNDERSCORE && last !== DASH && isSecretStructuralName(name);
};

export const maskedSpan = (
  start: number,
  spanStart: number,
  spanEnd: number,
  replacement: string,
): SecretConstruct => ({ start, end: spanEnd, spanStart, spanEnd, replacement });

export const keptSpan = (start: number, end: number): SecretConstruct => ({
  start,
  end,
  spanStart: end,
  spanEnd: end,
  replacement: undefined,
});

/** The construct's text as it appears after its own replacement is applied. */
export const renderConstruct = (text: string, construct: SecretConstruct): string =>
  construct.replacement === undefined
    ? text.slice(construct.start, construct.end)
    : `${text.slice(construct.start, construct.spanStart)}${construct.replacement}${text.slice(construct.spanEnd, construct.end)}`;

/** An open quoted value: its opener has no closer yet. */
export const openQuotedConstruct = (
  text: string,
  start: number,
  valueStart: number,
  keepsValueQuoting: boolean,
): SecretConstruct => ({
  start,
  // An open value is unproven, but complete constructs inside it are still
  // masked on the prefix path; complete text masks from the value onward.
  end: valueStart,
  spanStart: valueStart,
  spanEnd: valueStart,
  replacement: undefined,
  open: {
    start,
    valueStart,
    quote: text.charAt(valueStart + countBackslashes(text, valueStart)),
    keepsValueQuoting,
  },
});

/** A `Bearer` introducer with no value: it has no quote and appends nothing. */
export const openIntroducer = (start: number, valueStart: number): SecretConstruct => ({
  start,
  end: valueStart,
  spanStart: valueStart,
  spanEnd: valueStart,
  replacement: undefined,
  open: { start, valueStart, quote: undefined, keepsValueQuoting: false },
});

/**
 * The `=` assignment and the colon-plus-quoted-value form. The `=` name is
 * broad (`isSecretFieldName`); the colon name is structural, because a false
 * positive there would swallow a diagnostic or a capability flag.
 */
export const matchAssignment = (
  text: string,
  runStart: number,
  runEnd: number,
  name: string,
): SecretConstruct | undefined => {
  const previous = runStart === 0 ? -1 : text.charCodeAt(runStart - 1);
  if (previous === QUESTION || previous === AMPERSAND || isNameCode(previous)) return undefined;
  let separator = runEnd;
  while (isBlank(text.charCodeAt(separator))) separator += 1;
  const separatorCode = text.charCodeAt(separator);
  if (separatorCode === EQUALS && isSecretFieldName(name)) {
    let valueStart = separator + 1;
    while (isBlank(text.charCodeAt(valueStart))) valueStart += 1;
    const value =
      readQuotedWord(text, valueStart, isAssignmentStop) ?? readUnquoted(text, valueStart, isAssignmentStop);
    if (value === undefined) return undefined;
    if ("open" in value) {
      // `"token="` closes a shell string opened before the name; never hold it.
      if (previous === text.charCodeAt(valueStart + countBackslashes(text, valueStart))) return undefined;
      return openQuotedConstruct(text, runStart, valueStart, false);
    }
    const raw = text.slice(valueStart, value.end);
    if (
      isQuotedOrBarePublishedDefault(raw) ||
      keepsReference(raw, text.charCodeAt(value.end), isAssignmentStop)
    )
      return keptSpan(runStart, value.end);
    return maskedSpan(runStart, valueStart, value.end, REDACTED);
  }
  if (separatorCode !== COLON || !isStructuralRun(name) || isQuoteCode(previous)) return undefined;
  let valueStart = separator + 1;
  let blanks = 0;
  while (isBlank(text.charCodeAt(valueStart))) {
    valueStart += 1;
    blanks += 1;
  }
  if (blanks === 0) return undefined;
  const value = readQuoted(text, valueStart);
  if (value === undefined) return undefined;
  if ("open" in value) return openQuotedConstruct(text, runStart, valueStart, true);
  const raw = text.slice(valueStart, value.end);
  if (
    isQuotedOrBarePublishedDefault(raw) ||
    keepsReference(raw, text.charCodeAt(value.end), isAssignmentStop)
  )
    return keptSpan(runStart, value.end);
  return maskedSpan(runStart, valueStart, value.end, sentinelInQuotesOf(raw, "", ""));
};

/** A quoted key in JSON, Python, or escaped-JSON spelling, then its scalar member. */
export const matchMember = (
  text: string,
  runStart: number,
  runEnd: number,
  name: string,
): SecretConstruct | undefined => {
  // The structural checks come first: most triggers in prose have no key
  // opener, and the name recognizer is the expensive part.
  const keyQuoteAt = runStart - 1;
  const keyQuote = text.charCodeAt(keyQuoteAt);
  if (!isQuoteCode(keyQuote)) return undefined;
  let runAt = keyQuoteAt;
  while (runAt > 0 && text.charCodeAt(runAt - 1) === BACKSLASH) runAt -= 1;
  const previous = runAt === 0 ? -1 : text.charCodeAt(runAt - 1);
  if (isNameCode(previous)) return undefined;
  const keyRun = text.slice(runAt, keyQuoteAt);
  for (let offset = 0; offset < keyRun.length; offset += 1)
    if (text.charCodeAt(runEnd + offset) !== BACKSLASH) return undefined;
  if (text.charCodeAt(runEnd + keyRun.length) !== keyQuote) return undefined;
  let separator = runEnd + keyRun.length + 1;
  while (isBlank(text.charCodeAt(separator))) separator += 1;
  if (text.charCodeAt(separator) !== COLON || !isSecretFieldName(name)) return undefined;
  let valueStart = separator + 1;
  while (isBlank(text.charCodeAt(valueStart))) valueStart += 1;
  // Never a nested object or array value; an existing sentinel is an opaque value.
  const valueCode = text.charCodeAt(valueStart);
  if (valueCode === OPEN_BRACE) return undefined;
  if (valueCode === OPEN_BRACKET && !text.startsWith(SENTINEL, valueStart)) return undefined;
  const quoted = readQuoted(text, valueStart);
  let value: ClosedValue | undefined;
  if (quoted === undefined) {
    value = readUnquoted(text, valueStart, isMemberStop);
  } else if ("open" in quoted) {
    return openQuotedConstruct(text, runAt, valueStart, true);
  } else {
    value = quoted;
  }
  if (value === undefined) return undefined;
  const raw = text.slice(valueStart, value.end);
  if (
    MEMBER_TYPED_LITERAL.test(raw) ||
    isQuotedOrBarePublishedDefault(raw) ||
    keepsReference(raw, text.charCodeAt(value.end), isMemberStop)
  )
    return keptSpan(runStart, value.end);
  return maskedSpan(
    runStart,
    valueStart,
    value.end,
    sentinelInQuotesOf(raw, keyRun, String.fromCharCode(keyQuote)),
  );
};
