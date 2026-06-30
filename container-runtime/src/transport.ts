const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type Bytes = Uint8Array<ArrayBufferLike>;

export interface SocketHttpRequest {
  readonly method: string;
  readonly path: `/${string}`;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: AsyncIterable<Bytes>;
}

export interface SocketHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface SocketHttpConnection extends AsyncIterable<Bytes> {
  write(data: string | Uint8Array): void;
  destroy(): void;
}

export type SocketHttpErrorKind = "connect" | "write" | "parse" | "http";

export class ContainerTransportError extends Error {
  readonly _tag = "ContainerTransportError";
  readonly kind: SocketHttpErrorKind;
  readonly operation: string;
  readonly details?: unknown;

  constructor(input: {
    readonly kind: SocketHttpErrorKind;
    readonly operation: string;
    readonly message: string;
    readonly details?: unknown;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "ContainerTransportError";
    this.kind = input.kind;
    this.operation = input.operation;
    if (input.details !== undefined) this.details = input.details;
    if (input.cause !== undefined) (this as { cause?: unknown }).cause = input.cause;
  }
}

export interface ConnectableSocket {
  once(event: "connect", listener: () => void): unknown;
  once(event: "error", listener: (cause: Error) => void): unknown;
  off(event: "connect", listener: () => void): unknown;
  off(event: "error", listener: (cause: Error) => void): unknown;
  destroy(): unknown;
}

export const connectSocket = async (socket: ConnectableSocket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (cause: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      reject(cause);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
};

export interface SocketHttpClientOptions {
  readonly connect: () => Promise<SocketHttpConnection>;
  readonly apiPrefix: string;
  readonly hostHeader?: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly operation?: string;
  readonly mapTransportError?: (cause: unknown) => unknown;
}

export interface SocketHttpClient {
  readonly request: (request: SocketHttpRequest) => Promise<SocketHttpResponse>;
  readonly stream: (request: SocketHttpRequest) => AsyncGenerator<Bytes>;
}

interface ParsedHttpHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyStart: Bytes;
}

const headerSeparator: Bytes = textEncoder.encode("\r\n\r\n");
const chunkSeparator: Bytes = textEncoder.encode("\r\n");

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

const fail = (
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

const mapError = (options: SocketHttpClientOptions, cause: unknown): unknown =>
  options.mapTransportError === undefined ? cause : options.mapTransportError(cause);

const requestBody = (request: SocketHttpRequest): string | undefined =>
  request.body === undefined ? undefined : JSON.stringify(request.body);

export const socketHttpRequestText = (
  request: SocketHttpRequest,
  options: Pick<SocketHttpClientOptions, "apiPrefix" | "hostHeader" | "defaultHeaders">,
  body = requestBody(request),
  rawBodyLength?: number,
): string => {
  const headers = [
    `${request.method} ${options.apiPrefix}${request.path} HTTP/1.1`,
    `Host: ${options.hostHeader ?? "localhost"}`,
    "Connection: close",
    ...Object.entries(options.defaultHeaders ?? {}).map(([key, value]) => `${key}: ${value}`),
    ...Object.entries(request.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
  ];
  if (body !== undefined) {
    headers.push("Content-Type: application/json", `Content-Length: ${textEncoder.encode(body).length}`);
  } else if (rawBodyLength !== undefined) {
    headers.push(`Content-Length: ${rawBodyLength}`);
  }
  return `${headers.join("\r\n")}\r\n\r\n${body ?? ""}`;
};

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

const collectBytes = async (chunks: AsyncIterable<Bytes>): Promise<Bytes> => {
  const collected: Bytes[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return concatBytes(collected);
};

const connect = async (
  options: SocketHttpClientOptions,
  request: SocketHttpRequest,
): Promise<SocketHttpConnection> => {
  try {
    return await options.connect();
  } catch (cause) {
    throw mapError(
      options,
      fail(
        "connect",
        options.operation ?? "container-transport",
        "Failed to connect to the container runtime socket.",
        { method: request.method, path: request.path },
        cause,
      ),
    );
  }
};

const writeRequest = (
  connection: SocketHttpConnection,
  request: SocketHttpRequest,
  options: SocketHttpClientOptions,
  stdinPayload?: Bytes,
): void => {
  try {
    connection.write(
      socketHttpRequestText(
        request,
        options,
        stdinPayload === undefined ? requestBody(request) : undefined,
        stdinPayload?.length,
      ),
    );
    if (stdinPayload !== undefined) connection.write(stdinPayload);
  } catch (cause) {
    throw mapError(
      options,
      fail(
        "write",
        options.operation ?? "container-transport",
        "Failed to write the container runtime HTTP request.",
        { method: request.method, path: request.path },
        cause,
      ),
    );
  }
};

export const makeSocketHttpClient = (options: SocketHttpClientOptions): SocketHttpClient => {
  const operation = options.operation ?? "container-transport";

  const request = async (input: SocketHttpRequest): Promise<SocketHttpResponse> => {
    const connection = await connect(options, input);
    const stdinPayload = input.stdin === undefined ? undefined : await collectBytes(input.stdin);
    writeRequest(connection, input, options, stdinPayload);
    try {
      const responseBytes = await collectBytes(connection);
      const parsed = parseHttpHead(responseBytes, operation);
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
    } catch (cause) {
      throw mapError(options, cause);
    } finally {
      connection.destroy();
    }
  };

  async function* stream(input: SocketHttpRequest): AsyncGenerator<Bytes> {
    const connection = await connect(options, input);
    writeRequest(connection, input, options);
    let stdinPump: Promise<void> | undefined;
    let stdinIterator: AsyncIterator<Bytes> | undefined;
    const abort = () => connection.destroy();
    input.signal?.addEventListener("abort", abort, { once: true });
    const startStdinPump = () => {
      if (input.stdin === undefined || stdinPump !== undefined) return;
      stdinIterator = input.stdin[Symbol.asyncIterator]();
      stdinPump = (async () => {
        while (true) {
          const next = await stdinIterator?.next();
          if (next === undefined || next.done === true) return;
          const chunk = next.value;
          connection.write(chunk);
        }
      })();
      stdinPump.catch(() => connection.destroy());
    };
    try {
      const initialChunks: Bytes[] = [];
      let parsed: ParsedHttpHead | undefined;
      let chunkedBody = false;
      let bodyBuffer: Bytes = new Uint8Array(0) as Bytes;

      for await (const chunk of connection) {
        if (parsed === undefined) {
          initialChunks.push(chunk);
          const merged = concatBytes(initialChunks);
          if (indexOfBytes(merged, headerSeparator) === -1) continue;
          parsed = parseHttpHead(merged, operation);
          startStdinPump();
          if (parsed.status < 200 || parsed.status >= 300) {
            throw fail(
              "http",
              operation,
              `Container runtime stream request failed with HTTP ${parsed.status}.`,
              { method: input.method, path: input.path, status: parsed.status },
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
        throw fail("parse", operation, "Container runtime stream response ended before HTTP headers.", {
          method: input.method,
          path: input.path,
        });
      }
      if (chunkedBody && bodyBuffer.length > 0) {
        for (const bodyChunk of flushChunkedBufferAtEnd(bodyBuffer)) yield bodyChunk;
      }
    } catch (cause) {
      throw mapError(options, cause);
    } finally {
      input.signal?.removeEventListener("abort", abort);
      void stdinIterator?.return?.();
      connection.destroy();
      void stdinPump?.catch(() => undefined);
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
