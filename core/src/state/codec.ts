// Encode/decode a bucket's payload to and from disk bytes. Two of the three
// codec kinds are StateStore-FRAMED: `json` writes a `{ version, data }` JSON
// envelope and `binary` writes a magic-header binary envelope, both stamping the
// bucket's schema version so `get` can detect a version mismatch and apply
// `onVersionMismatch`. The third kind, a CUSTOM codec, owns its whole on-disk
// format byte-for-byte (e.g. the include lockfile's block-style YAML): it has no
// version slot in the contract, so StateStore does not frame it and
// version-mismatch handling does not apply to custom-encoded files. Schema
// validation and corruption handling still wrap every codec.

import { Schema } from "effect";

import type { StateCodec } from "@lando/sdk/services";

/** Magic header for the binary envelope: `LSB1` + 4-byte big-endian version. */
const BINARY_MAGIC = new Uint8Array([0x4c, 0x53, 0x42, 0x31]); // "LSB1"
const BINARY_HEADER_LEN = BINARY_MAGIC.length + 4;

/** A decoded on-disk frame: the raw payload plus the version it was written at. */
export interface DecodedFrame {
  /** The encoded payload (codec-specific), still to be schema-decoded. */
  readonly payload: unknown;
  /**
   * The on-disk version, or `null` for a custom codec (which is unversioned and
   * therefore never triggers `onVersionMismatch`).
   */
  readonly version: number | null;
}

/** Thrown by the framed decoders when bytes are not a valid envelope. */
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

/** Encode the schema-encoded `data` to disk bytes for `kind`. */
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
  // json (default)
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
  // json (default)
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

/** True when a custom codec owns the whole file (unversioned, raw bytes). */
export const isCustomCodec = <A, I>(
  codec: StateCodec<A, I> | undefined,
): codec is { encode: (a: A) => string | Uint8Array; decode: (raw: Uint8Array) => A } =>
  codec !== undefined && typeof codec === "object";

/** Schema decode/encode helpers bound once per bucket. */
export const makeSchemaCodec = <A, I>(schema: Schema.Schema<A, I>) => ({
  decode: Schema.decodeUnknown(schema),
  encode: Schema.encode(schema),
});
