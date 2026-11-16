/**
 * The `Bearer` form.
 *
 * The token is read in the grammar-masked view, so a secret-named assignment
 * that supplies the token is masked whole. The introducer itself may name a
 * grammar form (`Bearer =...`), so a construct at the introducer is rendered
 * before the token is read; its replacement tail after the token survives,
 * which is what the ordered stages produce. An introducer with nothing after it
 * is an open construct; a prose word leaves the text as written.
 */
import { type SecretConstruct, maskedSpan, openIntroducer, renderConstruct } from "./secret-constructs.ts";
import { grammarAt } from "./secret-grammar.ts";
import { SENTINEL, isNameCode, isSpaceCode, isWordCode } from "./secret-lexeme.ts";

const DOT = 46;
const TILDE = 126;
const PLUS = 43;
const SLASH = 47;
const EQUALS = 61;
const DASH = 45;

const BEARER = "bearer";
export const BEARER_LENGTH = BEARER.length;

/** `[\w.~+/=-]`, the Bearer token alphabet. */
const isTokenCode = (code: number): boolean =>
  isWordCode(code) ||
  code === DOT ||
  code === TILDE ||
  code === PLUS ||
  code === SLASH ||
  code === EQUALS ||
  code === DASH;

const isAsciiLetter = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** A `Bearer` introducer at a word boundary, in any case. */
export const isBearerWord = (text: string, at: number): boolean => {
  if (at + BEARER_LENGTH > text.length) return false;
  for (let offset = 0; offset < BEARER_LENGTH; offset += 1) {
    const code = text.charCodeAt(at + offset);
    const lower = code >= 65 && code <= 90 ? code + 32 : code;
    if (lower !== BEARER.charCodeAt(offset)) return false;
  }
  return at === 0 || !isWordCode(text.charCodeAt(at - 1));
};

/**
 * A Bearer value is masked when it looks like a credential: not a plain
 * lowercase or uppercase alphabetic word shorter than 16 characters. A plain
 * word is prose (`Bearer token expected in the Authorization header`), while a
 * digit, any other separator, mixed case, a masked sentinel, or length proves a
 * credential. Registered values are still masked by the value layer.
 */
export const looksLikeCredential = (token: string): boolean => {
  if (token.length >= 16) return true;
  let lower = false;
  let upper = false;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (!isAsciiLetter(code)) return true;
    if (code >= 97) lower = true;
    else upper = true;
  }
  return lower && upper;
};

/** The end of the Bearer token run starting at `from`: the alphabet above, one run. */
export const bearerTokenEnd = (text: string, from: number): number => {
  let end = from;
  while (end < text.length && isTokenCode(text.charCodeAt(end))) end += 1;
  return end;
};

export const matchBearer = (text: string, at: number): SecretConstruct | undefined => {
  const chunks: string[] = [];
  let introSeen = 0;
  let phase = 0; // 0 introducer, 1 whitespace after it, 2 token units
  let blanks = 0;
  let rawEnd = at;
  let position = at;
  let leftover = "";
  const consume = (rendered: string): number => {
    let index = 0;
    while (index < rendered.length) {
      if (introSeen < BEARER_LENGTH) {
        introSeen += 1;
        index += 1;
        continue;
      }
      if (phase === 0) phase = 1;
      if (phase === 1) {
        if (!isSpaceCode(rendered.charCodeAt(index))) phase = 2;
        else {
          blanks += 1;
          index += 1;
          continue;
        }
      }
      if (rendered.startsWith(SENTINEL, index)) {
        index += SENTINEL.length;
        continue;
      }
      if (!isTokenCode(rendered.charCodeAt(index))) return index;
      index += 1;
    }
    return index;
  };
  while (position < text.length) {
    const runStart = position === at || !isNameCode(text.charCodeAt(position - 1));
    const piece = runStart ? grammarAt(text, position) : undefined;
    const sentinel = piece === undefined && text.startsWith(SENTINEL, position);
    const rendered =
      piece === undefined ? (sentinel ? SENTINEL : text.charAt(position)) : renderConstruct(text, piece);
    const consumed = consume(rendered);
    if (consumed < rendered.length) {
      if (consumed > 0) {
        chunks.push(rendered.slice(0, consumed));
        // The whole construct belongs to the region; only its rendered tail
        // after the token survives the mask.
        rawEnd = piece === undefined ? position : piece.end;
        leftover = rendered.slice(consumed);
      }
      break;
    }
    chunks.push(rendered);
    position = piece === undefined ? position + rendered.length : piece.end;
    rawEnd = position;
  }
  const composed = chunks.join("");
  if (!composed.startsWith(text.slice(at, at + BEARER_LENGTH))) return undefined;
  const tail = composed.slice(BEARER_LENGTH);
  let whitespaceOnly = true;
  for (let index = 0; index < tail.length; index += 1) {
    if (!isSpaceCode(tail.charCodeAt(index))) {
      whitespaceOnly = false;
      break;
    }
  }
  const token = tail.trimStart();
  if (token.length === 0)
    return whitespaceOnly && leftover === "" && rawEnd >= text.length
      ? openIntroducer(at, rawEnd)
      : undefined;
  if (blanks === 0 || !looksLikeCredential(token)) return undefined;
  return maskedSpan(at, at, rawEnd, `${composed.slice(0, BEARER_LENGTH)} ${SENTINEL}${leftover}`);
};
