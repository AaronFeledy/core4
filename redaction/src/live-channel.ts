/**
 * Shared live output channel for one provenance stream.
 *
 * Followed logs and machine stream frames arrive one at a time, but a
 * credential, registered value, or open quoted construct can span several
 * records. The channel owns no timer and performs no IO: delivered chunks
 * queue and the sink writes the head, shifting it only
 * after the write commits, so a failed delivery stays retryable.
 */
import type { Redactor, TieredRedactionValues } from "@lando/sdk/secrets";
import { type LineStreamTimeBound, createOutputLineRedactor } from "./line-stream.ts";
import { DEFAULT_MAX_PIECE_BYTES, EMPTY, createBytesChannel } from "./live-channel-bytes.ts";

/** One chunk the sink may write now; retain it until the write commits. */
export interface DeliveredChunk {
  readonly chunk: string;
  /** True when redaction altered the text, so retained capture must fail closed. */
  readonly changed: boolean;
}

type LiveChannelKind = "bytes" | "record";

export interface LiveChannelOptions {
  readonly kind: LiveChannelKind;
  /** The canonical `secrets` redactor used for the pattern layer. */
  readonly redactor: Pick<Redactor, "redactString" | "redactPrefix">;
  /** Exact values, read before every write so later registrations apply. */
  readonly payloadValues: () => Iterable<string> | TieredRedactionValues;
  readonly timeBound?: LineStreamTimeBound;
  /**
   * Bytes only: redact the value layer and hand every write straight through.
   * Interactive output is not a live surface and never holds a construct.
   */
  readonly raw?: boolean;
  /**
   * Cap for one delivered piece. A bytes channel cuts a line here; a record
   * channel splits a longer record here so each delivered chunk stays bounded.
   */
  readonly maxPieceBytes?: number;
}

interface ChannelBase {
  /** End the stream, releasing everything still held. */
  readonly end: () => Uint8Array;
  /** Release an expired hold fail-closed into the queue. */
  readonly expire: () => void;
  /** Earliest hold deadline of either layer, or `undefined` when nothing is held. */
  readonly deadline: () => number | undefined;
  /**
   * Bytes retained for sink accounting: the value layer, the line hold, and
   * chunks queued but not yet delivered because a write did not commit.
   */
  readonly retainedBytes: () => number;
  readonly queue: readonly DeliveredChunk[];
  /** Drop the delivered head after its write commits. */
  readonly shift: () => void;
}

export interface LiveBytesChannel extends ChannelBase {
  readonly kind: "bytes";
  /**
   * Feed raw bytes. A raw channel returns bytes that must be written
   * immediately; a live channel queues its delivered chunks and returns empty
   * bytes.
   */
  readonly feed: (bytes: Uint8Array) => Uint8Array;
}

export interface LiveRecordChannel extends ChannelBase {
  readonly kind: "record";
  /** Feed one complete line, without a terminator. */
  readonly feed: (line: string) => void;
}

export type LiveChannel = LiveBytesChannel | LiveRecordChannel;

const encoder = new TextEncoder();

const createRecordChannel = (
  options: LiveChannelOptions,
  queue: DeliveredChunk[],
): Omit<LiveRecordChannel, "queue" | "shift"> => {
  const output = createOutputLineRedactor(
    { redactor: options.redactor, payloadValues: options.payloadValues },
    {
      ...(options.timeBound === undefined ? {} : { timeBound: options.timeBound }),
      // Records are already framed by their producer, so this framer only
      // splits the appended terminator and must not re-bound a long record.
      maxLineBytes: Number.MAX_SAFE_INTEGER,
    },
  );
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const maxPieceBytes = options.maxPieceBytes ?? DEFAULT_MAX_PIECE_BYTES;
  // A record is one producer-bounded line, but the sink may still need each
  // delivered chunk bounded. The terminator stays on the final piece.
  const release = (lines: readonly string[], changed: boolean): void => {
    for (const line of lines) {
      const bytes = encoder.encode(`${line}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + maxPieceBytes);
        const text = decoder.decode(bytes.subarray(offset, end), { stream: true });
        offset = end;
        queue.push({ chunk: text, changed });
      }
    }
  };
  return {
    kind: "record",
    feed: (line) => {
      const heldBefore = output.retainedBytes() > 0;
      const lines = output.write(encoder.encode(`${line}\n`));
      const inputLines = line.split("\n");
      const changed =
        heldBefore ||
        lines.length !== inputLines.length ||
        lines.some((candidate, index) => candidate !== inputLines[index]);
      release(lines, changed);
    },
    end: () => {
      release(output.end(), true);
      return EMPTY;
    },
    expire: () => {
      release(output.expire(), true);
    },
    deadline: () => output.deadline(),
    retainedBytes: () => output.retainedBytes(),
  };
};

/** Create one live channel. The caller writes `queue` and shifts after each commit. */
export function createLiveChannel(options: LiveChannelOptions & { readonly kind: "bytes" }): LiveBytesChannel;
export function createLiveChannel(
  options: LiveChannelOptions & { readonly kind: "record" },
): LiveRecordChannel;
export function createLiveChannel(options: LiveChannelOptions): LiveChannel {
  const queue: DeliveredChunk[] = [];
  const channel =
    options.kind === "record" ? createRecordChannel(options, queue) : createBytesChannel(options, queue);
  return {
    ...channel,
    queue,
    shift: () => {
      queue.shift();
    },
    retainedBytes: () => {
      // A stalled or failing delivery retains real memory until the sink commits.
      let bytes = channel.retainedBytes();
      for (const entry of queue) bytes += encoder.encode(entry.chunk).byteLength;
      return bytes;
    },
  };
}
