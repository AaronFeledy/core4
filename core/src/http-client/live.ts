import type { ReadStream } from "node:fs";
/**
 * `HttpClientLive` — the real outbound-egress chokepoint.
 *
 * Implements the published `@lando/sdk` `HttpClient` contract (`request` /
 * `stream` / `upload` / `capabilities`) over Bun `fetch`. Every Lando-owned
 * fetch issues through this adapter, so it is the single place that applies
 * outbound proxy/CA trust and publishes redacted `pre-http-call` /
 * `post-http-call` lifecycle events.
 *
 * Trust precedence: an injected `NetworkTrust` (resolved by `lando setup`
 * preflight) wins; otherwise the client self-resolves from `ConfigService` plus
 * the environment and reads configured CA PEMs; otherwise the fetch stays bare.
 * `ConfigService` is resolved with `Effect.serviceOption`, so the client never
 * widens the bootstrap `minimal` requirement set.
 *
 * `stream` returns a non-buffering `Stream<Uint8Array>`; the connection is
 * opened under an `AbortController` bound to the ambient `Scope`, so an
 * `Effect.interrupt` aborts the in-flight transfer. An unsupported scheme (or a
 * disallowed `file://`) fails before any connection opens.
 */
import { readFile } from "node:fs/promises";
import { type FileHandle, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Cause, type Context, DateTime, Effect, Exit, Layer, Option, type Scope, Stream } from "effect";

import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import { PostHttpCallEvent, PreHttpCallEvent } from "@lando/sdk/events";
import type {
  HttpClientCapabilities,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpUploadRequest,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { ConfigService, EventService, type LandoEvent } from "@lando/sdk/services";

import {
  NetworkTrust,
  type ResolvedNetworkTrust,
  fetchInitForNetwork,
  resolveNetworkTrustPlan,
} from "./network-trust.ts";
import { HttpClient, type HttpClientShape } from "./service.ts";
import { applyHttpStreamTimeout, applyHttpTimeout } from "./timeout.ts";

type HttpHeaderRecord = HttpResponse["headers"][number];

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

interface ReadWebBodyChunkInput {
  readonly request: HttpRequest;
  readonly response: Response;
  readonly reader: WebBodyReader;
  readonly startedAt: number;
}

const CAPABILITIES: HttpClientCapabilities = {
  schemes: ["https", "http", "file"],
  streaming: true,
  upload: false,
  customCa: true,
  proxyAware: true,
};

const messageFromCause = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const urlOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

const requestError = (url: string, message: string, cause: unknown, status?: number): HttpRequestError =>
  new HttpRequestError(
    status === undefined
      ? { message: messageFromCause(cause, message), urlOrigin: urlOrigin(url), cause }
      : { message: messageFromCause(cause, message), urlOrigin: urlOrigin(url), status, cause },
  );

const unsupportedScheme = (url: string): HttpRequestError =>
  new HttpRequestError({ message: "unsupported scheme", urlOrigin: urlOrigin(url) });

const fileSourceNotPermitted = (url: string): HttpRequestError =>
  new HttpRequestError({ message: "file:// source not permitted", urlOrigin: urlOrigin(url) });

const offlineRequest = (url: string): HttpRequestError =>
  new HttpRequestError({
    message: "offline-only request cannot open a connection",
    urlOrigin: urlOrigin(url),
  });

const parseUrl = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

const headerRecords = (headers: Headers): ReadonlyArray<HttpHeaderRecord> =>
  Array.from(headers.entries(), ([name, value]) => ({ name, value }));

const requestHeadersInit = (headers: HttpRequest["headers"]): Record<string, string> | undefined =>
  headers === undefined || headers.length === 0
    ? undefined
    : Object.fromEntries(headers.map((header) => [header.name, header.value]));

const remainingHttpTimeoutMs = (request: HttpRequest, startedAt: number): number | undefined =>
  request.timeoutMs === undefined ? undefined : request.timeoutMs - (Date.now() - startedAt);

const readWebBodyChunk = ({
  request,
  response,
  reader,
  startedAt,
}: ReadWebBodyChunkInput): Effect.Effect<Uint8Array, Option.Option<HttpRequestError>> =>
  applyHttpTimeout(
    request,
    Effect.tryPromise({
      try: () => reader.read(),
      catch: (cause) =>
        requestError(request.url, `Failed to read ${urlOrigin(request.url)}`, cause, response.status),
    }),
    remainingHttpTimeoutMs(request, startedAt),
  ).pipe(
    Effect.mapError(Option.some),
    Effect.flatMap((chunk) =>
      chunk.done || chunk.value === undefined ? Effect.fail(Option.none()) : Effect.succeed(chunk.value),
    ),
  );

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

const loadCaPems = (paths: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, HttpRequestError> =>
  Effect.all(
    paths.map((path) =>
      Effect.tryPromise({
        try: () => readFile(path, "utf-8"),
        catch: (cause) =>
          new HttpRequestError({
            message: `Failed to read CA certificate: ${path}`,
            urlOrigin: "unknown",
            cause,
          }),
      }),
    ),
    { concurrency: "unbounded" },
  );

/** Resolve trust for a request: injected `NetworkTrust` wins, else config+env. */
const resolveTrust = (): Effect.Effect<ResolvedNetworkTrust | undefined, HttpRequestError> =>
  Effect.gen(function* () {
    const injected = yield* Effect.serviceOption(NetworkTrust);
    if (Option.isSome(injected)) return injected.value;

    const config = yield* Effect.serviceOption(ConfigService);
    if (Option.isNone(config)) return undefined;

    const globalConfig = yield* config.value.load.pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const plan = yield* Effect.try({
      try: () => resolveNetworkTrustPlan(globalConfig === undefined ? {} : { network: globalConfig.network }),
      catch: (cause) =>
        new HttpRequestError({
          message: messageFromCause(cause, "Failed to resolve outbound network trust"),
          urlOrigin: "unknown",
          cause,
        }),
    });
    const caPems = yield* loadCaPems(plan.caCertPaths);
    return { proxy: plan.proxy, caPems };
  });

interface HttpCallEvents {
  readonly redact: (text: string) => string;
  readonly publish: (event: LandoEvent) => Effect.Effect<void>;
}

const makeHttpCallEvents = (
  eventService: Option.Option<Context.Tag.Service<typeof EventService>>,
  request: HttpRequest | HttpUploadRequest,
): HttpCallEvents => {
  const redact = createRedactor("secrets", { values: request.redactionTokens ?? [] }).redactString;
  const publish: HttpCallEvents["publish"] = Option.isSome(eventService)
    ? (event) => eventService.value.publish(event).pipe(Effect.catchAllCause(() => Effect.void))
    : () => Effect.void;
  return { redact, publish };
};

const preEvent = (
  request: HttpRequest | HttpUploadRequest,
  origin: string,
  redact: (text: string) => string,
): LandoEvent =>
  PreHttpCallEvent.make({
    eventName: "pre-http-call",
    urlOrigin: origin,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.callerId === undefined ? {} : { callerId: redact(request.callerId) }),
    ...(request.onBehalfOf === undefined ? {} : { onBehalfOf: request.onBehalfOf }),
    timestamp: DateTime.unsafeMake(Date.now()),
  });

interface PostEventInput {
  readonly request: HttpRequest | HttpUploadRequest;
  readonly origin: string;
  readonly outcome: "success" | "failure";
  readonly status: number | undefined;
  readonly durationMs: number;
  readonly failureDetail: string | undefined;
  readonly redact: (text: string) => string;
}

const postEvent = (input: PostEventInput): LandoEvent =>
  PostHttpCallEvent.make({
    eventName: "post-http-call",
    urlOrigin: input.origin,
    ...(input.request.method === undefined ? {} : { method: input.request.method }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.request.callerId === undefined ? {} : { callerId: input.redact(input.request.callerId) }),
    ...(input.request.onBehalfOf === undefined ? {} : { onBehalfOf: input.request.onBehalfOf }),
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.failureDetail === undefined ? {} : { failureDetail: input.redact(input.failureDetail) }),
    timestamp: DateTime.unsafeMake(Date.now()),
  });

interface FetchOutcome {
  readonly response: Response;
}

const openConnection = (
  fetchImpl: typeof fetch,
  request: HttpRequest,
  url: URL,
): Effect.Effect<FetchOutcome, HttpRequestError, Scope.Scope> =>
  Effect.gen(function* () {
    const trust = yield* resolveTrust();
    const trustInit = trust === undefined ? undefined : fetchInitForNetwork(request.url, trust);
    const controller = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(request.url, {
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.redirect === undefined ? {} : { redirect: request.redirect }),
          headers: requestHeadersInit(request.headers),
          signal: controller.signal,
          ...trustInit,
        }),
      catch: (cause) => requestError(request.url, `Failed to fetch ${urlOrigin(url.href)}`, cause),
    });
    return { response };
  });

const responseBodyStream = (
  request: HttpRequest,
  response: Response,
  startedAt: number,
): Effect.Effect<Stream.Stream<Uint8Array, HttpRequestError>, never, Scope.Scope> => {
  const responseBody = response.body;
  if (responseBody === null) return Effect.succeed(Stream.empty);
  return Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => responseBody.getReader() as unknown as WebBodyReader),
      releaseWebReader,
    ),
    (reader) => Stream.repeatEffectOption(readWebBodyChunk({ request, response, reader, startedAt })),
  );
};

const bodyFailureDetail = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!("cause" in exit)) return "body-read-failed";
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) return messageFromCause(failure.value, "body-read-failed");
  return Cause.isInterruptedOnly(exit.cause) ? "body-read-interrupted" : "body-read-failed";
};

const filePathFromUrl = (url: URL): Effect.Effect<string, HttpRequestError> =>
  Effect.try({
    try: () => fileURLToPath(url),
    catch: (cause) => requestError(url.href, `Failed to resolve ${urlOrigin(url.href)}`, cause),
  });

const acquireFileStream = (url: string, path: string): Effect.Effect<FileStreamResource, HttpRequestError> =>
  Effect.map(
    Effect.tryPromise({
      try: () => open(path, "r"),
      catch: (cause) => requestError(url, `Failed to open ${urlOrigin(url)}`, cause),
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
  request: HttpRequest,
  url: URL,
): Effect.Effect<
  HttpStreamResponse & { readonly body: Stream.Stream<Uint8Array, HttpRequestError> },
  HttpRequestError,
  Scope.Scope
> => {
  if (request.allowFileSource !== true) return Effect.fail(fileSourceNotPermitted(request.url));
  const startedAt = Date.now();
  return applyHttpTimeout(
    request,
    Effect.gen(function* () {
      const path = yield* filePathFromUrl(url);
      const resource = yield* Effect.acquireRelease(acquireFileStream(request.url, path), releaseFileStream);
      return {
        status: 200,
        headers: [],
        body: Stream.suspend(() =>
          applyHttpStreamTimeout(
            request,
            Stream.fromAsyncIterable(resource.stream as AsyncIterable<Uint8Array>, (cause) =>
              requestError(request.url, `Failed to read ${urlOrigin(request.url)}`, cause),
            ),
            remainingHttpTimeoutMs(request, startedAt),
          ),
        ),
      };
    }),
  );
};

const makeStream =
  (
    fetchImpl: typeof fetch,
    eventService: Option.Option<Context.Tag.Service<typeof EventService>>,
  ): HttpClientShape["stream"] =>
  (request) =>
    Effect.gen(function* () {
      const url = parseUrl(request.url);
      if (url === undefined) return yield* Effect.fail(unsupportedScheme(request.url));
      if (url.protocol === "file:") return yield* streamFile(request, url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return yield* Effect.fail(unsupportedScheme(request.url));
      }
      if (request.offline === true) return yield* Effect.fail(offlineRequest(request.url));

      const events = makeHttpCallEvents(eventService, request);
      const origin = urlOrigin(request.url);
      const startedAt = Date.now();
      yield* events.publish(preEvent(request, origin, events.redact));

      const result = yield* Effect.either(
        applyHttpTimeout(
          request,
          openConnection(fetchImpl, request, url),
          remainingHttpTimeoutMs(request, startedAt),
        ),
      );
      if (result._tag === "Left") {
        yield* events.publish(
          postEvent({
            request,
            origin,
            outcome: "failure",
            status: result.left.status,
            durationMs: Date.now() - startedAt,
            failureDetail: result.left.message,
            redact: events.redact,
          }),
        );
        return yield* Effect.fail(result.left);
      }

      const { response } = result.right;
      const publishPost = (outcome: "success" | "failure", failureDetail: string | undefined) =>
        events.publish(
          postEvent({
            request,
            origin,
            outcome,
            status: response.status,
            durationMs: Date.now() - startedAt,
            failureDetail,
            redact: events.redact,
          }),
        );

      const body = yield* responseBodyStream(request, response, startedAt);
      const bodyWithTelemetry = body.pipe(
        (stream) => applyHttpStreamTimeout(request, stream, remainingHttpTimeoutMs(request, startedAt)),
        Stream.ensuringWith((exit) =>
          Exit.isSuccess(exit)
            ? publishPost("success", undefined)
            : publishPost("failure", bodyFailureDetail(exit)),
        ),
      );
      return { status: response.status, headers: headerRecords(response.headers), body: bodyWithTelemetry };
    });

const makeRequest =
  (
    fetchImpl: typeof fetch,
    eventService: Option.Option<Context.Tag.Service<typeof EventService>>,
  ): HttpClientShape["request"] =>
  (request) =>
    Effect.gen(function* () {
      const streamResponse = yield* makeStream(fetchImpl, eventService)(request);
      const bytes = yield* Stream.runCollect(streamResponse.body).pipe(
        Effect.map((chunks) => {
          const arr = Array.from(chunks);
          const total = arr.reduce((n, chunk) => n + chunk.length, 0);
          const out = new Uint8Array(total);
          let offset = 0;
          for (const chunk of arr) {
            out.set(chunk, offset);
            offset += chunk.length;
          }
          return out;
        }),
      );
      return {
        status: streamResponse.status,
        headers: streamResponse.headers,
        contentLength: bytes.length,
      } satisfies HttpResponse;
    });

const makeUpload = (): HttpClientShape["upload"] => (request) =>
  Effect.fail(
    new HttpUploadError({
      message: "upload is not supported by the core HttpClient",
      urlOrigin: urlOrigin(request.url),
    }),
  );

/**
 * Construct `HttpClientLive`. `EventService` is resolved once at layer build via
 * `Effect.serviceOption` (so it stays optional and does not widen the published
 * service requirements) and baked into the closure; trust is still applied
 * per-request from the injected `NetworkTrust` tag or self-resolved from
 * `ConfigService`. `fetchImpl` is injectable for tests.
 */
export const makeHttpClientLive = (fetchImpl: typeof fetch = fetch): Layer.Layer<HttpClient> =>
  Layer.effect(
    HttpClient,
    Effect.gen(function* () {
      const eventService = yield* Effect.serviceOption(EventService);
      return {
        id: "core-http-client",
        capabilities: CAPABILITIES,
        request: makeRequest(fetchImpl, eventService),
        stream: makeStream(fetchImpl, eventService),
        upload: makeUpload(),
      };
    }),
  );

export const HttpClientLive: Layer.Layer<HttpClient> = makeHttpClientLive();
