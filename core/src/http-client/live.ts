import type { ReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Layer, type Scope, Stream } from "effect";

import {
  HttpClient,
  type HttpClientShape,
  HttpStreamError,
  type HttpStreamRequest,
  type HttpStreamResponse,
} from "./service.ts";

interface FileStreamResource {
  readonly handle: FileHandle;
  readonly stream: ReadStream;
}

type WebBodyReadResult =
  | { readonly done: true; readonly value?: Uint8Array }
  | { readonly done: false; readonly value: Uint8Array };

interface WebBodyReader {
  readonly cancel: () => Promise<void>;
  readonly read: () => Promise<WebBodyReadResult>;
  readonly releaseLock: () => void;
}

const messageFromCause = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const unsupportedScheme = (url: string): HttpStreamError =>
  new HttpStreamError({ message: "unsupported scheme", url });

const fileSourceNotPermitted = (url: string): HttpStreamError =>
  new HttpStreamError({ message: "file:// source not permitted", url });

const streamError = (url: string, message: string, cause: unknown, status?: number): HttpStreamError =>
  new HttpStreamError(
    status === undefined
      ? { message: messageFromCause(cause, message), url, cause }
      : { message: messageFromCause(cause, message), url, status, cause },
  );

const parseUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

const headersInit = (headers: ReadonlyMap<string, string> | undefined): Record<string, string> | undefined =>
  headers === undefined ? undefined : Object.fromEntries(headers);

async function* readWebBody(reader: WebBodyReader): AsyncIterable<Uint8Array> {
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    if (chunk.value !== undefined) yield chunk.value;
  }
}

const releaseWebReader = (reader: WebBodyReader) =>
  Effect.promise(async () => {
    try {
      await reader.cancel();
    } catch (cause) {
      void cause;
    }

    try {
      reader.releaseLock();
    } catch (cause) {
      void cause;
    }
  });

const responseBodyStream = (
  request: HttpStreamRequest,
  response: Response,
): Effect.Effect<Stream.Stream<Uint8Array, HttpStreamError>, HttpStreamError, Scope.Scope> => {
  const responseBody = response.body;
  if (responseBody === null) return Effect.succeed(Stream.empty);

  return Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => responseBody.getReader() as unknown as WebBodyReader),
      releaseWebReader,
    ),
    (reader) =>
      Stream.fromAsyncIterable(readWebBody(reader), (cause) =>
        streamError(request.url, `Failed to read ${request.url}`, cause, response.status),
      ),
  );
};

const streamHttp = (
  request: HttpStreamRequest,
): Effect.Effect<HttpStreamResponse, HttpStreamError, Scope.Scope> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(request.url, { headers: headersInit(request.headers) }),
      catch: (cause) => streamError(request.url, `Failed to fetch ${request.url}`, cause),
    });
    const body = yield* responseBodyStream(request, response);

    return {
      body,
      headers: new Map(response.headers.entries()),
      status: response.status,
    };
  });

const filePathFromUrl = (url: URL): Effect.Effect<string, HttpStreamError> =>
  Effect.try({
    try: () => fileURLToPath(url),
    catch: (cause) => streamError(url.href, `Failed to resolve ${url.href}`, cause),
  });

const acquireFileStream = (url: string, path: string): Effect.Effect<FileStreamResource, HttpStreamError> =>
  Effect.map(
    Effect.tryPromise({
      try: () => open(path, "r"),
      catch: (cause) => streamError(url, `Failed to open ${url}`, cause),
    }),
    (handle) => ({ handle, stream: handle.createReadStream({ autoClose: false }) }),
  );

const releaseFileStream = ({ handle, stream }: FileStreamResource) =>
  Effect.promise(async () => {
    stream.destroy();

    try {
      await handle.close();
    } catch (cause) {
      void cause;
    }
  });

const streamFile = (
  request: HttpStreamRequest,
  url: URL,
): Effect.Effect<HttpStreamResponse, HttpStreamError, Scope.Scope> => {
  if (request.allowFileSource !== true) return Effect.fail(fileSourceNotPermitted(request.url));

  return Effect.gen(function* () {
    const path = yield* filePathFromUrl(url);
    const resource = yield* Effect.acquireRelease(acquireFileStream(request.url, path), releaseFileStream);

    return {
      body: Stream.fromAsyncIterable(resource.stream as AsyncIterable<Uint8Array>, (cause) =>
        streamError(request.url, `Failed to read ${request.url}`, cause),
      ),
      headers: new Map<string, string>(),
      status: 200,
    };
  });
};

const stream: HttpClientShape["stream"] = (request) => {
  const url = parseUrl(request.url);
  if (url === undefined) return Effect.fail(unsupportedScheme(request.url));

  if (url.protocol === "http:" || url.protocol === "https:") return streamHttp(request);
  if (url.protocol === "file:") return streamFile(request, url);

  return Effect.fail(unsupportedScheme(request.url));
};

export const HttpClientBasicLive: Layer.Layer<HttpClient> = Layer.succeed(HttpClient, {
  id: "core-http-client-basic",
  stream,
});
