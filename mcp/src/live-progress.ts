import { Buffer } from "node:buffer";
import { type PayloadRedactor, createPayloadRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { LIVE_PROGRESS_PIECE_BYTES, type LiveProgressInput, liveBytePieces } from "./live-progress-input";
import type { McpProgressData } from "./result-inspector";
import { MAX_FRAME_BYTES, MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits";

interface Channel {
  readonly frame: McpProgressData;
  readonly payload: PayloadRedactor;
  readonly decoder: TextDecoder;
  readonly metadataBytes: number;
  pending: Uint8Array;
}

export class LiveProgress {
  readonly #channels = new Map<string, Channel>();
  readonly #values: () => Iterable<string>;
  readonly #write: (frame: McpProgressData) => Effect.Effect<void>;
  #previousValues: Iterable<string> | undefined;
  #valueBytes = 0;

  constructor(values: () => Iterable<string>, write: (frame: McpProgressData) => Effect.Effect<void>) {
    this.#values = values;
    this.#write = write;
  }

  #boundedValues = (additionalMetadataBytes?: number): Iterable<string> => {
    const values = this.#values();
    if (values !== this.#previousValues) {
      let bytes = 0;
      for (const value of values) {
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
      retained += LIVE_PROGRESS_PIECE_BYTES + this.#valueBytes + state.metadataBytes;
    }
    if (retained > MAX_OUTBOUND_QUEUED_BYTES)
      throw stdioTransportError("MCP live progress channels exceeded the retained byte limit.");
    return values;
  };

  #deliver = Effect.fnUntraced(function* (
    this: LiveProgress,
    state: Channel,
    bytes: Uint8Array,
    final = false,
  ) {
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = Math.min(
        bytes.length,
        offset + LIVE_PROGRESS_PIECE_BYTES - state.pending.length,
        newline < 0 ? bytes.length : newline + 1,
      );
      const pending = new Uint8Array(state.pending.length + end - offset);
      pending.set(state.pending);
      pending.set(bytes.subarray(offset, end), state.pending.length);
      state.pending = pending;
      offset = end;
      if (pending.length === LIVE_PROGRESS_PIECE_BYTES || pending.at(-1) === 10) {
        state.pending = new Uint8Array(0);
        const chunk = state.decoder.decode(pending, { stream: true });
        if (chunk.length > 0) yield* this.#write({ ...state.frame, chunk });
      }
    }
    if (final) {
      const pending = state.pending;
      state.pending = new Uint8Array(0);
      const chunk = state.decoder.decode(pending);
      if (chunk.length > 0) yield* this.#write({ ...state.frame, chunk });
    }
  });

  #drain = Effect.fnUntraced(function* (this: LiveProgress, key: string, state: Channel) {
    const tail = state.payload.flush();
    this.#channels.delete(key);
    yield* this.#deliver(state, tail, true);
  });

  emit = Effect.fnUntraced(function* (this: LiveProgress, frame: LiveProgressInput) {
    const metadata = {
      _tag: frame._tag,
      chunk: "",
      ...(frame.service === undefined ? {} : { service: frame.service }),
      ...(frame.source === undefined ? {} : { source: frame.source }),
    };
    const metadataBytes =
      Buffer.byteLength(frame.service ?? "", "utf8") + Buffer.byteLength(frame.source ?? "", "utf8");
    if (metadataBytes > MAX_FRAME_BYTES)
      throw stdioTransportError("MCP live progress metadata exceeded the frame byte limit.");
    const key = JSON.stringify([frame._tag, frame.service, frame.source]);
    const retainedMetadataBytes = 2 * Buffer.byteLength(key, "utf8");
    if (retainedMetadataBytes > MAX_FRAME_BYTES)
      throw stdioTransportError("MCP live progress metadata exceeded the frame byte limit.");
    let state = this.#channels.get(key);
    if (frame.kind === "record") {
      if (state !== undefined) yield* this.#drain(key, state);
      state = undefined;
    }
    if (state === undefined) {
      if (this.#channels.size >= MAX_OUTBOUND_QUEUED_BYTES / LIVE_PROGRESS_PIECE_BYTES)
        throw stdioTransportError("MCP live progress exceeded the channel count limit.");
      this.#boundedValues(retainedMetadataBytes);
      state = {
        frame: metadata,
        metadataBytes: retainedMetadataBytes,
        payload: createPayloadRedactor(this.#boundedValues),
        decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
        pending: new Uint8Array(0),
      };
      this.#channels.set(key, state);
    }
    this.#boundedValues();
    for (const bytes of liveBytePieces(frame.kind === "record" ? `${frame.chunk}\n` : frame.chunk)) {
      yield* this.#deliver(state, state.payload.write(bytes));
    }
    if (frame.kind === "record") yield* this.#drain(key, state);
  });

  flush = Effect.fnUntraced(function* (this: LiveProgress) {
    for (const [key, state] of this.#channels) yield* this.#drain(key, state);
  });
}
