import { SqlDumpIncompleteError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { makeMongoArchiveTracker } from "./mongo-archive.ts";

export type DumpCompleteness = "complete" | "truncated" | "unrecognized";
export type DumpCompletenessTracker = {
  readonly push: (chunk: Uint8Array) => void;
  readonly verdict: () => DumpCompleteness;
};
export type DumpCompletenessRule = () => DumpCompletenessTracker;

const EDGE_BYTES = 512;
// Keep one preceding byte to distinguish a whole line from a partial first line.
const TAIL_BYTES = EDGE_BYTES + 1;
const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
};
const lastBytes = (bytes: Uint8Array, limit = EDGE_BYTES): Uint8Array =>
  bytes.byteLength > limit ? bytes.slice(-limit) : bytes;
const wholeLineTail = (tail: Uint8Array): Uint8Array => {
  if (tail.byteLength <= EDGE_BYTES) return tail;
  const lineBreak = tail.indexOf(0x0a);
  return lineBreak === -1 ? new Uint8Array() : tail.subarray(lineBreak + 1);
};
const isAsciiWhitespace = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/** Retains bounded edges before trailing whitespace, independent of chunk boundaries. */
export const textDumpCompleteness =
  (rule: { readonly header: RegExp; readonly complete: RegExp }): DumpCompletenessRule =>
  () => {
    let head: Uint8Array = new Uint8Array();
    let tail: Uint8Array = new Uint8Array();
    let trailingWhitespace: Uint8Array = new Uint8Array();
    return {
      push: (chunk) => {
        if (head.byteLength < EDGE_BYTES)
          head = concatBytes(head, chunk.subarray(0, EDGE_BYTES - head.byteLength));
        const last = chunk.findLastIndex((byte) => !isAsciiWhitespace(byte));
        if (last === -1) {
          trailingWhitespace = lastBytes(concatBytes(trailingWhitespace, chunk));
          return;
        }
        const content = chunk.subarray(0, last + 1);
        tail =
          content.byteLength >= TAIL_BYTES
            ? content.slice(-TAIL_BYTES)
            : lastBytes(concatBytes(concatBytes(tail, trailingWhitespace), content), TAIL_BYTES);
        trailingWhitespace = lastBytes(chunk.subarray(last + 1));
      },
      verdict: () => {
        const decoder = new TextDecoder();
        if (!rule.header.test(decoder.decode(head))) return "unrecognized";
        return rule.complete.test(decoder.decode(wholeLineTail(tail))) ? "complete" : "truncated";
      },
    };
  };

export const mongoDumpCompleteness: DumpCompletenessRule = () => {
  const archive = makeMongoArchiveTracker();
  let head: Uint8Array = new Uint8Array();
  return {
    push: (chunk) => {
      if (head.byteLength < 4) head = concatBytes(head, chunk.subarray(0, 4 - head.byteLength));
      archive.push(chunk);
    },
    verdict: () => {
      if (head.byteLength < 4 || new DataView(head.buffer).getUint32(0, true) !== 0x8199e26d)
        return "unrecognized";
      return archive.complete() ? "complete" : "truncated";
    },
  };
};

/** Emptiness is generic; only the target family's tracker judges tool completeness. */
export const trackDumpCompleteness = (rule: DumpCompletenessRule | undefined) => {
  const tracker = rule?.();
  let size = 0;
  return {
    push: (chunk: Uint8Array) => {
      size += chunk.byteLength;
      tracker?.push(chunk);
    },
    requireComplete: (label: string, fromStdin: boolean) => {
      if (size !== 0 && tracker?.verdict() !== "truncated") return Effect.void;
      const reason = size === 0 ? "empty" : "truncated";
      const source = fromStdin ? "the command feeding stdin" : "the dump file";
      const truncatedRemediation = fromStdin
        ? "Recreate the dump and check that the export command succeeded (in bash, set -o pipefail), then retry."
        : "Recreate the dump file and check that the export command succeeded, then retry.";
      return Effect.fail(
        new SqlDumpIncompleteError({
          message:
            reason === "empty"
              ? `The dump from ${label} is empty.`
              : `The dump from ${label} ends before its completion marker, so the tool that wrote it stopped early.`,
          path: label,
          reason,
          remediation:
            reason === "empty" ? `Check that ${source} produced a dump, then retry.` : truncatedRemediation,
        }),
      );
    },
  };
};
