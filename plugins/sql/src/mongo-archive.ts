const MAX_BSON_SIZE = 16 * 1024 * 1024 + 64 * 1024;
const decoder = new TextDecoder();

// Archive headers contain strings, bools and integers, never collection BSON.
const readHeader = (bytes: Uint8Array) => {
  const fields = new Map<string, string | boolean | number>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 1;
  if (bytes[end] !== 0) return undefined;
  let offset = 4;
  while (offset < end) {
    const type = bytes[offset++];
    const keyEnd = bytes.indexOf(0, offset);
    if (keyEnd < offset || keyEnd >= end) return undefined;
    const key = decoder.decode(bytes.subarray(offset, keyEnd));
    if (fields.has(key)) return undefined;
    offset = keyEnd + 1;
    switch (type) {
      case 2: {
        if (offset + 4 > end) return undefined;
        const length = view.getInt32(offset, true);
        offset += 4;
        if (length < 1 || offset + length > end || bytes[offset + length - 1] !== 0) return undefined;
        fields.set(key, decoder.decode(bytes.subarray(offset, offset + length - 1)));
        offset += length;
        break;
      }
      case 8:
        if (offset >= end || (bytes[offset] !== 0 && bytes[offset] !== 1)) return undefined;
        fields.set(key, bytes[offset++] === 1);
        break;
      case 16:
      case 18: {
        const width = type === 16 ? 4 : 8;
        if (offset + width > end) return undefined;
        // CRC is an opaque int64: this tracker checks framing, not checksums.
        fields.set(key, 0);
        offset += width;
        break;
      }
      // Fields a newer mongodump may add are skipped by size, so they never read as truncation.
      case 1:
      case 9:
      case 17:
        if (offset + 8 > end) return undefined;
        offset += 8;
        break;
      case 10:
        break;
      case 3:
      case 4: {
        if (offset + 4 > end) return undefined;
        const length = view.getInt32(offset, true);
        if (length < 5 || offset + length > end) return undefined;
        offset += length;
        break;
      }
      default:
        return undefined;
    }
  }
  return offset === end ? fields : undefined;
};

/** Tracks plaintext mongodump --archive framing without retaining body documents.
 * See mongo-tools common/archive: Prelude.Write, Parser.ReadBlock,
 * Demultiplexer.End and Multiplexer.formatEOF. Every prelude namespace needs EOF,
 * including empty collections and views, and so does any namespace that opens a
 * block without a prelude entry. This does not verify document CRCs.
 */
export const makeMongoArchiveTracker = () => {
  let phase: "magic" | "header" | "prelude" | "namespace" | "body" = "magic";
  let valid = true;
  let eofBlock = false;
  const pending = new Set<string>();
  const aliases = new Map<string, string>();
  const prefix = new Uint8Array(4);
  const prefixView = new DataView(prefix.buffer);
  let prefixLength = 0;
  let remaining = 0;
  let document: Uint8Array | undefined;
  let documentOffset = 0;

  const finishHeader = (bytes: Uint8Array) => {
    const fields = readHeader(bytes);
    if (!fields) {
      valid = false;
      return;
    }
    if (phase === "header") {
      valid = typeof fields.get("version") === "string";
      phase = "prelude";
      return;
    }
    const db = fields.get("db");
    const collection = fields.get("collection");
    if (typeof db !== "string" || typeof collection !== "string" || collection.length === 0) {
      valid = false;
      return;
    }
    const namespace = `${db}.${collection}`;
    if (phase === "prelude") {
      pending.add(namespace);
      // Old servers dump timeseries under system.buckets; newer servers use the
      // logical collection. Both spellings close the same declared stream.
      if (fields.get("type") === "timeseries") aliases.set(`${db}.system.buckets.${collection}`, namespace);
      return;
    }
    const key = aliases.get(namespace) ?? namespace;
    const eof = fields.get("EOF");
    if (typeof eof !== "boolean") {
      valid = false;
      return;
    }
    eofBlock = eof;
    if (eof) pending.delete(key);
    else pending.add(key);
    phase = "body";
  };

  return {
    push(chunk: Uint8Array): void {
      let offset = 0;
      while (valid && offset < chunk.length) {
        if (remaining > 0) {
          const count = Math.min(remaining, chunk.length - offset);
          document?.set(chunk.subarray(offset, offset + count), documentOffset);
          documentOffset += count;
          remaining -= count;
          offset += count;
          if (remaining === 0) {
            if (document) finishHeader(document);
            else if (chunk[offset - 1] !== 0) valid = false;
            document = undefined;
          }
          continue;
        }
        const count = Math.min(4 - prefixLength, chunk.length - offset);
        prefix.set(chunk.subarray(offset, offset + count), prefixLength);
        prefixLength += count;
        offset += count;
        if (prefixLength < 4) continue;
        prefixLength = 0;
        if (phase === "magic") {
          valid = prefixView.getUint32(0, true) === 0x8199e26d;
          phase = "header";
          continue;
        }
        const length = prefixView.getInt32(0, true);
        if (length === -1) {
          valid = phase === "prelude" || phase === "body";
          phase = "namespace";
          continue;
        }
        if (length < 5 || length > MAX_BSON_SIZE || (phase === "body" && eofBlock)) {
          valid = false;
          continue;
        }
        remaining = length - 4;
        documentOffset = 4;
        if (phase !== "body") {
          document = new Uint8Array(length);
          document.set(prefix);
        }
      }
    },
    complete(): boolean {
      return valid && phase === "namespace" && prefixLength === 0 && remaining === 0 && pending.size === 0;
    },
  };
};
