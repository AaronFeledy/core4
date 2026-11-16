import { Buffer } from "node:buffer";
import { LIVE_LINE_HOLD_MILLIS } from "@lando/redaction/line-stream";
import { type LiveChannel, createLiveChannel } from "@lando/redaction/live-channel";
import type { Redactor, TieredRedactionValues } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { LIVE_PROGRESS_PIECE_BYTES, type LiveProgressInput, liveBytePieces } from "./live-progress-input";
import type { McpProgressData } from "./result-inspector";
import { MAX_FRAME_BYTES, MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits";

interface Channel {
  readonly frame: McpProgressData;
  readonly metadataBytes: number;
  readonly live: LiveChannel;
}

const earliest = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right);

interface LiveProgressOptions {
  readonly redactor: Redactor;
  readonly maxHeldMillis?: number;
  readonly now: () => number;
}

/**
 * Per-request live progress channels.
 *
 * The shared {@link createLiveChannel} owns every byte record's value layer,
 * piece chunking, and line hold, and every record's time-bounded line redactor.
 * This class owns only what is MCP-specific: provenance keying, metadata
 * redaction, the retained-byte budget, and delivery through `write`.
 */
export class LiveProgress {
  readonly #channels = new Map<string, Channel>();
  readonly #values: () => Iterable<string> | TieredRedactionValues;
  readonly #write: (frame: McpProgressData, profileChanged: boolean) => Effect.Effect<void>;
  readonly #redactor: Redactor;
  readonly #maxHeldMillis: number;
  readonly #now: () => number;
  #previousValues: Iterable<string> | TieredRedactionValues | undefined;
  #valueBytes = 0;

  constructor(
    values: () => Iterable<string> | TieredRedactionValues,
    write: (frame: McpProgressData, profileChanged: boolean) => Effect.Effect<void>,
    options: LiveProgressOptions,
  ) {
    this.#values = values;
    this.#write = write;
    this.#redactor = options.redactor;
    this.#maxHeldMillis = options.maxHeldMillis ?? LIVE_LINE_HOLD_MILLIS;
    this.#now = options.now;
  }

  #boundedValues = (additionalMetadataBytes?: number): Iterable<string> | TieredRedactionValues => {
    const values = this.#values();
    if (values !== this.#previousValues) {
      let bytes = 0;
      for (const value of "substring" in values ? [...values.substring, ...values.wholeToken] : values) {
        bytes += Buffer.byteLength(value, "utf8");
        if (bytes > MAX_OUTBOUND_QUEUED_BYTES)
          throw stdioTransportError("MCP live secret values exceeded the retained byte limit.");
      }
      this.#valueBytes = bytes;
      this.#previousValues = values;
    }
    let retained =
      additionalMetadataBytes === undefined
        ? 0
        : LIVE_PROGRESS_PIECE_BYTES + this.#valueBytes + additionalMetadataBytes;
    for (const state of this.#channels.values()) {
      retained +=
        LIVE_PROGRESS_PIECE_BYTES + this.#valueBytes + state.metadataBytes + state.live.retainedBytes();
    }
    if (retained > MAX_OUTBOUND_QUEUED_BYTES)
      throw stdioTransportError("MCP live progress channels exceeded the retained byte limit.");
    return values;
  };

  #newChannel = (frame: LiveProgressInput, metadataBytes: number): Channel => {
    const common = {
      redactor: this.#redactor,
      payloadValues: this.#boundedValues,
      timeBound: { maxHeldMillis: this.#maxHeldMillis, now: this.#now },
    };
    return {
      frame: {
        _tag: frame._tag,
        chunk: "",
        ...(frame.service === undefined ? {} : { service: frame.service }),
        ...(frame.source === undefined ? {} : { source: frame.source }),
      },
      metadataBytes,
      live:
        frame.kind === "record"
          ? createLiveChannel({ kind: "record", ...common })
          : createLiveChannel({ kind: "bytes", ...common }),
    };
  };

  #drain = Effect.fnUntraced(function* (this: LiveProgress, state: Channel) {
    while (state.live.queue.length > 0) {
      const delivered = state.live.queue[0];
      if (delivered === undefined) return;
      yield* this.#write({ ...state.frame, chunk: delivered.chunk }, delivered.changed);
      state.live.shift();
    }
  });

  /** End one channel (kind change or finish): release holds, then deliver. */
  #endChannel = Effect.fnUntraced(function* (this: LiveProgress, state: Channel) {
    state.live.end();
    yield* this.#drain(state);
  });

  deadline = (): number | undefined => {
    let deadline: number | undefined;
    for (const state of this.#channels.values()) deadline = earliest(deadline, state.live.deadline());
    return deadline;
  };

  expireDue = Effect.fnUntraced(function* (this: LiveProgress) {
    const nowMs = this.#now();
    for (const state of this.#channels.values()) {
      const deadline = state.live.deadline();
      if (deadline !== undefined && nowMs >= deadline) state.live.expire();
      yield* this.#drain(state);
    }
  });

  emit = Effect.fnUntraced(function* (this: LiveProgress, frame: LiveProgressInput) {
    const metadataBytes =
      Buffer.byteLength(frame.service ?? "", "utf8") + Buffer.byteLength(frame.source ?? "", "utf8");
    if (metadataBytes > MAX_FRAME_BYTES)
      throw stdioTransportError("MCP live progress metadata exceeded the frame byte limit.");
    const key = JSON.stringify([frame._tag, frame.service, frame.source]);
    const retainedMetadataBytes = 2 * Buffer.byteLength(key, "utf8");
    if (retainedMetadataBytes > MAX_FRAME_BYTES)
      throw stdioTransportError("MCP live progress metadata exceeded the frame byte limit.");
    const existing = this.#channels.get(key);
    if (existing !== undefined && existing.live.kind !== frame.kind) {
      yield* this.#endChannel(existing);
      this.#channels.delete(key);
    }
    let state = this.#channels.get(key);
    if (state === undefined) {
      if (this.#channels.size >= MAX_OUTBOUND_QUEUED_BYTES / LIVE_PROGRESS_PIECE_BYTES)
        throw stdioTransportError("MCP live progress exceeded the channel count limit.");
      this.#boundedValues(retainedMetadataBytes);
      state = this.#newChannel(frame, retainedMetadataBytes);
      this.#channels.set(key, state);
    }
    this.#boundedValues();
    if (frame.kind === "record") {
      if (state.live.kind !== "record") return;
      state.live.feed(frame.chunk);
      yield* this.#drain(state);
      return;
    }
    if (state.live.kind !== "bytes") return;
    for (const bytes of liveBytePieces(frame.chunk)) state.live.feed(bytes);
    yield* this.#drain(state);
  });

  flush = Effect.fnUntraced(function* (this: LiveProgress) {
    for (const [key, state] of this.#channels) {
      yield* this.#endChannel(state);
      if (state.live.queue.length === 0) this.#channels.delete(key);
    }
  });
}
