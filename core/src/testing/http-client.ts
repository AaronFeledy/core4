import { DateTime, Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { PostHttpCallEvent, PreHttpCallEvent } from "@lando/sdk/events";
import { createRedactor } from "@lando/sdk/secrets";
import type { LandoEvent } from "@lando/sdk/services";

import { RequestPolicy, type RequestPolicyShape } from "@lando/http-client/live";
import type { ResolvedNetworkTrust } from "@lando/http-client/network-trust";
import { fetchInitForNetwork } from "@lando/http-client/network-trust";

/** A fetch init the double recorded for the most recent request under trust. */
export interface TestHttpCapturedInit {
  readonly url: string;
  readonly proxy?: string;
  readonly tls?: { readonly ca?: ReadonlyArray<string> };
}

export interface TestHttpClientHandle {
  readonly service: HttpClient.HttpClient;
  readonly serve: (url: string, bytes: Uint8Array) => void;
  /** Register a URL whose connection never completes, so only `Effect.timeout` settles it. */
  readonly serveHang: (url: string) => void;
  /** Register a URL whose response opens but whose body never drains. */
  readonly serveBodyHang: (url: string) => void;
  /** Number of hang connections still in flight (non-zero means a leaked socket). */
  readonly pendingHangs: () => number;
  readonly events: () => ReadonlyArray<LandoEvent>;
  /** Run an effect with a resolved trust object applied to subsequent requests. */
  readonly withTrust: <A, E, R>(
    trust: ResolvedNetworkTrust,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Run an effect under a fiber-local request policy. */
  readonly withPolicy: <A, E, R>(
    policy: RequestPolicyShape,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The fetch init computed for the most recent request, or undefined. */
  readonly lastInit: () => TestHttpCapturedInit | undefined;
  /** Run an effect under offline-only conditions (every request fails pre-connect). */
  readonly withOffline: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Number of times the double actually opened a connection (served a body). */
  readonly connectCount: () => number;
}

const urlOrigin = (url: URL): string => (url.host.length > 0 ? `${url.protocol}//${url.host}` : url.protocol);

const transportError = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0], cause: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

/**
 * In-memory Effect `HttpClient` double for the `runHttpClientContract` suite and
 * for tests that need a deterministic egress chokepoint. It mirrors the real
 * Lando layer event/redaction behavior (redacted `pre/post-http-call`,
 * scheme+host `urlOrigin`, `onBehalfOf` passthrough) without touching the
 * network: bodies are registered with `serve(url, bytes)`. Trust is observed,
 * not applied to a socket — `withTrust` records the `fetchInitForNetwork` result
 * so trust-precedence assertions can read it via `lastInit`.
 */
export const makeTestHttpClient = (
  options: { readonly systemCaPems?: ReadonlyArray<string> } = {},
): TestHttpClientHandle => {
  const systemCaPems = options.systemCaPems ?? [];
  const sources = new Map<string, Uint8Array>();
  const hangs = new Set<string>();
  const bodyHangs = new Set<string>();
  const captured: LandoEvent[] = [];
  let connectCount = 0;
  let pendingHangs = 0;
  let activeTrust: ResolvedNetworkTrust | undefined;
  let offline = false;
  let lastInit: TestHttpCapturedInit | undefined;

  const recordInit = (url: string): void => {
    const init = activeTrust === undefined ? undefined : fetchInitForNetwork(url, activeTrust, systemCaPems);
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

  const service = HttpClient.make((request, url, _signal, fiber) =>
    Effect.gen(function* () {
      const policy = fiber.getRef(RequestPolicy);
      const protocol = url.protocol;
      if (protocol !== "http:" && protocol !== "https:" && protocol !== "file:") {
        return yield* Effect.fail(transportError(request, "unsupported scheme"));
      }
      const redact = createRedactor("secrets", { values: policy.redactionTokens ?? [] }).redactString;
      const origin = urlOrigin(url);
      captured.push(
        PreHttpCallEvent.make({
          eventName: "pre-http-call",
          urlOrigin: origin,
          method: request.method,
          ...(policy.callerId === undefined ? {} : { callerId: redact(policy.callerId) }),
          ...(policy.onBehalfOf === undefined ? {} : { onBehalfOf: policy.onBehalfOf }),
          timestamp: yield* DateTime.now,
        }),
      );

      if (offline || policy.offline === true) {
        captured.push(
          PostHttpCallEvent.make({
            eventName: "post-http-call",
            urlOrigin: origin,
            method: request.method,
            outcome: "failure",
            durationMs: 0,
            failureDetail: "offline",
            ...(policy.onBehalfOf === undefined ? {} : { onBehalfOf: policy.onBehalfOf }),
            timestamp: yield* DateTime.now,
          }),
        );
        return yield* Effect.fail(transportError(request, "offline"));
      }

      const href = url.href;
      if (hangs.has(href) || hangs.has(request.url)) {
        recordInit(href);
        connectCount += 1;
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            pendingHangs += 1;
          }),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              pendingHangs -= 1;
            }),
        );
      }

      recordInit(href);
      const bytes = sources.get(href) ?? sources.get(request.url);
      const status = bytes === undefined ? 404 : 200;
      if (bytes !== undefined) connectCount += 1;
      captured.push(
        PostHttpCallEvent.make({
          eventName: "post-http-call",
          urlOrigin: origin,
          method: request.method,
          status,
          outcome: "success",
          durationMs: 0,
          ...(policy.onBehalfOf === undefined ? {} : { onBehalfOf: policy.onBehalfOf }),
          timestamp: yield* DateTime.now,
        }),
      );

      if (bytes === undefined) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
      }
      if (bodyHangs.has(href) || bodyHangs.has(request.url)) {
        const body = new ReadableStream<Uint8Array>({
          start() {
            /* never enqueues or closes */
          },
        });
        return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
      }
      return HttpClientResponse.fromWeb(request, new Response(bytes, { status: 200 }));
    }),
  );

  return {
    service,
    serve: (url, bytes) => void sources.set(url, bytes),
    serveHang: (url) => void hangs.add(url),
    serveBodyHang: (url) => void bodyHangs.add(url),
    pendingHangs: () => pendingHangs,
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
    withPolicy: (policy, effect) => effect.pipe(Effect.provideService(RequestPolicy, policy)),
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
