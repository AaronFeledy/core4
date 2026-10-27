import { RedactionService } from "@lando/redaction/service";
import { HttpTrustError } from "@lando/sdk/errors";
import { PostHttpCallEvent, PreHttpCallEvent } from "@lando/sdk/events";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";
import { ConfigService, EventService } from "@lando/sdk/services";
import { Clock, Context, DateTime, Effect, Exit, Layer, Option, Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { type DirectHttpTransport, directHttpRequest } from "./direct-http.ts";
import { requestWithNetworkTrust } from "./network-request.ts";
import {
  NetworkTrust,
  type ResolvedNetworkTrust,
  type SystemCaProvider,
  defaultSystemCaPems,
  loadCaPems,
  resolveNetworkTrustPlan,
  withWindowsHostTrust,
} from "./network-trust.ts";
import { RequestPolicy, type RequestPolicyShape } from "./policy.ts";
import { requestBody } from "./request-body.ts";
import { failureDetail, observeResponse } from "./response-events.ts";

export { RequestPolicy, type RequestPolicyShape } from "./policy.ts";

export interface ClientOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly direct?: DirectHttpTransport;
  readonly systemCaPems?: SystemCaProvider;
}

/** Strip credentials and all query values before a URL reaches telemetry. */
const redactedUrl = (url: URL, policy: RequestPolicyShape): string => {
  const safe = new URL(url);
  safe.username = "";
  safe.password = "";
  for (const key of new Set(safe.searchParams.keys())) safe.searchParams.set(key, REDACTED);
  safe.hash = "";
  return createRedactor("secrets", { values: policy.redactionTokens ?? [] }).redactString(safe.href);
};

const transportError = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
  new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) });

const isProxyTunnelError = (cause: unknown): cause is Error & { code: "ERR_PROXY_TUNNEL"; status: number } =>
  cause instanceof Error &&
  "code" in cause &&
  cause.code === "ERR_PROXY_TUNNEL" &&
  "status" in cause &&
  typeof cause.status === "number";

const trustFailure = (url: URL, cause: unknown, redact: (value: string) => string): unknown => {
  if (isProxyTunnelError(cause)) {
    return new HttpTrustError({
      message: redact(cause.message),
      urlOrigin: url.origin,
      kind: "proxy-tunnel-refused",
      remediation: `Proxy answered ${cause.status}; check network.proxy / HTTPS_PROXY credentials or add the host to network.proxy.noProxy / NO_PROXY.`,
      cause,
    });
  }
  if (
    url.protocol === "https:" &&
    cause instanceof Error &&
    /cert|tls|ssl|self.signed|issuer/i.test(cause.message)
  ) {
    return new HttpTrustError({
      message: "TLS trust verification failed",
      urlOrigin: url.origin,
      kind: "missing-custom-ca",
      remediation: "Supply the issuer CA through network.ca.certs or LANDO_NETWORK_CA_CERTS.",
      cause,
    });
  }
  return cause;
};

const resolveTrust = Effect.fnUntraced(function* (
  context: Context.Context<never>,
  injected: ResolvedNetworkTrust | undefined,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (injected !== undefined) return injected;
  const config = Context.getOption(context, ConfigService);
  if (Option.isNone(config)) return undefined;
  const globalConfig = yield* config.value.load;
  const plan = yield* Effect.try({
    try: () => resolveNetworkTrustPlan({ network: globalConfig.network }, env),
    catch: (cause) =>
      new HttpTrustError({
        message: cause instanceof Error ? cause.message : "Could not resolve network trust",
        urlOrigin: "unknown",
        kind: "missing-custom-ca",
        remediation:
          "Check network.ca.certs, LANDO_NETWORK_CA_CERTS, and proxy trust settings (HTTPS_PROXY / network.proxy), then retry.",
        cause,
      }),
  });
  const loaded = yield* loadCaPems(plan.caCertPaths).pipe(
    Effect.mapError(
      (cause) =>
        new HttpTrustError({
          message: cause.message,
          urlOrigin: "unknown",
          kind: "missing-custom-ca",
          remediation: cause.remediation,
          cause,
        }),
    ),
  );
  return { proxy: plan.proxy, caPems: loaded.map((cert) => cert.pem), trustHost: plan.trustHost };
});

export const layerWith = (options: ClientOptions = {}): Layer.Layer<HttpClient.HttpClient> => {
  const env = { ...(options.env ?? process.env) };
  const systemCaPems = options.systemCaPems ?? defaultSystemCaPems;
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      // Each layer owns a pool isolated from plugins' global fetch connections.
      // Keep session defaults neutral: per-request SDK trust decides proxy and CA.
      const session = yield* Effect.acquireRelease(
        Effect.sync(() => new Bun.FetchSession()),
        (session) => Effect.sync(() => session.close()),
      );
      const transports = {
        fetch: options.fetch ?? session.fetch,
        direct: options.direct ?? directHttpRequest,
      };
      const layerContext = yield* Effect.context<never>();
      const layerEvents = yield* Effect.serviceOption(EventService);
      const client = HttpClient.make((request, url, signal, fiber) => {
        const policy = fiber.getRef(RequestPolicy);
        const safeUrl = redactedUrl(url, policy);
        const safeRequest = HttpClientRequest.setUrlParams(HttpClientRequest.setUrl(request, safeUrl), []);
        const redact = createRedactor("secrets", { values: policy.redactionTokens ?? [] }).redactString;
        const eventService = Option.orElse(Context.getOption(fiber.context, EventService), () => layerEvents);
        const publish = (event: Parameters<EventService["Service"]["publish"]>[0]) =>
          Option.isSome(eventService)
            ? eventService.value.publish(event).pipe(Effect.catchCause(() => Effect.void))
            : Effect.void;
        const execute = Effect.fn("HttpClient.request")(function* () {
          const canonical = Context.getOption(fiber.context, RedactionService);
          const spanUrl = Option.isNone(canonical)
            ? safeUrl
            : (yield* canonical.value.forProfile("secrets", {
                sourceEnv: env,
                redactionTokens: policy.redactionTokens,
              })).redactString(safeUrl);
          yield* Effect.annotateCurrentSpan({ "http.request.method": request.method, "url.full": spanUrl });
          const startedAt = yield* Clock.currentTimeMillis;
          const timestamp = yield* DateTime.now;
          const correlation = {
            ...(policy.callerId === undefined ? {} : { callerId: redact(policy.callerId) }),
            ...(policy.onBehalfOf === undefined ? {} : { onBehalfOf: redact(policy.onBehalfOf) }),
          };
          yield* publish(
            PreHttpCallEvent.make({
              eventName: "pre-http-call",
              urlOrigin: url.origin,
              method: request.method,
              timestamp,
              ...correlation,
            }),
          );
          const controller = new AbortController();
          const scoped = yield* Effect.serviceOption(Scope.Scope);
          let published = false;
          let status: number | undefined = undefined;
          const complete = Effect.fnUntraced(function* (exit: Exit.Exit<unknown, unknown>) {
            if (published) return;
            published = true;
            const endedAt = yield* Clock.currentTimeMillis;
            const timestamp = yield* DateTime.now;
            yield* publish(
              PostHttpCallEvent.make({
                eventName: "post-http-call",
                urlOrigin: url.origin,
                method: request.method,
                timestamp,
                durationMs: endedAt - startedAt,
                ...correlation,
                ...(status === undefined ? {} : { status }),
                ...(Exit.isSuccess(exit)
                  ? { outcome: "success" as const }
                  : { outcome: "failure" as const, failureDetail: redact(failureDetail(exit)) }),
              }),
            );
          }, Effect.uninterruptible);
          if (Option.isSome(scoped))
            yield* Scope.addFinalizerExit(scoped.value, (exit) =>
              Effect.andThen(
                Effect.sync(() => controller.abort()),
                complete(exit),
              ),
            );
          const response = yield* Effect.gen(function* () {
            if (policy.offline === true)
              return yield* Effect.fail(
                transportError(safeRequest, "offline-only request cannot open a connection"),
              );
            if (url.protocol === "file:") {
              if (policy.allowFileSource !== true)
                return yield* Effect.fail(transportError(safeRequest, "file:// source not permitted"));
              const file = Bun.file(url);
              const exists = yield* Effect.promise(() => file.exists());
              if (!exists)
                return yield* Effect.fail(transportError(safeRequest, "file source does not exist"));
              return HttpClientResponse.fromWeb(safeRequest, new Response(file.stream()));
            }
            if (url.protocol !== "http:" && url.protocol !== "https:")
              return yield* Effect.fail(transportError(safeRequest, "unsupported scheme"));
            const resolved = yield* resolveTrust(
              Context.merge(layerContext, fiber.context),
              fiber.getRef(NetworkTrust),
              env,
            ).pipe(Effect.mapError((cause) => transportError(safeRequest, cause)));
            const hostCaPems = process.platform === "win32" || resolved !== undefined ? systemCaPems() : [];
            const trust = resolved === undefined ? undefined : withWindowsHostTrust(resolved, hostCaPems);
            const body = yield* requestBody(request);
            const web = yield* Effect.tryPromise({
              try: () =>
                requestWithNetworkTrust(
                  {
                    url: url.href,
                    method: request.method,
                    headers: request.headers,
                    body,
                    redirect: policy.redirect ?? "follow",
                    connectionTarget: policy.connectionTarget,
                  },
                  { transports, trust, systemCaPems: hostCaPems },
                  AbortSignal.any([signal, controller.signal]),
                ),
              catch: (cause) => transportError(safeRequest, trustFailure(url, cause, redact)),
            });
            return HttpClientResponse.fromWeb(safeRequest, web);
          }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? complete(exit) : Effect.void)));
          status = response.status;
          return observeResponse(response, complete);
        });
        return execute();
      });
      // The standard runner records raw URL attributes before invoking its transport.
      // Disable those spans and use the redacted egress span above instead.
      return HttpClient.transformResponse(
        client,
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      );
    }),
  );
};

export const layer = layerWith();
