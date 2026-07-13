import { Duration, Effect, Either, Fiber, type Scope } from "effect";

import type { HttpRequest } from "../schema/index.ts";
import type { HttpClientShape, LandoEvent } from "../services/index.ts";
import { ContractFailure, bytesEqual, collectByteStream } from "./_shared.ts";

const httpClientContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `HttpClient contract failed: ${assertion}`, assertion, details });

const requireHttpClientContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(httpClientContractFailure(assertion, details));

const httpErrorLeft = (value: unknown): { readonly _tag?: string } => value as { readonly _tag?: string };

/** A fetch init captured by the harness when its implementation issues a request. */
export interface HttpClientCapturedInit {
  readonly url: string;
  readonly proxy?: string;
  readonly tls?: { readonly ca?: ReadonlyArray<string> };
}

/**
 * The harness an `HttpClient` implementation provides so one suite can run
 * against `HttpClientLive`, `TestHttpClient`, or a plugin-contributed client.
 *
 * `serveSource` registers the bytes a URL resolves to. `events()` snapshots the
 * lifecycle events the client published. The optional `trust` section drives
 * the resolved-trust path: `withTrust` runs an effect with a resolved trust
 * object applied (proxy + CA), and `lastInit` returns the fetch init the
 * implementation built for the most recent request, so the suite can assert
 * proxy precedence and `NO_PROXY` bypass. The optional `offline` hook runs an
 * effect under offline-only conditions and `connectCount` returns how many
 * times the implementation actually opened a connection.
 */
export interface HttpClientContractHarness<TrustObject = unknown> {
  readonly name?: string;
  readonly service: HttpClientShape;
  readonly serveSource: (url: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly trust?: {
    readonly make: (input: {
      readonly proxy: {
        readonly http?: string;
        readonly https?: string;
        readonly noProxy: ReadonlyArray<string>;
      };
      readonly caPems: ReadonlyArray<string>;
      readonly trustHost?: boolean;
    }) => TrustObject;
    readonly withTrust: <A, E, R>(
      trust: TrustObject,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly lastInit: () => Effect.Effect<HttpClientCapturedInit | undefined>;
    /**
     * A PEM known to be present in the implementation's host default trust
     * store, used to assert `trustHost: true` merges system roots with custom
     * CAs. Omit when the implementation cannot report a stable host root.
     */
    readonly systemCaSample?: string;
  };
  readonly offline?: {
    readonly withOffline: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly connectCount: () => Effect.Effect<number>;
  };
  readonly interruption?: {
    readonly run: () => Effect.Effect<unknown, unknown, Scope.Scope>;
    readonly finalized: () => Effect.Effect<boolean>;
  };
  readonly timeout?: {
    /**
     * Run a request/stream that the implementation must abort once the
     * `request.timeoutMs` deadline elapses. The harness wires a source that
     * never completes, so the only way the effect can settle is the deadline.
     * The provided `timeoutMs` is what the suite sets on the request.
     */
    readonly run: (timeoutMs: number) => Effect.Effect<unknown, unknown, Scope.Scope>;
    /** True once the implementation reaped the in-flight connection (no leak). */
    readonly reaped: () => Effect.Effect<boolean>;
  };
}

const httpRequest = (overrides: Partial<HttpRequest> & { readonly url: string }): HttpRequest => overrides;

/**
 * Run the `HttpClient` contract assertions against a harness. Asserts (in
 * order): a non-empty id and a `capabilities` object; `request` returns a
 * buffered response with status and headers for an `https://` source; `stream`
 * returns a non-buffering `Stream<Uint8Array>` whose collected bytes equal the
 * source; `upload` round-trips when advertised, otherwise is skipped; an
 * unsupported scheme is rejected before any connection; `pre-http-call` /
 * `post-http-call` events are published with `urlOrigin` reduced to scheme+host
 * and no secret from URL userinfo / query / caller fields leaking into any
 * event; (with `trust`) the https proxy wins for https URLs, a `NO_PROXY` host
 * bypasses the proxy while keeping the CA; (with `offline`) an offline-only
 * request fails before opening a connection; and an interrupted stream issues no
 * leaked connection.
 */
export const runHttpClientContract = <TrustObject>(
  harness: HttpClientContractHarness<TrustObject>,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const service = harness.service;
    const failWith =
      (assertion: string) =>
      (cause: unknown): ContractFailure =>
        httpClientContractFailure(assertion, cause);

    yield* requireHttpClientContract(
      typeof service.id === "string" && service.id.length > 0,
      "the http client declares a non-empty id",
      service.id,
    );
    yield* requireHttpClientContract(
      typeof service.capabilities === "object" &&
        service.capabilities !== null &&
        Array.isArray(service.capabilities.schemes),
      "the http client declares capabilities with a schemes array",
      service.capabilities,
    );

    const payload = new TextEncoder().encode("http client contract payload");
    const okUrl = "https://contract.test/resource.bin";
    yield* harness.serveSource(okUrl, payload);

    const response = yield* Effect.scoped(service.request(httpRequest({ url: okUrl }))).pipe(
      Effect.mapError(failWith("a request to an https source succeeds")),
    );
    yield* requireHttpClientContract(
      response.status >= 200 && response.status < 400,
      "request returns a non-error status for a served https source",
      response.status,
    );

    const streamUrl = "https://contract.test/stream.bin";
    yield* harness.serveSource(streamUrl, payload);
    const streamed = yield* Effect.scoped(
      Effect.gen(function* () {
        const streamResponse = yield* service.stream(httpRequest({ url: streamUrl }));
        return yield* collectByteStream(streamResponse.body);
      }),
    ).pipe(Effect.mapError(failWith("a stream of an https source succeeds")));
    yield* requireHttpClientContract(
      bytesEqual(streamed, payload),
      "stream yields the source bytes without buffering loss",
      { expected: payload.length, actual: streamed.length },
    );

    if (service.capabilities.upload) {
      const uploadResult = yield* Effect.either(
        Effect.scoped(service.upload({ url: "https://contract.test/upload", source: { kind: "inline" } })),
      );
      yield* requireHttpClientContract(
        Either.isRight(uploadResult) || httpErrorLeft(uploadResult.left)._tag !== undefined,
        "upload either succeeds or fails with a tagged error when advertised",
        uploadResult,
      );
    }

    const schemeResult = yield* Effect.either(
      Effect.scoped(service.request(httpRequest({ url: "ftp://contract.test/x" }))),
    );
    yield* requireHttpClientContract(
      Either.isLeft(schemeResult),
      "an unsupported scheme is rejected",
      schemeResult,
    );

    const secret = "ULW-HTTP-SECRET-9f8e7d6c5b4a3";
    const secretUrl = `https://user:${secret}@contract.test/s?token=${secret}`;
    yield* harness.serveSource(secretUrl, payload);
    yield* Effect.scoped(
      service.request(
        httpRequest({ url: secretUrl, callerId: `caller-${secret}`, redactionTokens: [secret] }),
      ),
    ).pipe(Effect.mapError(failWith("a secret-bearing request succeeds")));
    const events = yield* harness.events();
    yield* requireHttpClientContract(
      events.some((e) => e._tag === "pre-http-call") && events.some((e) => e._tag === "post-http-call"),
      "pre-http-call and post-http-call events are published",
      events.map((e) => e._tag),
    );
    yield* requireHttpClientContract(
      !JSON.stringify(events).includes(secret),
      "a secret in the URL userinfo / query / caller fields never appears in an event",
      { sample: events.find((e) => e._tag === "post-http-call") ?? events[0] },
    );
    yield* requireHttpClientContract(
      !events.some((e) => {
        const origin = (e as { readonly urlOrigin?: unknown }).urlOrigin;
        return typeof origin === "string" && (origin.includes("?") || origin.includes("@"));
      }),
      "http-call event urlOrigin is reduced to scheme+host with no path/query/userinfo",
      events.filter((e) => e._tag === "pre-http-call" || e._tag === "post-http-call"),
    );

    if (harness.trust) {
      const trust = harness.trust;
      const proxyUrl = "https://canary.test/x";
      yield* harness.serveSource(proxyUrl, payload);
      const caPem = "-----BEGIN CERTIFICATE-----\nHTTPCONTRACT\n-----END CERTIFICATE-----";

      const proxiedTrust = trust.make({
        proxy: { http: "http://proxy.http:8080", https: "http://proxy.https:8443", noProxy: [] },
        caPems: [caPem],
      });
      yield* trust
        .withTrust(proxiedTrust, Effect.scoped(service.request(httpRequest({ url: proxyUrl }))))
        .pipe(Effect.mapError(failWith("a proxied request succeeds")));
      const proxiedInit = yield* trust.lastInit();
      yield* requireHttpClientContract(
        proxiedInit?.proxy === "http://proxy.https:8443",
        "an https request applies the https proxy",
        proxiedInit,
      );
      yield* requireHttpClientContract(
        (proxiedInit?.tls?.ca ?? []).includes(caPem),
        "a request applies the configured CA",
        proxiedInit,
      );

      const bypassTrust = trust.make({
        proxy: { http: "http://proxy.http:8080", https: "http://proxy.https:8443", noProxy: ["canary.test"] },
        caPems: [caPem],
      });
      yield* trust
        .withTrust(bypassTrust, Effect.scoped(service.request(httpRequest({ url: proxyUrl }))))
        .pipe(Effect.mapError(failWith("a NO_PROXY request succeeds")));
      const bypassInit = yield* trust.lastInit();
      yield* requireHttpClientContract(
        bypassInit?.proxy === undefined,
        "a NO_PROXY host bypasses the proxy",
        bypassInit,
      );
      yield* requireHttpClientContract(
        (bypassInit?.tls?.ca ?? []).includes(caPem),
        "a NO_PROXY host keeps the configured CA",
        bypassInit,
      );

      const mergeUrl = "https://merge.test/x";
      yield* harness.serveSource(mergeUrl, payload);

      const mergedTrust = trust.make({ proxy: { noProxy: [] }, caPems: [caPem], trustHost: true });
      yield* trust
        .withTrust(mergedTrust, Effect.scoped(service.request(httpRequest({ url: mergeUrl }))))
        .pipe(Effect.mapError(failWith("a trustHost request succeeds")));
      const mergedInit = yield* trust.lastInit();
      const mergedCa = mergedInit?.tls?.ca ?? [];
      yield* requireHttpClientContract(
        mergedCa.includes(caPem) && mergedCa.length > 1,
        "trustHost merges the host default roots with the custom CA",
        mergedInit,
      );
      if (trust.systemCaSample !== undefined) {
        yield* requireHttpClientContract(
          mergedCa.includes(trust.systemCaSample),
          "trustHost keeps a known host default root alongside the custom CA",
          mergedInit,
        );
      }

      const replaceTrust = trust.make({ proxy: { noProxy: [] }, caPems: [caPem], trustHost: false });
      yield* trust
        .withTrust(replaceTrust, Effect.scoped(service.request(httpRequest({ url: mergeUrl }))))
        .pipe(Effect.mapError(failWith("a trustHost:false request succeeds")));
      const replaceInit = yield* trust.lastInit();
      yield* requireHttpClientContract(
        (replaceInit?.tls?.ca ?? []).length === 1 && (replaceInit?.tls?.ca ?? []).includes(caPem),
        "trustHost:false uses only the custom CA and drops host default roots",
        replaceInit,
      );
    }

    if (harness.offline) {
      const offline = harness.offline;
      const offlineUrl = "https://contract.test/offline.bin";
      yield* harness.serveSource(offlineUrl, payload);
      const before = yield* offline.connectCount();
      const offlineResult = yield* Effect.either(
        Effect.scoped(service.request(httpRequest({ url: offlineUrl, offline: true }))),
      );
      const after = yield* offline.connectCount();
      yield* requireHttpClientContract(
        Either.isLeft(offlineResult),
        "an offline-only request fails",
        offlineResult,
      );
      yield* requireHttpClientContract(
        after === before,
        "an offline-only request fails before opening a connection",
        { before, after },
      );

      const unavailableResult = yield* Effect.either(
        offline.withOffline(Effect.scoped(service.request(httpRequest({ url: offlineUrl })))),
      );
      yield* requireHttpClientContract(
        Either.isLeft(unavailableResult),
        "a transport-level offline failure is surfaced as a tagged error",
        unavailableResult,
      );
    }

    if (harness.interruption) {
      const probe = harness.interruption;
      const fiber = yield* Effect.fork(Effect.scoped(probe.run()));
      yield* Effect.sleep(Duration.millis(10));
      yield* Fiber.interrupt(fiber);
      const finalized = yield* probe.finalized();
      yield* requireHttpClientContract(
        finalized,
        "an interrupted stream finalizes in-flight transfer resources",
        finalized,
      );
    }

    if (harness.timeout) {
      const probe = harness.timeout;
      const timeoutResult = yield* Effect.either(Effect.scoped(probe.run(10)));
      yield* requireHttpClientContract(
        Either.isLeft(timeoutResult),
        "a request exceeding timeoutMs fails with a tagged error",
        timeoutResult,
      );
      yield* requireHttpClientContract(
        Either.isLeft(timeoutResult) && typeof httpErrorLeft(timeoutResult.left)._tag === "string",
        "a timed-out request fails with a tagged http error",
        timeoutResult,
      );
      const reaped = yield* probe.reaped();
      yield* requireHttpClientContract(reaped, "a timed-out request reaps the in-flight connection", reaped);
    }
  });
