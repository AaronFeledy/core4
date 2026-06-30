import { DateTime, Effect, Stream } from "effect";

import { HttpRequestError, HttpUploadError } from "@lando/sdk/errors";
import { PostHttpCallEvent, PreHttpCallEvent } from "@lando/sdk/events";
import type { HttpClientCapabilities, HttpRequest } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import type { LandoEvent } from "@lando/sdk/services";

import type { ResolvedNetworkTrust } from "../http-client/network-trust.ts";
import { fetchInitForNetwork } from "../http-client/network-trust.ts";
import type { HttpClientShape } from "../http-client/service.ts";

const TEST_CAPABILITIES: HttpClientCapabilities = {
  schemes: ["https", "http", "file"],
  streaming: true,
  upload: false,
  customCa: true,
  proxyAware: true,
};

const urlOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

/** A fetch init the double recorded for the most recent request under trust. */
export interface TestHttpCapturedInit {
  readonly url: string;
  readonly proxy?: string;
  readonly tls?: { readonly ca?: ReadonlyArray<string> };
}

export interface TestHttpClientHandle {
  readonly service: HttpClientShape;
  readonly serve: (url: string, bytes: Uint8Array) => void;
  readonly events: () => ReadonlyArray<LandoEvent>;
  /** Run an effect with a resolved trust object applied to subsequent requests. */
  readonly withTrust: <A, E, R>(
    trust: ResolvedNetworkTrust,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The fetch init computed for the most recent request, or undefined. */
  readonly lastInit: () => TestHttpCapturedInit | undefined;
  /** Run an effect under offline-only conditions (every request fails pre-connect). */
  readonly withOffline: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Number of times the double actually opened a connection (served a body). */
  readonly connectCount: () => number;
}

/**
 * In-memory `HttpClient` double for the `runHttpClientContract` suite and for
 * tests that need a deterministic egress chokepoint. It mirrors the real
 * `HttpClientLive` event/redaction behavior (redacted `pre/post-http-call`,
 * scheme+host `urlOrigin`, `onBehalfOf` passthrough) without touching the
 * network: bodies are registered with `serve(url, bytes)`. Trust is observed,
 * not applied to a socket — `withTrust` records the `fetchInitForNetwork` result
 * so trust-precedence assertions can read it via `lastInit`.
 */
export const makeTestHttpClient = (): TestHttpClientHandle => {
  const sources = new Map<string, Uint8Array>();
  const captured: LandoEvent[] = [];
  let connectCount = 0;
  let activeTrust: ResolvedNetworkTrust | undefined;
  let offline = false;
  let lastInit: TestHttpCapturedInit | undefined;

  const recordInit = (url: string): void => {
    const init = activeTrust === undefined ? undefined : fetchInitForNetwork(url, activeTrust);
    const proxy = typeof init?.proxy === "string" ? init.proxy : undefined;
    const ca = Array.isArray(init?.tls?.ca)
      ? init.tls.ca.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    lastInit = {
      url,
      ...(proxy === undefined ? {} : { proxy }),
      ...(ca === undefined ? {} : { tls: { ca } }),
    };
  };

  const scheme = (url: string): string | undefined => {
    try {
      return new URL(url).protocol;
    } catch {
      return undefined;
    }
  };

  const emit = <A>(request: HttpRequest, body: A): Effect.Effect<A, HttpRequestError> =>
    Effect.gen(function* () {
      const protocol = scheme(request.url);
      if (protocol !== "http:" && protocol !== "https:" && protocol !== "file:") {
        return yield* Effect.fail(
          new HttpRequestError({ message: "unsupported scheme", urlOrigin: urlOrigin(request.url) }),
        );
      }
      const redact = createRedactor("secrets", { values: request.redactionTokens ?? [] }).redactString;
      const origin = urlOrigin(request.url);
      captured.push(
        PreHttpCallEvent.make({
          eventName: "pre-http-call",
          urlOrigin: origin,
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.callerId === undefined ? {} : { callerId: redact(request.callerId) }),
          ...(request.onBehalfOf === undefined ? {} : { onBehalfOf: request.onBehalfOf }),
          timestamp: DateTime.unsafeMake(Date.now()),
        }),
      );

      if (offline) {
        captured.push(
          PostHttpCallEvent.make({
            eventName: "post-http-call",
            urlOrigin: origin,
            outcome: "failure",
            durationMs: 0,
            failureDetail: "offline",
            ...(request.onBehalfOf === undefined ? {} : { onBehalfOf: request.onBehalfOf }),
            timestamp: DateTime.unsafeMake(Date.now()),
          }),
        );
        return yield* Effect.fail(new HttpRequestError({ message: "offline", urlOrigin: origin }));
      }

      if (request.offline === true) {
        captured.push(
          PostHttpCallEvent.make({
            eventName: "post-http-call",
            urlOrigin: origin,
            outcome: "failure",
            durationMs: 0,
            failureDetail: "offline",
            ...(request.onBehalfOf === undefined ? {} : { onBehalfOf: request.onBehalfOf }),
            timestamp: DateTime.unsafeMake(Date.now()),
          }),
        );
        return yield* Effect.fail(new HttpRequestError({ message: "offline", urlOrigin: origin }));
      }

      recordInit(request.url);
      const bytes = sources.get(request.url);
      const status = bytes === undefined ? 404 : 200;
      if (bytes !== undefined) connectCount += 1;
      captured.push(
        PostHttpCallEvent.make({
          eventName: "post-http-call",
          urlOrigin: origin,
          status,
          outcome: "success",
          durationMs: 0,
          ...(request.onBehalfOf === undefined ? {} : { onBehalfOf: request.onBehalfOf }),
          timestamp: DateTime.unsafeMake(Date.now()),
        }),
      );
      return body;
    });

  const service: HttpClientShape = {
    id: "test-http-client",
    capabilities: TEST_CAPABILITIES,
    request: (request) =>
      emit(request, request).pipe(
        Effect.map((req) => {
          const bytes = sources.get(req.url);
          return { status: bytes === undefined ? 404 : 200, headers: [], contentLength: bytes?.length ?? 0 };
        }),
      ),
    stream: (request) =>
      emit(request, request).pipe(
        Effect.map((req) => {
          const bytes = sources.get(req.url) ?? new Uint8Array();
          return {
            status: sources.has(req.url) ? 200 : 404,
            headers: [],
            body: Stream.fromIterable([bytes]),
          };
        }),
      ),
    upload: (request) =>
      Effect.fail(
        new HttpUploadError({ message: "upload not supported", urlOrigin: urlOrigin(request.url) }),
      ),
  };

  return {
    service,
    serve: (url, bytes) => void sources.set(url, bytes),
    events: () => [...captured],
    withTrust: (trust, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const prior = activeTrust;
          activeTrust = trust;
          return prior;
        }),
        () => effect,
        (prior) =>
          Effect.sync(() => {
            activeTrust = prior;
          }),
      ),
    lastInit: () => lastInit,
    withOffline: (effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          offline = true;
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            offline = false;
          }),
      ),
    connectCount: () => connectCount,
  };
};
