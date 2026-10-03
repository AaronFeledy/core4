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
  readonly fetch?: typeof fetch;
  readonly systemCaPems?: SystemCaProvider;
  readonly direct?: DirectHttpTransport;
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

const resolveTrust = Effect.fnUntraced(function* (context: Context.Context<never>) {
  const injected = Context.getOption(context, NetworkTrust);
  if (Option.isSome(injected)) return injected.value;
  const config = Context.getOption(context, ConfigService);
  if (Option.isNone(config)) return undefined;
  const globalConfig = yield* config.value.load.pipe(Effect.catch(() => Effect.succeed(undefined)));
  const plan = yield* Effect.try({
    try: () => resolveNetworkTrustPlan(globalConfig === undefined ? {} : { network: globalConfig.network }),
    catch: (cause) =>
      new HttpTrustError({
        message: cause instanceof Error ? cause.message : "Could not resolve network trust",
        urlOrigin: "unknown",
        kind: "missing-custom-ca",
        remediation: "Check network.ca.certs and LANDO_NETWORK_CA_CERTS.",
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
  const transports = {
    fetch: options.fetch ?? globalThis.fetch,
    direct: options.direct ?? directHttpRequest,
  };
  const systemCaPems = options.systemCaPems ?? defaultSystemCaPems;
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
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
          yield* Effect.annotateCurrentSpan({ "http.request.method": request.method, "url.full": safeUrl });
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
            const resolved = yield* resolveTrust(fiber.context).pipe(
              Effect.mapError((cause) => transportError(safeRequest, cause)),
            );
            const hostCaPems = process.platform === "win32" || resolved !== undefined ? systemCaPems() : [];
            const trust = withWindowsHostTrust(resolved, hostCaPems);
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
                  },
                  { transports, trust, systemCaPems: hostCaPems },
                  AbortSignal.any([signal, controller.signal]),
                ),
              catch: (cause) =>
                transportError(
                  safeRequest,
                  url.protocol === "https:" &&
                    cause instanceof Error &&
                    /cert|tls|ssl|self.signed|issuer/i.test(cause.message)
                    ? new HttpTrustError({
                        message: "TLS trust verification failed",
                        urlOrigin: url.origin,
                        kind: "missing-custom-ca",
                        remediation:
                          "Supply the issuer CA through network.ca.certs or LANDO_NETWORK_CA_CERTS.",
                        cause,
                      })
                    : cause,
                ),
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
