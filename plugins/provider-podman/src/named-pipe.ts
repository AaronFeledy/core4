import { createConnection } from "node:net";

import { Effect, Stream } from "effect";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "@lando/provider-lando";
import { ProviderCapabilityError, ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";

const PROVIDER_ID = "podman";
const textDecoder = new TextDecoder();
type Bytes = Uint8Array<ArrayBufferLike>;

const requestBody = (request: PodmanHttpRequest): string | undefined =>
  request.body === undefined ? undefined : JSON.stringify(request.body);

const podmanHttpRequestText = (request: PodmanHttpRequest, body: string | undefined): string => {
  const headers = [
    `${request.method} /v5.0.0${request.path} HTTP/1.1`,
    "Host: localhost",
    "Connection: close",
  ];
  if (body !== undefined) {
    headers.push(
      "Content-Type: application/json",
      `Content-Length: ${new TextEncoder().encode(body).length}`,
    );
  }
  return `${headers.join("\r\n")}\r\n\r\n${body ?? ""}`;
};

const headerSeparator: Bytes = new TextEncoder().encode("\r\n\r\n");
const chunkSeparator: Bytes = new TextEncoder().encode("\r\n");

const unavailable = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const internal = (operation: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId: PROVIDER_ID,
    operation,
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const podmanApiFailure = (
  request: PodmanHttpRequest,
  cause: unknown,
): ProviderUnavailableError | ProviderInternalError =>
  cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
    ? cause
    : unavailable("podman-api", "Failed to call the Podman API.", {
        method: request.method,
        path: request.path,
        cause,
      });

const indexOfBytes = (haystack: Bytes, needle: Bytes): number => {
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

const concatBytes = (chunks: ReadonlyArray<Bytes>): Bytes => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

interface ParsedPodmanHttpHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyStart: Bytes;
}

const parsePodmanHttpHead = (bytes: Bytes): ParsedPodmanHttpHead => {
  const marker = indexOfBytes(bytes, headerSeparator);
  if (marker === -1) {
    throw internal(
      "podman-api",
      "Podman API response did not include HTTP headers.",
      textDecoder.decode(bytes),
    );
  }
  const head = textDecoder.decode(bytes.slice(0, marker));
  const [statusLine, ...headerLines] = head.split("\r\n");
  const statusText = statusLine?.split(/\s+/u)[1];
  const status = statusText === undefined ? Number.NaN : Number.parseInt(statusText, 10);
  if (!Number.isInteger(status)) {
    throw internal("podman-api", "Podman API response did not include an HTTP status code.", head);
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

const decodeChunkedBuffer = (
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

async function* decodeChunkedBody(chunks: AsyncIterable<Bytes>): AsyncGenerator<Bytes> {
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
}

export const flushChunkedBufferAtEnd = (buffer: Bytes): ReadonlyArray<Bytes> => {
  const chunks: Bytes[] = [];
  let remaining: Bytes = buffer;

  while (true) {
    const sizeEnd = indexOfBytes(remaining, chunkSeparator);
    if (sizeEnd === -1) break;

    const size = Number.parseInt(textDecoder.decode(remaining.slice(0, sizeEnd)), 16);
    if (!Number.isInteger(size)) break;

    const chunkStart = sizeEnd + chunkSeparator.length;
    const chunkEnd = chunkStart + size;
    if (remaining.length < chunkEnd) break;

    if (size === 0) return chunks;

    chunks.push(remaining.slice(chunkStart, chunkEnd));
    if (remaining.length < chunkEnd + chunkSeparator.length) break;

    remaining = remaining.slice(chunkEnd + chunkSeparator.length);
  }

  return chunks;
};

export const npipeSocketPath = (socketPath: string): string => {
  if (!socketPath.startsWith("npipe:")) return socketPath;
  const pipePath = socketPath.slice("npipe:".length);
  const podmanDesktopPipe = pipePath.match(/^\/{2,4}\.\/pipe\/(.+)$/u);
  if (podmanDesktopPipe !== null) {
    return `\\\\.\\pipe\\${(podmanDesktopPipe[1] ?? "").replaceAll("/", "\\")}`;
  }
  return pipePath;
};

async function* streamNamedPipePodmanRequest(
  pipePath: string,
  request: PodmanHttpRequest,
): AsyncGenerator<Bytes> {
  const socket = createConnection({ path: pipePath });
  const body = requestBody(request);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const initialChunks: Bytes[] = [];
  socket.write(podmanHttpRequestText(request, body));

  try {
    let parsed: ParsedPodmanHttpHead | undefined;
    let chunkedBody = false;
    let bodyBuffer: Bytes = new Uint8Array(0) as Bytes;

    for await (const chunk of socket) {
      if (parsed === undefined) {
        initialChunks.push(chunk);
        const merged = concatBytes(initialChunks);
        if (indexOfBytes(merged, headerSeparator) === -1) continue;
        parsed = parsePodmanHttpHead(merged);
        if (parsed.status < 200 || parsed.status >= 300) {
          throw unavailable(
            "podman-api",
            `Podman API stream request failed with HTTP ${parsed.status}.`,
            request,
          );
        }
        chunkedBody = parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked";
        if (chunkedBody) {
          bodyBuffer = parsed.bodyStart;
          const decoded = decodeChunkedBuffer(bodyBuffer);
          for (const bodyChunk of decoded.chunks) yield bodyChunk;
          bodyBuffer = decoded.remainder;
          if (decoded.complete) return;
        } else if (parsed.bodyStart.length > 0) {
          yield parsed.bodyStart;
        }
        continue;
      }

      if (chunkedBody) {
        bodyBuffer = concatBytes([bodyBuffer, chunk]);
        const decoded = decodeChunkedBuffer(bodyBuffer);
        for (const bodyChunk of decoded.chunks) yield bodyChunk;
        bodyBuffer = decoded.remainder;
        if (decoded.complete) return;
        continue;
      }

      yield chunk;
    }

    if (parsed === undefined) {
      throw internal("podman-api", "Podman API stream response ended before HTTP headers.", request);
    }
    if (chunkedBody && bodyBuffer.length > 0) {
      for (const bodyChunk of flushChunkedBufferAtEnd(bodyBuffer)) yield bodyChunk;
    }
  } finally {
    socket.destroy();
  }
}

const collectBytes = async (chunks: AsyncIterable<Bytes>): Promise<Bytes> => {
  const collected: Bytes[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return concatBytes(collected);
};

const requestNamedPipePodman = async (
  pipePath: string,
  request: PodmanHttpRequest,
): Promise<PodmanHttpResponse> => {
  const socket = createConnection({ path: pipePath });
  const body = requestBody(request);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(podmanHttpRequestText(request, body));
  try {
    const responseBytes = await collectBytes(socket);
    const parsed = parsePodmanHttpHead(responseBytes);
    const bodyBytes =
      parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked"
        ? await collectBytes(
            decodeChunkedBody(
              (async function* () {
                yield parsed.bodyStart;
              })(),
            ),
          )
        : parsed.bodyStart;
    return { status: parsed.status, body: textDecoder.decode(bodyBytes) };
  } finally {
    socket.destroy();
  }
};

export const makeNamedPipePodmanApiClient = (socketPath: string): PodmanApiClient => {
  const pipePath = npipeSocketPath(socketPath);
  return {
    stream: (request) =>
      Stream.fromAsyncIterable(streamNamedPipePodmanRequest(pipePath, request), (cause) =>
        podmanApiFailure(request, cause),
      ),
    request: (request) =>
      Effect.tryPromise({
        try: () => requestNamedPipePodman(pipePath, request),
        catch: (cause) => podmanApiFailure(request, cause),
      }),
    info: Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => requestNamedPipePodman(pipePath, { method: "GET", path: "/libpod/info" }),
        catch: (cause) =>
          cause instanceof ProviderUnavailableError
            ? cause
            : new ProviderCapabilityError({
                providerId: PROVIDER_ID,
                operation: "capabilities",
                message: "Failed to inspect provider-podman capabilities through the Podman API.",
                capability: "podman-info",
                requiredValue: "Podman HTTP API info response",
                actualValue: undefined,
                cause,
              }),
      });
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.fail(
          unavailable("capabilities", `Podman info failed with HTTP ${response.status}.`, response),
        );
      }
      return yield* Effect.try({
        try: () => (response.body.length === 0 ? {} : (JSON.parse(response.body) as unknown)),
        catch: (cause) =>
          new ProviderCapabilityError({
            providerId: PROVIDER_ID,
            operation: "capabilities",
            message: "Podman API returned malformed JSON — could not parse info response.",
            capability: "podman-info",
            requiredValue: "valid JSON Podman API info response",
            actualValue: response.body,
            cause,
          }),
      });
    }),
  };
};
