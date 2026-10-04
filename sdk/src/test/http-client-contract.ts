import { Duration, Effect, Fiber, Result, type Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";

import type { LandoEvent } from "../services/index.ts";
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
 * Optional fiber-local request policy the Lando-owned Effect HttpClient reads
 * (caller correlation, redaction tokens, offline, redirect). Implementations
 * that do not surface a policy hook skip the secret-redaction and offline
 * assertions that need it.
 */
export interface HttpClientContractRequestPolicy {
  readonly callerId?: string;
  readonly onBehalfOf?: string;
  readonly redactionTokens?: readonly string[];
  readonly allowFileSource?: boolean;
  readonly offline?: boolean;
  readonly redirect?: "follow" | "manual" | "error";
}

/**
 * The harness an Effect `HttpClient` implementation provides so one suite can
 * run against the Lando-owned `@lando/http-client` layer, an in-memory double,
 * or a plugin-contributed client built with `HttpClient.make`.
 *
 * `serveSource` registers the bytes a URL resolves to. `events()` snapshots the
 * lifecycle events the client published. The optional `withPolicy` hook runs an
 * effect under a request policy (redaction tokens, offline). The optional
 * `trust` section drives the resolved-trust path: `withTrust` runs an effect
 * with a resolved trust object applied (proxy + CA), and `lastInit` returns the
 * fetch init the implementation built for the most recent request. The optional
 * `offline` hook runs an effect under offline-only conditions and `connectCount`
 * returns how many times the implementation actually opened a connection.
 */
export interface HttpClientContractHarness<TrustObject = unknown> {
  readonly name?: string;
  readonly service: HttpClient.HttpClient;
  readonly serveSource: (url: string, bytes: Uint8Array) => Effect.Effect<void>;
  readonly events: () => Effect.Effect<ReadonlyArray<LandoEvent>>;
  readonly withPolicy?: <A, E, R>(
    policy: HttpClientContractRequestPolicy,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
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
     * Run a request/stream that the implementation must abort once a deadline
     * elapses. The harness wires a source that never completes. The provided
     * `timeoutMs` is what the suite sets on the effect (typically via
     * `Effect.timeout`).
     */
    readonly run: (timeoutMs: number) => Effect.Effect<unknown, unknown, Scope.Scope>;
    /** True once the implementation reaped the in-flight connection (no leak). */
    readonly reaped: () => Effect.Effect<boolean>;
  };
}

/**
 * Run the Effect `HttpClient` contract assertions against a harness. Asserts
 * (in order): the service is an Effect HttpClient; `get` returns a non-error
 * status for an `https://` source; collecting `response.stream` yields the
 * source bytes without buffering loss; an unsupported scheme is rejected before
 * any connection; `pre-http-call` / `post-http-call` events are published with
 * `urlOrigin` reduced to scheme+host and no secret from URL userinfo / query /
 * caller fields leaking into any event (when `withPolicy` is provided); (with
 * `trust`) the https proxy wins for https URLs, a `NO_PROXY` host bypasses the
 * proxy while keeping the CA; (with `offline`) an offline-only request fails
 * before opening a connection; and an interrupted stream issues no leaked
 * connection.
 */
export const runHttpClientContract: <TrustObject>(
  harness: HttpClientContractHarness<TrustObject>,
) => Effect.Effect<void, ContractFailure> = Effect.fnUntraced(function* <TrustObject>(
  harness: HttpClientContractHarness<TrustObject>,
) {
  const service = harness.service;
  const failWith =
    (assertion: string) =>
    (cause: unknown): ContractFailure =>
      httpClientContractFailure(assertion, cause);

  const withPolicy = <A, E, R>(
    policy: HttpClientContractRequestPolicy,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    harness.withPolicy === undefined ? effect : harness.withPolicy(policy, effect);

  yield* requireHttpClientContract(
    HttpClient.isHttpClient(service),
    "the service is an Effect HttpClient",
    service,
  );

  const payload = new TextEncoder().encode("http client contract payload");
  const okUrl = "https://contract.test/resource.bin";
  yield* harness.serveSource(okUrl, payload);

  const response = yield* service
    .get(okUrl)
    .pipe(Effect.mapError(failWith("a get to an https source succeeds")));
  yield* requireHttpClientContract(
    response.status >= 200 && response.status < 400,
    "get returns a non-error status for a served https source",
    response.status,
  );

  const streamUrl = "https://contract.test/stream.bin";
  yield* harness.serveSource(streamUrl, payload);
  const streamed = yield* Effect.gen(function* () {
    const streamResponse = yield* service.get(streamUrl);
    return yield* collectByteStream(streamResponse.stream);
  }).pipe(Effect.mapError(failWith("a stream of an https source succeeds")));
  yield* requireHttpClientContract(
    bytesEqual(streamed, payload),
    "stream yields the source bytes without buffering loss",
    { expected: payload.length, actual: streamed.length },
  );

  const schemeResult = yield* Effect.result(service.get("ftp://contract.test/x"));
  yield* requireHttpClientContract(
    Result.isFailure(schemeResult),
    "an unsupported scheme is rejected",
    schemeResult,
  );

  const secret = "ULW-HTTP-SECRET-9f8e7d6c5b4a3";
  const secretUrl = `https://user:${secret}@contract.test/s?token=${secret}`;
  yield* harness.serveSource(secretUrl, payload);
  yield* withPolicy({ callerId: `caller-${secret}`, redactionTokens: [secret] }, service.get(secretUrl)).pipe(
    Effect.mapError(failWith("a secret-bearing request succeeds")),
  );
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
      .withTrust(proxiedTrust, service.get(proxyUrl))
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
      .withTrust(bypassTrust, service.get(proxyUrl))
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
      .withTrust(mergedTrust, service.get(mergeUrl))
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
      .withTrust(replaceTrust, service.get(mergeUrl))
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
    const offlineResult = yield* Effect.result(withPolicy({ offline: true }, service.get(offlineUrl)));
    const after = yield* offline.connectCount();
    yield* requireHttpClientContract(
      Result.isFailure(offlineResult),
      "an offline-only request fails",
      offlineResult,
    );
    yield* requireHttpClientContract(
      after === before,
      "an offline-only request fails before opening a connection",
      { before, after },
    );

    const unavailableResult = yield* Effect.result(offline.withOffline(service.get(offlineUrl)));
    yield* requireHttpClientContract(
      Result.isFailure(unavailableResult),
      "a transport-level offline failure is surfaced as a tagged error",
      unavailableResult,
    );
  }

  if (harness.interruption) {
    const probe = harness.interruption;
    const fiber = yield* Effect.forkChild(Effect.scoped(probe.run()));
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
    const timeoutResult = yield* Effect.result(Effect.scoped(probe.run(10)));
    yield* requireHttpClientContract(
      Result.isFailure(timeoutResult),
      "a request exceeding the timeout fails with a tagged error",
      timeoutResult,
    );
    yield* requireHttpClientContract(
      Result.isFailure(timeoutResult) && typeof httpErrorLeft(timeoutResult.failure)._tag === "string",
      "a timed-out request fails with a tagged http error",
      timeoutResult,
    );
    const reaped = yield* probe.reaped();
    yield* requireHttpClientContract(reaped, "a timed-out request reaps the in-flight connection", reaped);
  }
});

/** Alias matching the other plugin-abstraction contract kits. */
export const makeHttpClientContractSuite = runHttpClientContract;
