/**
 * Continuation tracking for one released open secret construct.
 *
 * When a stream releases an unresolved value before its closer arrives (a line
 * or byte bound, a truncated line, or a live time bound), the following lines
 * of that stream are still inside it. This module carries the constant-size
 * state needed to recognize the end of the value and what replaces it:
 *
 * - a quoted value keeps its opener quote, whether the opener was escaped
 *   (closes at the next quote), the backslash parity carried across a line
 *   boundary, and which suffix rule ends an `=` or signed-query shell word;
 * - a `Bearer` introducer has no value of its own, so its token arrives on a
 *   later line after arbitrary whitespace. The first run of token characters is
 *   the value: a credential is masked, a prose word ends suppression untouched.
 *
 * It is pure and allocation-light: one pass per line, no buffering, so the
 * consumer decides how long to suppress and when the bound ends it.
 */

import { bearerTokenEnd, isBearerWord, looksLikeCredential } from "./secret-bearer.ts";
import type { OpenSecretConstruct } from "./secret-constructs.ts";
import { SENTINEL, countBackslashes, isAssignmentStop, isQueryStop, isSpaceCode } from "./secret-lexeme.ts";

const BACKSLASH = 92;
const QUOTE_DOUBLE = 34;
const QUESTION = 63;
const AMPERSAND = 38;

/** Which suffix rule ends a quoted value after its closing quote. */
export type ContinuationSuffix = "assignment" | "query" | "none";

export interface QuotedContinuation {
  readonly kind: "quoted";
  /** The value's opener quote. */
  readonly quote: string;
  /** True when the opener was a backslash run, so the next quote closes it. */
  readonly escaped: boolean;
  /** The suffix rule to skip after the closer (`none` for the colon forms). */
  readonly suffix: ContinuationSuffix;
  /** Trailing backslash parity carried across a line boundary (0 or 1). */
  readonly backslashes: number;
}

/** A released `Bearer` introducer whose token has not arrived yet. */
export interface BearerContinuation {
  readonly kind: "bearer";
}

export type SecretContinuation = QuotedContinuation | BearerContinuation;

/**
 * Start tracking a released open construct: a quoted value, or a `Bearer`
 * introducer whose token is still to come.
 */
export const startSecretContinuation = (
  text: string,
  construct: OpenSecretConstruct,
): SecretContinuation | undefined => {
  if (construct.quote === undefined)
    return isBearerWord(text, construct.start) ? { kind: "bearer" } : undefined;
  const backslashes = countBackslashes(text, construct.valueStart);
  const mark = text.charCodeAt(construct.start);
  const suffix: ContinuationSuffix = construct.keepsValueQuoting
    ? "none"
    : mark === QUESTION || mark === AMPERSAND
      ? "query"
      : "assignment";
  return { kind: "quoted", quote: construct.quote, escaped: backslashes > 0, suffix, backslashes: 0 };
};

/**
 * Where the continuation is reading: a real line boundary consumes a trailing
 * backslash (it escapes the newline itself, as the complete-text grammar does),
 * while a contiguous fragment keeps the parity for its next piece.
 */
export type ContinuationBoundary = "line" | "fragment";

export interface SecretContinuationStep {
  readonly state: SecretContinuation;
  /** Index just past the value in this line, or `-1` when it stays open. */
  readonly closedAt: number;
  /** Text that replaced the value before `closedAt` (empty for quoted forms). */
  readonly replacement: string;
  /** True when a `Bearer` value turned out to be prose, so the line is untouched. */
  readonly prose: boolean;
}

const openStep = (state: SecretContinuation): SecretContinuationStep => ({
  state,
  closedAt: -1,
  replacement: "",
  prose: false,
});

const isSpaceOnly = (content: string): boolean => {
  for (let index = 0; index < content.length; index += 1)
    if (!isSpaceCode(content.charCodeAt(index))) return false;
  return true;
};

/** Read the token a released `Bearer` introducer introduced on this line. */
const continueBearer = (state: BearerContinuation, content: string): SecretContinuationStep => {
  if (isSpaceOnly(content)) return openStep(state);
  let tokenStart = 0;
  while (tokenStart < content.length && isSpaceCode(content.charCodeAt(tokenStart))) tokenStart += 1;
  const tokenEnd = bearerTokenEnd(content, tokenStart);
  if (tokenEnd === tokenStart || !looksLikeCredential(content.slice(tokenStart, tokenEnd)))
    return { state, closedAt: -1, replacement: "", prose: true };
  return { state, closedAt: tokenEnd, replacement: SENTINEL, prose: false };
};

/**
 * Advance the continuation over one line. A `\r` before the line's terminator
 * belongs to the terminator, not the value. When the value ends, the step
 * reports where it ended and what replaced it, so the consumer can resume
 * scanning the rest of the line.
 */
export const continueSecretValue = (
  state: SecretContinuation,
  line: string,
  boundary: ContinuationBoundary = "line",
): SecretContinuationStep => {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (state.kind === "bearer") return continueBearer(state, content);
  const quote = state.quote.charCodeAt(0);
  let backslashes = state.backslashes;
  let closer = -1;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (state.escaped) {
      if (code === quote) {
        closer = index + 1;
        break;
      }
      continue;
    }
    if (code === quote && (quote !== QUOTE_DOUBLE || backslashes % 2 === 0)) {
      closer = index + 1;
      break;
    }
    backslashes = code === BACKSLASH ? backslashes + 1 : 0;
  }
  if (closer < 0)
    return {
      state: { ...state, backslashes: boundary === "line" ? 0 : backslashes % 2 },
      closedAt: -1,
      replacement: "",
      prose: false,
    };
  let end = closer;
  if (state.suffix !== "none") {
    const isStop = state.suffix === "query" ? isQueryStop : isAssignmentStop;
    while (end < content.length && !isStop(content.charCodeAt(end))) end += 1;
  }
  return { state: { ...state, backslashes: 0 }, closedAt: end, replacement: "", prose: false };
};
