import { redactedInspection } from "./inspection.ts";
import { REDACTED } from "./redactor.ts";

/** Value-only byte redaction. Each instance owns one ordered payload stream. */
export interface PayloadRedactor {
  readonly write: (chunk: Uint8Array) => Uint8Array;
  readonly flush: () => Uint8Array;
}

type Node = { readonly children: Map<number, Node>; terminal: boolean };

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
  let root: Node = { children: new Map(), terminal: false };
  let pending: Uint8Array = new Uint8Array(0);

  const redact = (chunk: Uint8Array, final: boolean): Uint8Array => {
    const values = getValues();
    if (values !== previous) {
      root = { children: new Map(), terminal: false };
      for (const value of values) {
        if (value.length === 0) continue;
        let node = root;
        for (const byte of encoder.encode(value)) {
          let next = node.children.get(byte);
          if (next === undefined) {
            next = { children: new Map(), terminal: false };
            node.children.set(byte, next);
          }
          node = next;
        }
        node.terminal = true;
      }
      previous = values;
    }
    const input = pending.length === 0 ? chunk : new Uint8Array(pending.length + chunk.length);
    if (pending.length > 0) {
      input.set(pending);
      input.set(chunk, pending.length);
    }
    pending = new Uint8Array(0);
    const pieces: Uint8Array[] = [];
    let start = 0;
    let index = 0;
    while (index < input.length) {
      let node = root;
      let end = index;
      let matchedEnd = index;
      while (end < input.length) {
        const byte = input[end];
        const next = byte === undefined ? undefined : node.children.get(byte);
        if (next === undefined) break;
        node = next;
        end += 1;
        if (node.terminal) matchedEnd = end;
      }
      if (!final && end === input.length && node.children.size > 0 && end > index) {
        pending = input.slice(index);
        break;
      }
      if (matchedEnd > index) {
        pieces.push(input.subarray(start, index), replacement);
        index = matchedEnd;
        start = index;
      } else {
        index += 1;
      }
    }
    const tail = input.subarray(start, index);
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
