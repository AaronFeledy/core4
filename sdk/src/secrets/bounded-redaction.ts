import { LOG_LINE_TRUNCATED_MARKER } from "../log-follow/marker.ts";

const CHUNK_CODE_UNITS = 1_024;
const SEGMENT_CODE_UNITS = 64 * 1_024;

export type BoundedPatternReplacement = {
  readonly pattern: RegExp;
  readonly replace: string | ((substring: string, ...groups: string[]) => string);
};

const chunkEnd = (value: string, start: number): number => {
  const candidate = Math.min(start + CHUNK_CODE_UNITS, value.length);
  if (candidate >= value.length) return candidate;
  const finalCodeUnit = value.charCodeAt(candidate - 1);
  const nextCodeUnit = value.charCodeAt(candidate);
  return finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
    ? candidate + 1
    : candidate;
};

class BoundedStringBuilder {
  readonly #encoder = new TextEncoder();
  readonly #maxBytes: number;
  readonly #segments: string[] = [];
  #pending = "";
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(value: string): boolean {
    for (let start = 0; start < value.length; ) {
      const end = chunkEnd(value, start);
      const chunk = value.slice(start, end);
      const bytes = this.#encoder.encode(chunk).byteLength;
      if (this.#bytes + bytes > this.#maxBytes) return false;
      this.#bytes += bytes;
      this.#pending += chunk;
      if (this.#pending.length >= SEGMENT_CODE_UNITS) {
        this.#segments.push(this.#pending);
        this.#pending = "";
      }
      start = end;
    }
    return true;
  }

  finish(): string {
    if (this.#segments.length === 0) return this.#pending;
    if (this.#pending.length > 0) this.#segments.push(this.#pending);
    return this.#segments.join("");
  }
}

export const retainWithinBytes = (text: string, maxBytes: number): string | undefined => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined;
  const builder = new BoundedStringBuilder(maxBytes);
  return builder.append(text) ? builder.finish() : undefined;
};

const appendReplacement = (
  builder: BoundedStringBuilder,
  replacement: BoundedPatternReplacement["replace"],
  match: RegExpExecArray,
): boolean => {
  if (typeof replacement === "string") return builder.append(replacement);
  const groups = match.slice(1).map((group) => group ?? "");
  return builder.append(replacement(match[0], ...groups));
};

/** Occurrences of `replacement` already in `text` are opaque, so a second pass never masks inside one. */
export const replaceLiteralBounded = (
  text: string,
  value: string,
  replacement: string,
  maxBytes: number,
): string | undefined => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined;
  if (value.length === 0) return retainWithinBytes(text, maxBytes);
  const builder = new BoundedStringBuilder(maxBytes);
  let start = 0;
  while (start < text.length) {
    const sentinel = text.indexOf(replacement, start);
    const end = sentinel === -1 ? text.length : sentinel;
    const segment = text.slice(start, end);
    let offset = 0;
    for (let found = segment.indexOf(value); found >= 0; found = segment.indexOf(value, offset)) {
      if (!builder.append(segment.slice(offset, found)) || !builder.append(replacement)) return undefined;
      offset = found + value.length;
    }
    if (!builder.append(segment.slice(offset))) return undefined;
    if (sentinel === -1) return builder.finish();
    if (!builder.append(replacement)) return undefined;
    start = sentinel + replacement.length;
  }
  return builder.finish();
};

/** Mask a trailing proper prefix of a known value cut off by a log-line truncation marker. */
export const replaceTruncatedPrefixesBounded = (
  text: string,
  values: readonly string[],
  replacement: string,
  maxBytes: number,
): string | undefined => {
  const builder = new BoundedStringBuilder(maxBytes);
  let start = 0;
  for (
    let marker = text.indexOf(LOG_LINE_TRUNCATED_MARKER);
    marker !== -1;
    marker = text.indexOf(LOG_LINE_TRUNCATED_MARKER, start)
  ) {
    // Existing sentinels are opaque, including to the proper-prefix pass.
    const sentinel = text.slice(start, marker).lastIndexOf(replacement);
    const boundary = sentinel === -1 ? start : start + sentinel + replacement.length;
    let longest = 0;
    for (const value of values) {
      for (let length = Math.min(value.length - 1, marker - boundary); length > longest; length -= 1) {
        if (text.endsWith(value.slice(0, length), marker)) {
          longest = length;
          break;
        }
      }
    }
    if (!builder.append(text.slice(start, marker - longest))) return undefined;
    if (longest > 0 && !builder.append(replacement)) return undefined;
    if (!builder.append(LOG_LINE_TRUNCATED_MARKER)) return undefined;
    start = marker + LOG_LINE_TRUNCATED_MARKER.length;
  }
  return builder.append(text.slice(start)) ? builder.finish() : undefined;
};

export const replacePatternsBounded = (
  text: string,
  replacements: readonly BoundedPatternReplacement[],
  maxBytes: number,
): string | undefined => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined;
  let result = text;
  for (const replacement of replacements) {
    const builder = new BoundedStringBuilder(maxBytes);
    const pattern = new RegExp(replacement.pattern.source, replacement.pattern.flags);
    let start = 0;
    for (let match = pattern.exec(result); match !== null; match = pattern.exec(result)) {
      if (!builder.append(result.slice(start, match.index))) return undefined;
      if (!appendReplacement(builder, replacement.replace, match)) return undefined;
      start = match.index + match[0].length;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
    if (!builder.append(result.slice(start))) return undefined;
    result = builder.finish();
  }
  return result;
};
