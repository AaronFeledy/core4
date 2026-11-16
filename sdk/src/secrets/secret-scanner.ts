/**
 * The secret scanner: one pass over text yields every masked span and the
 * leftmost construct the grammar could still complete.
 *
 * Masking and open detection are the same scan, so a construct the grammar
 * masks and the construct the line-stream holds can never disagree. A trigger
 * search finds candidate positions (`password` and its family, `Bearer`, a
 * signed-query separator, a URL scheme, an encoded scheme); from a trigger the
 * scanner recovers the name run, classifies it with the shared recognizers,
 * reads the separator and value once, and advances past everything it examined.
 * Text with no trigger costs one regex test.
 *
 * URL userinfo masks first as a regex stage, then the grammar forms, then
 * `Bearer`, then signed queries; the value-view module owns the two stages that
 * read a composed value. A construct that leaves a value domain keeps the
 * remaining replacement text, which is exactly what repeated whole-string
 * stages produce.
 */
import {
  type BoundedSpan as SecretSpan,
  replacePatternsBounded,
  replaceSpansBounded,
} from "./bounded-redaction.ts";
import { BEARER_LENGTH, isBearerWord, matchBearer } from "./secret-bearer.ts";
import type { OpenSecretConstruct, SecretConstruct } from "./secret-constructs.ts";
import { grammarAt } from "./secret-grammar.ts";
import { isNameCode, nameRunEnd } from "./secret-lexeme.ts";
import { openConstructReplacement } from "./secret-value-mask.ts";
import { signedQuery } from "./secret-value-view.ts";
import { URL_USERINFO_REPLACEMENTS, redactUrlUserinfo } from "./url-userinfo.ts";

interface SecretScan {
  readonly spans: readonly SecretSpan[];
  readonly open: OpenSecretConstruct | undefined;
}

/**
 * Every position that can start a scanner-owned construct. `password` and its
 * family cover the name forms (including `api_key`/`apikey` and the `auth`
 * family); `key` covers structural names such as `private_key`; `[?&]` covers
 * signed queries; the URL scheme and its encoded spelling cover the regex stage.
 */
const TRIGGER =
  /(?:password|passwd|secret|token|credential|bearer|api[_-]?key|auth|signature|sig|key|[?&]|:\/\/|%3a%2f%2f)/giu;

/** Find the construct a trigger position belongs to, if any. */
const constructAtTrigger = (text: string, index: number, trigger: string): SecretConstruct | undefined => {
  if (trigger === "?" || trigger === "&") return signedQuery(text, index);
  if (isBearerWord(text, index)) {
    const bearer = matchBearer(text, index);
    if (bearer !== undefined) return bearer;
  }
  let runStart = index;
  while (runStart > 0 && isNameCode(text.charCodeAt(runStart - 1))) runStart -= 1;
  const runEnd = nameRunEnd(text, index);
  if (runEnd === runStart) return undefined;
  const grammar = grammarAt(text, runStart, runEnd);
  if (grammar !== undefined) return grammar;
  // A run may contain a `Bearer` word after a `.` or `-`, which is a word
  // boundary even though the run is one name; the bearer stage still owns it.
  for (let at = runStart + 1; at + BEARER_LENGTH <= runEnd; at += 1) {
    if (!isBearerWord(text, at)) continue;
    const bearer = matchBearer(text, at);
    if (bearer !== undefined) return bearer;
  }
  return undefined;
};

/**
 * Scan `text` once. `collectSpans` is false for a caller that only needs the
 * open construct, so the trigger walk is the same code either way.
 */
const scanSecretText = (text: string, collectSpans = true): SecretScan => {
  TRIGGER.lastIndex = 0;
  const spans: SecretSpan[] = [];
  let open: OpenSecretConstruct | undefined;
  let cursor = 0;
  let match = TRIGGER.exec(text);
  if (match === null) return { spans, open };
  while (match !== null) {
    const index = match.index;
    const trigger = match[0];
    if (index < cursor) {
      match = TRIGGER.exec(text);
      continue;
    }
    const construct = constructAtTrigger(text, index, trigger);
    if (construct === undefined) {
      cursor =
        trigger === "?" || trigger === "&" || !isNameCode(text.charCodeAt(index))
          ? index + 1
          : nameRunEnd(text, index);
    } else {
      if (construct.open !== undefined && open === undefined) open = construct.open;
      if (collectSpans && construct.replacement !== undefined)
        spans.push({
          start: construct.spanStart,
          end: construct.spanEnd,
          replacement: construct.replacement,
        });
      cursor = Math.max(cursor, construct.end);
    }
    if (cursor > index) TRIGGER.lastIndex = cursor;
    match = TRIGGER.exec(text);
  }
  return { spans, open };
};

const renderSecretSpans = (text: string, spans: readonly SecretSpan[]): string => {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) parts.push(text.slice(cursor, span.start));
    parts.push(span.replacement);
    cursor = span.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join("");
};

/** Spans plus the closing of an unproven value, in ascending order. */
const finalSpans = (text: string, scan: SecretScan): readonly SecretSpan[] => {
  const open = scan.open;
  if (open === undefined || open.quote === undefined) return scan.spans;
  const before = scan.spans.filter((span) => span.end <= open.valueStart);
  const replacement = openConstructReplacement(text.slice(open.valueStart), open.keepsValueQuoting);
  return [...before, { start: open.valueStart, end: text.length, replacement }];
};

/** Mask every secret construct in complete text (`close` true) or in a prefix. */
export const redactSecrets = (text: string, close: boolean): string => {
  const staged = redactUrlUserinfo(text);
  const scan = scanSecretText(staged);
  return renderSecretSpans(staged, close ? finalSpans(staged, scan) : scan.spans);
};

/** Bounded complete-text masking: exact, or `undefined` when the budget is exceeded. */
export const redactSecretsBounded = (text: string, maxBytes: number): string | undefined => {
  const staged = replacePatternsBounded(text, URL_USERINFO_REPLACEMENTS, maxBytes);
  if (staged === undefined) return undefined;
  const scan = scanSecretText(staged);
  return replaceSpansBounded(staged, finalSpans(staged, scan), maxBytes);
};

/** The leftmost construct the grammar could still complete in already-redacted text. */
export const findOpenSecretConstruct = (text: string): OpenSecretConstruct | undefined =>
  scanSecretText(text, false).open;

/** Mask an unresolved construct in complete text from its value to the end. */
export const maskOpenSecretConstruct = (text: string, construct: OpenSecretConstruct): string => {
  if (construct.quote === undefined) return text;
  const replacement = openConstructReplacement(text.slice(construct.valueStart), construct.keepsValueQuoting);
  return `${text.slice(0, construct.valueStart)}${replacement}`;
};
