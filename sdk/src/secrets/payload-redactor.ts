import { redactedInspection } from "./inspection.ts";
import {
  LiteralMatcher,
  type TieredRedactionValues,
  isRedactionTokenBoundaryUnit,
} from "./literal-matcher.ts";
import { REDACTED, isUsableExactRedactionValue } from "./redactor.ts";

/** Value-only byte redaction. Each instance owns one ordered payload stream. */
export interface PayloadRedactor {
  readonly write: (chunk: Uint8Array) => Uint8Array;
  readonly flush: () => Uint8Array;
}

/**
 * Read the live value set before every write. The getter should return the same
 * iterable until its generation changes. Registrations apply prospectively,
 * including to the held tail, but cannot retract bytes already delivered.
 * Retained input is at most the longest value, never a chunk.
 */
export const createPayloadRedactor = (
  getValues: () => Iterable<string> | TieredRedactionValues,
): PayloadRedactor => {
  const encoder = new TextEncoder();
  const replacement = encoder.encode(REDACTED);
  let previous: Iterable<string> | TieredRedactionValues | undefined;
  let matcher = new LiteralMatcher([]);
  let pending: Uint8Array = new Uint8Array(0);
  // End of the union whose sentinel was already emitted, relative to pending.
  let coveredUntil = 0;
  let previousByte: number | undefined;

  const redact = (chunk: Uint8Array, final: boolean): Uint8Array => {
    const values = getValues();
    if (values !== previous) {
      const tiers = "substring" in values ? values : { substring: values, wholeToken: [] };
      const encode = (entries: Iterable<string>) => Array.from(entries, (value) => encoder.encode(value));
      matcher = new LiteralMatcher(
        encode(tiers.substring),
        encode([...tiers.wholeToken].filter(isUsableExactRedactionValue)),
      );
      previous = values;
    }
    if (matcher.empty && pending.length === 0) {
      if (chunk.length > 0) previousByte = chunk[chunk.length - 1];
      return chunk;
    }
    const input = pending.length === 0 ? chunk : new Uint8Array(pending.length + chunk.length);
    if (pending.length > 0) {
      input.set(pending);
      input.set(chunk, pending.length);
    }
    pending = new Uint8Array(0);
    const pieces: Uint8Array[] = [];
    let start = coveredUntil;
    let index = 0;
    for (; index < input.length; index += 1) {
      if (!matcher.canStart(input[index])) continue;
      const match = matcher.matchAt(input, index, {
        final,
        leftBoundary: isRedactionTokenBoundaryUnit(index === 0 ? previousByte : input[index - 1]),
      });
      if (!final && match.partial) {
        // Covered bytes must remain raw here: an overlapping occurrence may
        // start inside them and extend the union in a subsequent chunk.
        pending = input.slice(index);
        break;
      }
      if (match.end > index) {
        if (index >= coveredUntil) pieces.push(input.subarray(start, index), replacement);
        coveredUntil = Math.max(coveredUntil, match.end);
        start = coveredUntil;
      }
    }
    const tail = input.subarray(start, index);
    if (index > 0) previousByte = input[index - 1];
    coveredUntil = Math.max(0, coveredUntil - index);
    if (pieces.length === 0) return tail;
    pieces.push(tail);
    const output = new Uint8Array(pieces.reduce((size, piece) => size + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) {
      output.set(piece, offset);
      offset += piece.length;
    }
    return output;
  };
  return {
    ...redactedInspection,
    write: (chunk) => redact(chunk, false),
    flush: () => redact(new Uint8Array(0), true),
  };
};
