import { Schema } from "effect";

import type { StateCodec } from "@lando/sdk/services";

const BINARY_MAGIC = new Uint8Array([0x4c, 0x53, 0x42, 0x31]); // "LSB1"
const BINARY_HEADER_LEN = BINARY_MAGIC.length + 4;

export interface DecodedFrame {
  readonly payload: unknown;
  /**
   * The on-disk version, or `null` for a custom codec (which is unversioned and
   * therefore never triggers `onVersionMismatch`).
   */
  readonly version: number | null;
}

export class FrameDecodeError extends Error {
  override readonly name = "FrameDecodeError";
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const writeUint32BE = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
};

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);

export const encodeFrame = <A, I>(
  codec: StateCodec<A, I> | undefined,
  version: number,
  data: I,
  value: A,
): string | Uint8Array => {
  if (codec !== undefined && typeof codec === "object") {
    return codec.encode(value);
  }
  if (codec === "binary") {
    const body = textEncoder.encode(JSON.stringify(data));
    const out = new Uint8Array(BINARY_HEADER_LEN + body.length);
    out.set(BINARY_MAGIC, 0);
    out.set(writeUint32BE(version), BINARY_MAGIC.length);
    out.set(body, BINARY_HEADER_LEN);
    return out;
  }
  return `${JSON.stringify({ version, data }, null, 2)}\n`;
};

/**
 * Decode raw disk bytes into a {@link DecodedFrame}. A custom codec decodes the
 * whole file and reports `version: null`; the framed codecs parse the envelope
 * and surface the stamped version. Malformed framed bytes throw
 * {@link FrameDecodeError} so the caller applies its corruption policy.
 */
export const decodeFrame = <A, I>(codec: StateCodec<A, I> | undefined, raw: Uint8Array): DecodedFrame => {
  if (codec !== undefined && typeof codec === "object") {
    return { payload: codec.decode(raw), version: null };
  }
  if (codec === "binary") {
    if (raw.length < BINARY_HEADER_LEN) throw new FrameDecodeError("Binary state envelope is truncated.");
    for (let i = 0; i < BINARY_MAGIC.length; i += 1) {
      if (raw[i] !== BINARY_MAGIC[i]) throw new FrameDecodeError("Binary state envelope magic mismatch.");
    }
    const version = readUint32BE(raw, BINARY_MAGIC.length);
    const body = raw.subarray(BINARY_HEADER_LEN);
    let payload: unknown;
    try {
      payload = JSON.parse(textDecoder.decode(body));
    } catch (cause) {
      throw new FrameDecodeError(`Binary state payload is not valid JSON: ${String(cause)}`);
    }
    return { payload, version };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(textDecoder.decode(raw));
  } catch (cause) {
    throw new FrameDecodeError(`State envelope is not valid JSON: ${String(cause)}`);
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    typeof (envelope as { version?: unknown }).version !== "number" ||
    !("data" in envelope)
  ) {
    throw new FrameDecodeError("Malformed state envelope.");
  }
  const { version, data } = envelope as { version: number; data: unknown };
  return { payload: data, version };
};

export const isCustomCodec = <A, I>(
  codec: StateCodec<A, I> | undefined,
): codec is { encode: (a: A) => string | Uint8Array; decode: (raw: Uint8Array) => A } =>
  codec !== undefined && typeof codec === "object";

export const makeSchemaCodec = <A, I>(schema: Schema.Schema<A, I>) => ({
  decode: Schema.decodeUnknown(schema),
  encode: Schema.encode(schema),
});
