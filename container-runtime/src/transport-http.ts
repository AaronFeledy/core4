import type { Bytes, SocketHttpResponse } from "./transport.ts";
import { ContainerTransportError, type SocketHttpErrorKind } from "./transport-error.ts";

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export interface ParsedHttpHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyStart: Bytes;
}

export const headerSeparator: Bytes = textEncoder.encode("\r\n\r\n");
export const chunkSeparator: Bytes = textEncoder.encode("\r\n");

export const indexOfBytes = (haystack: Bytes, needle: Bytes): number => {
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
};

export const concatBytes = (chunks: ReadonlyArray<Bytes>): Bytes => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

export const fail = (
  kind: SocketHttpErrorKind,
  operation: string,
  message: string,
  details?: unknown,
  cause?: unknown,
): ContainerTransportError =>
  new ContainerTransportError({
    kind,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

export const parseHttpHead = (bytes: Bytes, operation = "container-transport"): ParsedHttpHead => {
  const marker = indexOfBytes(bytes, headerSeparator);
  if (marker === -1) {
    throw fail(
      "parse",
      operation,
      "Container runtime response did not include HTTP headers.",
      textDecoder.decode(bytes),
    );
  }

  const head = textDecoder.decode(bytes.slice(0, marker));
  const [statusLine, ...headerLines] = head.split("\r\n");
  const statusText = statusLine?.split(/\s+/u)[1];
  const status = statusText === undefined ? Number.NaN : Number.parseInt(statusText, 10);
  if (!Number.isInteger(status)) {
    throw fail("parse", operation, "Container runtime response did not include an HTTP status code.", head);
  }

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator !== -1) {
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
  }

  return { status, headers, bodyStart: bytes.slice(marker + headerSeparator.length) };
};

const headersRecord = (headers: ReadonlyMap<string, string>): Readonly<Record<string, string>> =>
  Object.fromEntries(headers);

export const socketResponse = (
  status: number,
  body: string,
  headers?: ReadonlyMap<string, string>,
): SocketHttpResponse =>
  headers === undefined || headers.size === 0
    ? { status, body }
    : { status, body, headers: headersRecord(headers) };

export const decodeChunkedBuffer = (
  buffer: Bytes,
): { readonly chunks: ReadonlyArray<Bytes>; readonly remainder: Bytes; readonly complete: boolean } => {
  const chunks: Bytes[] = [];
  let remaining: Bytes = buffer;

  while (true) {
    const sizeEnd = indexOfBytes(remaining, chunkSeparator);
    if (sizeEnd === -1) break;

    const size = Number.parseInt(textDecoder.decode(remaining.slice(0, sizeEnd)), 16);
    if (!Number.isInteger(size)) break;

    const chunkStart = sizeEnd + chunkSeparator.length;
    const chunkEnd = chunkStart + size;
    if (remaining.length < chunkEnd + chunkSeparator.length) break;

    if (size === 0) return { chunks, remainder: new Uint8Array(0) as Bytes, complete: true };

    chunks.push(remaining.slice(chunkStart, chunkEnd));
    remaining = remaining.slice(chunkEnd + chunkSeparator.length);
  }

  return { chunks, remainder: remaining, complete: false };
};

export const flushChunkedBufferAtEnd = (buffer: Bytes, allowPartial = false): ReadonlyArray<Bytes> => {
  const chunks: Bytes[] = [];
  let remaining: Bytes = buffer;

  while (true) {
    const sizeEnd = indexOfBytes(remaining, chunkSeparator);
    if (sizeEnd === -1) break;

    const size = Number.parseInt(textDecoder.decode(remaining.slice(0, sizeEnd)), 16);
    if (!Number.isInteger(size)) break;

    const chunkStart = sizeEnd + chunkSeparator.length;
    const chunkEnd = chunkStart + size;
    if (remaining.length < chunkEnd && !allowPartial) break;

    if (size === 0) return chunks;

    chunks.push(remaining.slice(chunkStart, chunkEnd));
    if (remaining.length < chunkEnd + chunkSeparator.length) break;

    remaining = remaining.slice(chunkEnd + chunkSeparator.length);
  }

  return chunks;
};

export async function* decodeChunkedBody(chunks: AsyncIterable<Bytes>): AsyncGenerator<Bytes> {
  let buffer: Bytes = new Uint8Array(0);
  for await (const chunk of chunks) {
    buffer = concatBytes([buffer, chunk]);
    while (true) {
      const decoded = decodeChunkedBuffer(buffer);
      for (const bodyChunk of decoded.chunks) yield bodyChunk;
      buffer = decoded.remainder;
      if (decoded.complete) return;
      if (decoded.chunks.length === 0) break;
    }
  }

  if (buffer.length > 0) {
    // Intentionally flush complete buffered chunks on EOF without a terminal zero chunk.
    // Valid chunked responses are unchanged, while truncated responses retain Podman's prior robustness.
    for (const bodyChunk of flushChunkedBufferAtEnd(buffer)) yield bodyChunk;
  }
}

export const collectBytes = async (chunks: AsyncIterable<Bytes>): Promise<Bytes> => {
  const collected: Bytes[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return concatBytes(collected);
};

const STREAM_ERROR_BODY_LIMIT = 64 * 1024;

export const readStreamErrorBody = async (
  head: ParsedHttpHead,
  chunks: AsyncIterable<Bytes>,
): Promise<string | undefined> => {
  const chunked = head.headers.get("transfer-encoding")?.toLowerCase() === "chunked";
  const lengthHeader = head.headers.get("content-length");
  const length = lengthHeader === undefined ? undefined : Number(lengthHeader);
  if (!chunked && (length === undefined || !Number.isSafeInteger(length) || length < 0)) return undefined;
  // Bound wire bytes as well as decoded bytes, including incomplete chunks and chunk metadata.
  const limit = chunked ? STREAM_ERROR_BODY_LIMIT : Math.min(length ?? 0, STREAM_ERROR_BODY_LIMIT);
  let buffer: Bytes = head.bodyStart.slice(0, limit);
  if (chunked) {
    const decoded = decodeChunkedBuffer(buffer);
    if (decoded.complete) return textDecoder.decode(concatBytes(decoded.chunks));
  }
  if (buffer.length < limit) {
    for await (const chunk of chunks) {
      buffer = concatBytes([buffer, chunk.slice(0, limit - buffer.length)]);
      if (chunked) {
        const decoded = decodeChunkedBuffer(buffer);
        if (decoded.complete) return textDecoder.decode(concatBytes(decoded.chunks));
      }
      if (buffer.length >= limit) break;
    }
  }
  return textDecoder.decode(chunked ? concatBytes(flushChunkedBufferAtEnd(buffer, true)) : buffer);
};
