import { Duration, Effect, Ref } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";

import { ScannerError } from "@lando/sdk/errors";
import { type ProbeOutcome, ProbeTimeoutError, runProbe } from "@lando/sdk/probe";
import type {
  AppId,
  BindAddress,
  PortNumber,
  PublishedEndpoint,
  ScanPlan,
  ServiceName,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ScanEndpoint } from "@lando/sdk/services";

import { RequestPolicy } from "@lando/http-client/live";

export const SCANNER_ID = "http-probe";

/**
 * Scanner tuning knobs. `retry` is the TOTAL attempt count including the
 * first attempt. A response is accepted (`green`) when its status is 2xx or
 * listed in `okCodes`; any other response is `yellow`; no response is `red`.
 * Redirect policy is binary: `0` sends `redirect: "manual"` (a redirect
 * surfaces as its 3xx status), any positive value sends `redirect: "follow"`.
 */
export interface UrlScanConfig {
  readonly enabled: boolean;
  readonly retry: number;
  readonly delaySeconds: number;
  readonly timeoutSeconds: number;
  readonly deadlineMs?: number;
  readonly path: string;
  readonly okCodes: ReadonlyArray<number>;
  readonly maxRedirects: number;
}

export const defaultUrlScanConfig: UrlScanConfig = {
  enabled: true,
  retry: 3,
  delaySeconds: 1,
  timeoutSeconds: 5,
  deadlineMs: 20000,
  path: "/",
  okCodes: [],
  maxRedirects: 0,
};

export const scanConfigFromPlan = (scan: ScanPlan, base: UrlScanConfig): UrlScanConfig => ({
  ...base,
  enabled: scan.enabled,
  path: scan.path,
  okCodes: scan.okCodes,
  retry: scan.retries + 1,
  deadlineMs: scan.timeoutMs,
});

export type ScanSourceEndpoint = PublishedEndpoint & {
  readonly service: ServiceName;
  readonly materialization?:
    | {
        readonly bindAddress: BindAddress;
        readonly hostPort: PortNumber;
      }
    | undefined;
};

export interface UrlScannerDeps {
  readonly http: HttpClient.HttpClient;
  readonly listEndpoints: (appId: AppId) => Effect.Effect<ReadonlyArray<ScanSourceEndpoint>, ScannerError>;
}

type AttemptStatus =
  | { readonly _tag: "response"; readonly status: number }
  | { readonly _tag: "transport"; readonly message: string }
  | { readonly _tag: "timeout" };

export interface ScanTarget {
  readonly service: ServiceName;
  readonly url: string;
}

const isAccepted = (status: number, okCodes: ReadonlyArray<number>): boolean =>
  (status >= 200 && status < 300) || okCodes.includes(status);

const buildUrl = (protocol: "http" | "https", host: string, port: number, path: string): string => {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `${protocol}://${urlHost}:${port}${path.startsWith("/") ? path : `/${path}`}`;
};

export const publishedHostPort = (endpoint: ScanSourceEndpoint): PortNumber | undefined =>
  endpoint.materialization?.hostPort ?? endpoint.publication.hostPort;

export const scanTargets = (
  endpoints: ReadonlyArray<ScanSourceEndpoint>,
  path: string,
): ReadonlyArray<ScanTarget> =>
  endpoints.flatMap((endpoint) =>
    endpoint.protocol === "http" || endpoint.protocol === "https"
      ? (() => {
          const hostPort = publishedHostPort(endpoint);
          if (hostPort === undefined) return [];
          const resolvedHost =
            endpoint.materialization?.bindAddress ?? endpoint.publication.bindAddress ?? "127.0.0.1";
          const host =
            resolvedHost === "127.0.0.1" || resolvedHost === "0.0.0.0" ? "localhost" : resolvedHost;
          return [{ service: endpoint.service, url: buildUrl(endpoint.protocol, host, hostPort, path) }];
        })()
      : [],
  );

const transportMessage = (error: HttpClientError.HttpClientError): string => {
  const reason = error.reason;
  if (reason._tag === "TransportError") {
    const cause = reason.cause;
    if (cause instanceof Error) return cause.message;
    if (typeof cause === "string") return cause;
  }
  return error.message;
};

const makeAttempt = Effect.fnUntraced(function* (
  deps: UrlScannerDeps,
  config: UrlScanConfig,
  url: string,
  status: Ref.Ref<AttemptStatus>,
): Effect.fn.Return<ProbeOutcome> {
  const timeoutMs = Math.min(config.timeoutSeconds * 1000, config.deadlineMs ?? Number.POSITIVE_INFINITY);
  const completed = yield* Effect.timeoutOrElse(
    Effect.map(
      Effect.result(
        Effect.scoped(
          deps.http.get(url).pipe(
            Effect.provideService(RequestPolicy, {
              redirect: config.maxRedirects > 0 ? "follow" : "manual",
              callerId: "url-scanner",
            }),
            Effect.map((response) => response.status),
          ),
        ),
      ),
      (result) => result,
    ),
    { duration: Duration.millis(timeoutMs), orElse: () => Effect.succeed((() => "timeout" as const)()) },
  );

  if (completed === "timeout") {
    yield* Ref.set(status, { _tag: "timeout" });
    return "red";
  }

  if (completed._tag === "Failure") {
    const failure = completed.failure;
    const message =
      typeof failure === "object" &&
      failure !== null &&
      "_tag" in failure &&
      (failure as { _tag: string })._tag === "HttpClientError"
        ? transportMessage(failure as HttpClientError.HttpClientError)
        : failure instanceof Error
          ? failure.message
          : String(failure);
    yield* Ref.set(status, { _tag: "transport", message });
    return "red";
  }

  yield* Ref.set(status, { _tag: "response", status: completed.success });
  return isAccepted(completed.success, config.okCodes) ? "green" : "yellow";
});

const probeRunError = (url: string, cause: unknown, redactor: Redactor): ScannerError =>
  new ScannerError({
    message: redactor.redactString(
      `URL probe for ${url} could not run. Re-run the scan after checking the app status.`,
    ),
    scannerId: SCANNER_ID,
    cause: redactor.redactValue(cause),
  });

const redDetail = (finalStatus: AttemptStatus, elapsedMs: number): string => {
  switch (finalStatus._tag) {
    case "timeout":
      return `timeout after ${elapsedMs}ms`;
    case "transport":
      return finalStatus.message;
    case "response":
      return `HTTP ${finalStatus.status}`;
  }
};

export const scanTarget = Effect.fnUntraced(function* (
  deps: UrlScannerDeps,
  config: UrlScanConfig,
  redactor: Redactor,
  target: ScanTarget,
): Effect.fn.Return<ScanEndpoint, ScannerError> {
  const status = yield* Ref.make<AttemptStatus>({
    _tag: "transport",
    message: "URL probe did not run",
  });

  const result = yield* runProbe(
    {
      id: `scanner:${target.url}`,
      policy: {
        maxAttempts: Math.max(1, config.retry),
        delay: Duration.seconds(config.delaySeconds),
        backoff: "fixed",
        ...(config.deadlineMs === undefined ? {} : { timeout: Duration.millis(config.deadlineMs) }),
      },
      classify: {
        success: (value) => (value === "green" ? "green" : value === "yellow" ? "yellow" : "red"),
        failure: () => "red",
      },
    },
    makeAttempt(deps, config, target.url, status),
  ).pipe(Effect.mapError((cause) => probeRunError(target.url, cause, redactor)));
  const finalStatus = yield* Ref.get(status);
  const statusCode = finalStatus._tag === "response" ? finalStatus.status : undefined;

  if (result.outcome === "green") {
    return {
      service: target.service,
      url: target.url,
      reachable: true,
      ...(statusCode === undefined ? {} : { statusCode }),
      outcome: "green" as const,
    };
  }

  if (result.outcome === "yellow") {
    return {
      service: target.service,
      url: target.url,
      reachable: true,
      ...(statusCode === undefined ? {} : { statusCode }),
      outcome: "yellow" as const,
      detail: redactor.redactString(`HTTP ${statusCode}`),
    };
  }

  return {
    service: target.service,
    url: target.url,
    reachable: false,
    outcome: "red" as const,
    detail: redactor.redactString(
      result.lastError instanceof ProbeTimeoutError ||
        (config.deadlineMs !== undefined && result.elapsedMs >= config.deadlineMs)
        ? `deadline exceeded after ${result.elapsedMs}ms`
        : redDetail(finalStatus, result.elapsedMs),
    ),
  };
});
