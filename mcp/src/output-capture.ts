import { Buffer } from "node:buffer";
import { RedactionValues } from "@lando/redaction/service";
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
const emptyOutput = JSON.stringify({ chunks: [], truncated: false });
const OUTPUT_CHUNK_BUDGET =
  DEFAULT_OUTPUT_BYTES - Buffer.byteLength(emptyOutput, "utf8") - wireBytes(emptyOutput);

const hasClippedSecret = (prefix: Uint8Array, values: readonly Uint8Array[]): boolean => {
  if (prefix.length === 0) return false;
  const borders = new Uint32Array(prefix.length);
  for (let index = 1, matched = 0; index < prefix.length; index++) {
    while (matched > 0 && prefix[matched] !== prefix[index]) matched = borders[matched - 1] ?? 0;
    if (prefix[matched] === prefix[index]) matched++;
    borders[index] = matched;
  }
  for (const value of values) {
    let matched = 0;
    for (let index = 1; index < value.length; index++) {
      while (matched > 0 && (matched === prefix.length || prefix[matched] !== value[index])) {
        matched = borders[matched - 1] ?? 0;
      }
      if (prefix[matched] === value[index]) matched++;
    }
    if (matched > 0) return true;
  }
  return false;
};

export class OutputCapture {
  readonly #chunks: CommandOutputChunk[] = [];
  #bytes = 0;
  #truncated = false;
  readonly #values: () => Iterable<string>;
  #knownValues: RedactionValues | undefined;
  #resultValues = new RedactionValues();
  #prepared = false;
  #profileChanged = false;

  constructor(values: () => Iterable<string> = () => []) {
    this.#values = values;
  }

  append(chunk: CommandOutputChunk, originalText: string): void {
    if (this.#prepared) throw stdioTransportError("MCP final output capture is already finalized.");
    this.#knownValues ??= new RedactionValues([...this.#values(), ...this.#resultValues]);
    // Only retain the lost-context bit, never the pre-profile text, even after chunk eviction.
    this.#profileChanged ||= chunk.chunk !== originalText;
    this.#chunks.push(Object.freeze({ ...chunk }));
    this.#bytes += contribution(chunk);
    this.#fit(OUTPUT_CHUNK_BUDGET);
  }

  redactValues(values: readonly string[]): void {
    if (this.#prepared) throw stdioTransportError("MCP final output capture is already finalized.");
    this.#resultValues = new RedactionValues(values);
  }

  #prepare(redactor: Redactor): void {
    if (this.#prepared) return;
    this.#prepared = true;
    const values = Array.from(new RedactionValues([...this.#values(), ...this.#resultValues])).filter(
      (value) => value.length > 0,
    );
    const texts = new Map<string, string>();
    for (const frame of this.#chunks) {
      const key = JSON.stringify([frame._tag, frame.service, frame.source]);
      texts.set(key, (texts.get(key) ?? "") + frame.chunk);
    }
    const valueBytes = values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
    const lateValues = values.filter((value) => !this.#knownValues?.has(value));
    if (
      (this.#profileChanged && lateValues.length > 0) ||
      valueBytes * Math.max(1, texts.size) > MAX_OUTBOUND_QUEUED_BYTES
    ) {
      this.#chunks.length = 0;
      this.#bytes = 0;
      this.#truncated = true;
      return;
    }
    const encoder = new TextEncoder();
    const lateBytes = lateValues.map((value) => encoder.encode(value));
    const omitted = new Set<string>();
    if (this.#truncated && lateBytes.length > 0) {
      // Lost context can contain a newly classified credential prefix; never return its possible suffix.
      for (const [key, text] of texts) {
        if (hasClippedSecret(encoder.encode(text), lateBytes)) omitted.add(key);
      }
    }
    const original = this.#chunks.splice(0);
    const channels = new Map<
      string,
      {
        readonly payload: ReturnType<typeof createPayloadRedactor>;
        readonly decoder: TextDecoder;
        last: number;
      }
    >();
    for (const frame of original) {
      const key = JSON.stringify([frame._tag, frame.service, frame.source]);
      if (omitted.has(key)) continue;
      const state = channels.get(key) ?? {
        payload: createPayloadRedactor(() => values),
        decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
        last: this.#chunks.length,
      };
      channels.set(key, state);
      state.last = this.#chunks.length;
      this.#chunks.push({
        ...frame,
        chunk: state.decoder.decode(state.payload.write(encoder.encode(frame.chunk)), { stream: true }),
      });
    }
    for (const state of channels.values()) {
      const frame = this.#chunks[state.last];
      if (frame !== undefined)
        this.#chunks[state.last] = {
          ...frame,
          chunk: frame.chunk + state.decoder.decode(state.payload.flush()),
        };
    }
    for (let index = 0; index < this.#chunks.length; index++) {
      const frame = this.#chunks[index];
      if (frame === undefined) continue;
      this.#chunks[index] = Object.freeze({
        _tag: frame._tag,
        chunk: redactor.redactString(frame.chunk),
        ...(frame.service === undefined ? {} : { service: redactor.redactString(frame.service) }),
        ...(frame.source === undefined ? {} : { source: redactor.redactString(frame.source) }),
      });
    }
    this.#bytes = this.#chunks.reduce((sum, frame) => sum + contribution(frame), 0);
    this.#fit(OUTPUT_CHUNK_BUDGET);
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
    this.#prepare(redactor);
    return {
      chunks: this.#chunks.map((chunk) => ({ ...chunk })),
      truncated: this.#truncated,
    };
  }

  fitEnvelope(envelope: object, redactor: Redactor): object {
    this.#prepare(redactor);
    const base = {
      ...envelope,
      output: { chunks: [], truncated: this.#truncated || this.#chunks.length > 0 },
    };
    const responseBytes = (value: object): number => {
      const text = JSON.stringify(value);
      return wireBytes({ content: [{ type: "text", text }], structuredContent: value, isError: true });
    };
    const budget = MAX_OUTBOUND_QUEUED_BYTES - RESPONSE_RESERVATION_BYTES;
    this.#fit(Math.min(OUTPUT_CHUNK_BUDGET, Math.max(0, budget - responseBytes(base))));
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
