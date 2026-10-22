import { redactedInspection } from "./inspection.ts";
import { LiteralMatcher } from "./literal-matcher.ts";
import { REDACTED } from "./redactor.ts";

/** Value-only byte redaction. Each instance owns one ordered payload stream. */
export interface PayloadRedactor {
  readonly write: (chunk: Uint8Array) => Uint8Array;
  readonly flush: () => Uint8Array;
}

/**
 * Read the live value set before every write. The getter should return the same
 * iterable until its generation changes. Registrations apply prospectively,
 * including to the held tail, but cannot retract bytes already delivered.
 * Retained input is at most the longest secret minus one byte, never a chunk.
 */
export const createPayloadRedactor = (getValues: () => Iterable<string>): PayloadRedactor => {
  const encoder = new TextEncoder();
  const replacement = encoder.encode(REDACTED);
  let previous: Iterable<string> | undefined;
  let matcher = new LiteralMatcher([]);
  let pending: Uint8Array = new Uint8Array(0);
  // End of the union whose sentinel was already emitted, relative to pending.
  let coveredUntil = 0;

  const redact = (chunk: Uint8Array, final: boolean): Uint8Array => {
    const values = getValues();
    if (values !== previous) {
      matcher = new LiteralMatcher(Array.from(values, (value) => encoder.encode(value)));
      previous = values;
    }
    if (matcher.empty && pending.length === 0) return chunk;
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
      const match = matcher.matchAt(input, index);
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
