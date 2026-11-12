export { socketHttpConnection } from "./socket-http-connection.ts";
export { connectSocket } from "./transport-connection.ts";
export {
  ContainerTransportError,
  type SocketHttpErrorKind,
  type SocketReadSystemCode,
  runtimeRemediation,
} from "./transport-error.ts";
export {
  concatBytes,
  decodeChunkedBody,
  decodeChunkedBuffer,
  flushChunkedBufferAtEnd,
  indexOfBytes,
  parseHttpHead,
} from "./transport-http.ts";
export { socketHttpRequestText } from "./transport-request.ts";

import { connect, readResponse } from "./transport-connection.ts";
import {
  type ParsedHttpHead,
  collectBytes,
  concatBytes,
  decodeChunkedBuffer,
  fail,
  flushChunkedBufferAtEnd,
  headerSeparator,
  indexOfBytes,
  parseHttpHead,
  readStreamErrorBody,
  socketResponse,
  textDecoder,
} from "./transport-http.ts";
import { writeRequest } from "./transport-request.ts";
import { streamUpload } from "./transport-upload.ts";

export type Bytes = Uint8Array<ArrayBufferLike>;

export interface SocketHttpRequest {
  readonly method: string;
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Bytes>;
  /**
   * Ordinary HTTP request body written while the response is read. Mutually exclusive with `body` and
   * `stdin`; sent with a single `Content-Length` header and without upgrade headers. Use it when the
   * daemon streams a response for a request that carries a body.
   */
  readonly upload?: AsyncIterable<Bytes>;
  /** Called after successful stream response headers arrive, before body bytes are emitted. */
  readonly onResponseHead?: () => void;
}

export interface SocketHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SocketHttpConnection extends AsyncIterable<Bytes> {
  write(data: string | Uint8Array): void | Promise<void>;
  end(): void;
  destroy(): void;
}

export interface ConnectableSocket {
  once(event: "connect", listener: () => void): unknown;
  once(event: "error", listener: (cause: Error) => void): unknown;
  off(event: "connect", listener: () => void): unknown;
  off(event: "error", listener: (cause: Error) => void): unknown;
  destroy(): unknown;
}

export interface SocketHttpClientOptions {
  readonly connect: (signal?: AbortSignal) => Promise<SocketHttpConnection>;
  readonly apiPrefix: string;
  readonly hostHeader?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly operation?: string;
}

export interface SocketHttpClient {
  readonly request: (request: SocketHttpRequest) => Promise<SocketHttpResponse>;
  readonly stream: (request: SocketHttpRequest) => AsyncGenerator<Bytes>;
}

export const makeSocketHttpClient = (options: SocketHttpClientOptions): SocketHttpClient => {
  const operation = options.operation ?? "container-transport";

  const request = async (input: SocketHttpRequest): Promise<SocketHttpResponse> => {
    // Buffer stdin before connecting so a failed upload leaves no socket behind.
    const stdinPayload = input.stdin === undefined ? undefined : await collectBytes(input.stdin);
    if (input.signal?.aborted) throw new DOMException("Socket request aborted.", "AbortError");
    const connection = await connect(options, input);
    const abort = () => connection.destroy();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal?.aborted) throw new DOMException("Socket request aborted.", "AbortError");
      await writeRequest(connection, input, options, stdinPayload);
      let headBuffer: Bytes = new Uint8Array(0);
      let parsed: ParsedHttpHead | undefined;
      let contentLength: number | undefined;
      let chunked = false;
      let bodyBuffer: Bytes = new Uint8Array(0);
      const bodyChunks: Bytes[] = [];
      let receivedBodyBytes = 0;

      for await (const chunk of connection) {
        let next = chunk;
        if (parsed === undefined) {
          headBuffer = concatBytes([headBuffer, chunk]);
          if (indexOfBytes(headBuffer, headerSeparator) === -1) continue;
          parsed = parseHttpHead(headBuffer, operation);
          if (
            input.method.toUpperCase() === "HEAD" ||
            parsed.status === 204 ||
            parsed.status === 205 ||
            parsed.status === 304
          ) {
            return socketResponse(parsed.status, "", parsed.headers);
          }
          next = parsed.bodyStart;
          chunked = parsed.headers.get("transfer-encoding")?.toLowerCase().includes("chunked") ?? false;
          const lengthHeader = parsed.headers.get("content-length");
          if (lengthHeader !== undefined) {
            contentLength = Number(lengthHeader);
            if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
              throw fail(
                "parse",
                operation,
                "Container runtime response has invalid Content-Length.",
                lengthHeader,
              );
            }
          }
        }
        if (chunked) {
          bodyBuffer = concatBytes([bodyBuffer, next]);
          const decoded = decodeChunkedBuffer(bodyBuffer);
          bodyChunks.push(...decoded.chunks);
          bodyBuffer = decoded.remainder;
          if (decoded.complete)
            return socketResponse(parsed.status, textDecoder.decode(concatBytes(bodyChunks)), parsed.headers);
        } else {
          bodyChunks.push(next);
          receivedBodyBytes += next.length;
          if (contentLength !== undefined && receivedBodyBytes >= contentLength) {
            const body = concatBytes(bodyChunks);
            return socketResponse(
              parsed.status,
              textDecoder.decode(body.slice(0, contentLength)),
              parsed.headers,
            );
          }
        }
      }
      if (input.signal?.aborted) throw new DOMException("Socket request aborted.", "AbortError");
      if (parsed === undefined) {
        throw fail("parse", operation, "Container runtime response ended before HTTP headers.");
      }
      if (chunked && bodyBuffer.length > 0) bodyChunks.push(...flushChunkedBufferAtEnd(bodyBuffer));
      const body = concatBytes(bodyChunks);
      if (contentLength !== undefined && body.length < contentLength) {
        throw fail(
          "parse",
          operation,
          "Container runtime response ended before Content-Length bytes arrived.",
        );
      }
      return socketResponse(parsed.status, textDecoder.decode(body), parsed.headers);
    } finally {
      input.signal?.removeEventListener("abort", abort);
      connection.destroy();
    }
  };

  async function* stream(input: SocketHttpRequest): AsyncGenerator<Bytes> {
    if (input.upload !== undefined) {
      yield* streamUpload(options, operation, input, input.upload);
      return;
    }
    const connection = await connect(options, input);
    const hasConnectionHeader = Object.keys(input.headers ?? {}).some(
      (key) => key.toLowerCase() === "connection",
    );
    const request =
      input.stdin === undefined || hasConnectionHeader
        ? input
        : { ...input, headers: { ...input.headers, Connection: "Upgrade", Upgrade: "tcp" } };
    let stdinPump: Promise<void> | undefined;
    let stdinIterator: AsyncIterator<Bytes> | undefined;
    let stdinReady = false;
    let stdinExhausted = false;
    let stopStdinPump: (() => void) | undefined;
    const stdinStopped = new Promise<void>((resolve) => {
      stopStdinPump = resolve;
    });
    const ready = Promise.withResolvers<void>();
    const abort = () => connection.destroy();
    input.signal?.addEventListener("abort", abort, { once: true });
    const maybeEndStdin = (): void => {
      if (stdinReady && stdinExhausted) connection.end();
    };
    const flushStdin = (): void => {
      stdinReady = true;
      ready.resolve();
      maybeEndStdin();
    };
    const startStdinPump = () => {
      if (input.stdin === undefined || stdinPump !== undefined) return;
      const iterator = input.stdin[Symbol.asyncIterator]();
      stdinIterator = iterator;
      stdinPump = (async () => {
        while (true) {
          const outcome = await Promise.race([
            iterator.next().then((next) => ({ kind: "next", next }) as const),
            stdinStopped.then(() => ({ kind: "stopped" }) as const),
          ]);
          if (outcome.kind === "stopped") return;
          const next = outcome.next;
          if (next.done === true) {
            stdinExhausted = true;
            maybeEndStdin();
            return;
          }
          const attached = await Promise.race([
            ready.promise.then(() => true),
            stdinStopped.then(() => false),
          ]);
          if (!attached) return;
          await Promise.race([connection.write(next.value), stdinStopped]);
        }
      })();
      stdinPump.catch(() => connection.destroy());
    };
    try {
      await writeRequest(connection, request, options);
      startStdinPump();
      const initialChunks: Bytes[] = [];
      let parsed: ParsedHttpHead | undefined;
      let chunkedBody = false;
      let bodyBuffer: Bytes = new Uint8Array(0) as Bytes;

      const response = readResponse(connection, operation, input);
      for await (const chunk of response) {
        if (parsed === undefined) {
          initialChunks.push(chunk);
          const merged = concatBytes(initialChunks);
          if (indexOfBytes(merged, headerSeparator) === -1) continue;
          parsed = parseHttpHead(merged, operation);
          if (parsed.status !== 101 && (parsed.status < 200 || parsed.status >= 300)) {
            // Hijacked and unframed errors must not wait for an engine-held socket to close.
            const upgraded = [...Object.entries(request.headers ?? {}), ...parsed.headers].some(
              ([key, value]) =>
                key.toLowerCase() === "upgrade" ||
                (key.toLowerCase() === "connection" &&
                  value
                    .toLowerCase()
                    .split(/\s*,\s*/u)
                    .includes("upgrade")),
            );
            const body = upgraded ? undefined : await readStreamErrorBody(parsed, response);
            throw fail(
              "http",
              operation,
              `Container runtime stream request failed with HTTP ${parsed.status}.`,
              {
                method: input.method,
                path: input.path,
                status: parsed.status,
                ...(body === undefined ? {} : { body }),
              },
            );
          }
          input.onResponseHead?.();
          flushStdin();
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
        throw fail("parse", operation, "Container runtime stream response ended before HTTP headers.", {
          method: input.method,
          path: input.path,
        });
      }
      if (chunkedBody && bodyBuffer.length > 0) {
        for (const bodyChunk of flushChunkedBufferAtEnd(bodyBuffer)) yield bodyChunk;
      }
      if (input.signal?.aborted) throw new DOMException("Socket stream aborted.", "AbortError");
    } catch (cause) {
      // Socket implementations vary: abort may end iteration, throw a generic
      // close error, or throw AbortError. Give callers one cancellation signal.
      if (input.signal?.aborted) throw new DOMException("Socket stream aborted.", "AbortError");
      throw cause;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      stopStdinPump?.();
      await stdinPump?.catch(() => undefined);
      void stdinIterator?.return?.().catch(() => undefined);
      connection.destroy();
    }
  }

  return { request, stream };
};

export const normalizeNamedPipePath = (socketPath: string): string => {
  if (!socketPath.startsWith("npipe:")) return socketPath;
  const pipePath = socketPath.slice("npipe:".length);
  const desktopPipe = pipePath.match(/^\/{2,4}\.\/pipe\/(.+)$/u);
  if (desktopPipe !== null) {
    return `\\\\.\\pipe\\${(desktopPipe[1] ?? "").replaceAll("/", "\\")}`;
  }
  return pipePath;
};
