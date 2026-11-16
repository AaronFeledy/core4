import type { Bytes, SocketHttpClientOptions, SocketHttpRequest } from "./transport.ts";
import { connect, readResponse } from "./transport-connection.ts";
import type { ContainerTransportError } from "./transport-error.ts";
import {
  type ParsedHttpHead,
  concatBytes,
  decodeChunkedBuffer,
  fail,
  headerSeparator,
  indexOfBytes,
  parseHttpHead,
  readStreamErrorBody,
} from "./transport-http.ts";
import { socketHttpRequestText } from "./transport-request.ts";

const collectUpload = async (
  upload: AsyncIterable<Bytes>,
  signal: AbortSignal | undefined,
): Promise<Bytes> => {
  if (signal?.aborted) throw new DOMException("Socket request aborted.", "AbortError");
  const iterator = upload[Symbol.asyncIterator]();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(new DOMException("Socket request aborted.", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  const collected: Bytes[] = [];
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted.promise]);
      if (next.done === true) break;
      collected.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void Promise.resolve(iterator.return?.(undefined)).catch(() => undefined);
  }
  return concatBytes(collected);
};

export async function* streamUpload(
  options: SocketHttpClientOptions,
  operation: string,
  input: SocketHttpRequest,
  upload: AsyncIterable<Bytes>,
): AsyncGenerator<Bytes> {
  const payload = await collectUpload(upload, input.signal);
  if (input.signal?.aborted) throw new DOMException("Socket request aborted.", "AbortError");
  const connection = await connect(options, input);
  const abort = () => connection.destroy();
  input.signal?.addEventListener("abort", abort, { once: true });
  let writeFailure: ContainerTransportError | undefined;
  const writeBody = (async () => {
    try {
      await connection.write(socketHttpRequestText(input, options, undefined, payload.length));
      await connection.write(payload);
    } catch (cause) {
      writeFailure = fail(
        "write",
        operation,
        "Failed to write the container runtime HTTP request.",
        { method: input.method, path: input.path },
        cause,
      );
    }
  })();
  try {
    const response = readResponse(connection, operation, input);
    const initialChunks: Bytes[] = [];
    let parsed: ParsedHttpHead | undefined;
    let chunkedBody = false;
    let bodyBuffer: Bytes = new Uint8Array(0);
    let contentLength: number | undefined;
    let receivedBodyBytes = 0;

    try {
      for await (const chunk of response) {
        let next = chunk;
        if (parsed === undefined) {
          initialChunks.push(chunk);
          const merged = concatBytes(initialChunks);
          if (indexOfBytes(merged, headerSeparator) === -1) continue;
          parsed = parseHttpHead(merged, operation);
          if (parsed.status < 200 || parsed.status >= 300) {
            const body = await readStreamErrorBody(parsed, response);
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
          chunkedBody = parsed.headers.get("transfer-encoding")?.toLowerCase() === "chunked";
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
          next = parsed.bodyStart;
          if (next.length === 0) continue;
        }

        if (chunkedBody) {
          bodyBuffer = concatBytes([bodyBuffer, next]);
          const decoded = decodeChunkedBuffer(bodyBuffer);
          for (const bodyChunk of decoded.chunks) yield bodyChunk;
          bodyBuffer = decoded.remainder;
          if (decoded.complete) return;
          continue;
        }

        receivedBodyBytes += next.length;
        yield next;
      }

      if (parsed === undefined) {
        throw fail("parse", operation, "Container runtime stream response ended before HTTP headers.", {
          method: input.method,
          path: input.path,
        });
      }
      if (input.signal?.aborted) throw new DOMException("Socket stream aborted.", "AbortError");
      if (chunkedBody) {
        throw fail(
          "read",
          operation,
          "Container runtime stream response ended before the chunked body completed.",
          { method: input.method, path: input.path },
        );
      }
      if (!chunkedBody && contentLength !== undefined && receivedBodyBytes < contentLength) {
        throw fail(
          "read",
          operation,
          "Container runtime stream response ended before Content-Length bytes arrived.",
          { method: input.method, path: input.path },
        );
      }
    } catch (cause) {
      if (input.signal?.aborted) throw new DOMException("Socket stream aborted.", "AbortError");
      if (parsed === undefined && writeFailure !== undefined) throw writeFailure;
      throw cause;
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
    // Destroy first: a peer that answered without draining the body leaves the write pending.
    connection.destroy();
    await writeBody;
  }
}
