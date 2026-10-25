import { Buffer } from "node:buffer";
import type { CommandOutput, CommandOutputChunk } from "@lando/sdk/schema";
import { type Redactor, createPayloadRedactor } from "@lando/sdk/secrets";
import { MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits";

export const DEFAULT_OUTPUT_BYTES = 128 * 1024;
const RESPONSE_RESERVATION_BYTES = 1024 * 1024;
const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const contribution = (chunk: CommandOutputChunk): number => {
  const encoded = JSON.stringify(chunk);
  return Buffer.byteLength(encoded, "utf8") + wireBytes(encoded) + 4;
};

export class OutputCapture {
  readonly #chunks: CommandOutputChunk[] = [];
  #bytes = 0;
  #truncated = false;

  append(chunk: CommandOutputChunk): void {
    this.#chunks.push(Object.freeze({ ...chunk }));
    this.#bytes += contribution(chunk);
    this.#fit(DEFAULT_OUTPUT_BYTES);
  }

  redactValues(values: readonly string[]): void {
    if (values.length === 0) return;
    const channels = new Map<
      string,
      {
        readonly payload: ReturnType<typeof createPayloadRedactor>;
        readonly decoder: TextDecoder;
        last: number;
      }
    >();
    const encoder = new TextEncoder();
    for (let index = 0; index < this.#chunks.length; index++) {
      const frame = this.#chunks[index];
      if (frame === undefined) continue;
      const key = JSON.stringify([frame._tag, frame.service, frame.source]);
      const state = channels.get(key) ?? {
        payload: createPayloadRedactor(() => values),
        decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
        last: index,
      };
      channels.set(key, state);
      state.last = index;
      this.#chunks[index] = Object.freeze({
        ...frame,
        chunk: state.decoder.decode(state.payload.write(encoder.encode(frame.chunk)), { stream: true }),
      });
    }
    for (const state of channels.values()) {
      const frame = this.#chunks[state.last];
      if (frame !== undefined)
        this.#chunks[state.last] = Object.freeze({
          ...frame,
          chunk: frame.chunk + state.decoder.decode(state.payload.flush()),
        });
    }
    this.#bytes = this.#chunks.reduce((sum, frame) => sum + contribution(frame), 0);
    this.#fit(DEFAULT_OUTPUT_BYTES);
  }

  #fit(budget: number): void {
    while (this.#bytes > budget && this.#chunks.length > 0) {
      const first = this.#chunks.shift();
      if (first === undefined) break;
      this.#bytes -= contribution(first);
      this.#truncated = true;
      const available = budget - this.#bytes;
      if (available <= contribution({ ...first, chunk: "" })) continue;
      let low = 0;
      let high = first.chunk.length;
      let retained: CommandOutputChunk | undefined;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        let start = first.chunk.length - length;
        const unit = first.chunk.charCodeAt(start);
        if (start > 0 && unit >= 0xdc00 && unit <= 0xdfff) start++;
        const candidate = { ...first, chunk: first.chunk.slice(start) };
        if (contribution(candidate) <= available) {
          retained = candidate;
          low = length + 1;
        } else high = length - 1;
      }
      if (retained !== undefined && retained.chunk.length > 0) {
        this.#chunks.unshift(Object.freeze(retained));
        this.#bytes += contribution(retained);
      }
    }
  }

  snapshot(redactor: Redactor): CommandOutput {
    return {
      chunks: this.#chunks.map((chunk) => ({
        _tag: chunk._tag,
        chunk: redactor.redactString(chunk.chunk),
        ...(chunk.service === undefined ? {} : { service: redactor.redactString(chunk.service) }),
        ...(chunk.source === undefined ? {} : { source: redactor.redactString(chunk.source) }),
      })),
      truncated: this.#truncated,
    };
  }

  fitEnvelope(envelope: object, redactor: Redactor): object {
    const base = {
      ...envelope,
      output: { chunks: [], truncated: this.#truncated || this.#chunks.length > 0 },
    };
    const responseBytes = (value: object): number => {
      const text = JSON.stringify(value);
      return wireBytes({ content: [{ type: "text", text }], structuredContent: value, isError: true });
    };
    const budget = MAX_OUTBOUND_QUEUED_BYTES - RESPONSE_RESERVATION_BYTES;
    this.#fit(Math.min(DEFAULT_OUTPUT_BYTES, Math.max(0, budget - responseBytes(base))));
    let value = { ...envelope, output: this.snapshot(redactor) };
    while (responseBytes(value) > budget && this.#chunks.length > 0) {
      this.#fit(Math.max(0, this.#bytes - (responseBytes(value) - budget) - 128));
      value = { ...envelope, output: this.snapshot(redactor) };
    }
    if (responseBytes(value) > budget)
      throw stdioTransportError("MCP typed result exceeds the complete response byte budget.");
    return value;
  }
}
