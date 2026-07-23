import { Duration, Effect, Ref } from "effect";

import { ScannerError } from "@lando/sdk/errors";
import { type ProbeOutcome, runProbe } from "@lando/sdk/probe";
import type { AppId, BindAddress, PortNumber, PublishedEndpoint, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ScanEndpoint } from "@lando/sdk/services";

import type { HttpClientShape } from "../../http-client/service.ts";

export const SCANNER_ID = "http-probe";

/**
 * Scanner tuning knobs. `retry` is the TOTAL attempt count including the
 * first attempt. A response is accepted (`green`) when its status is 2xx or
 * listed in `okCodes`; any other response is `yellow`; no response is `red`.
 * `HttpRequest` has no redirect-count cap, so `maxRedirects` is binary: `0`
 * sends `redirect: "manual"` (a redirect surfaces as its 3xx status), any
 * positive value sends `redirect: "follow"`.
 */
export interface UrlScanConfig {
  readonly enabled: boolean;
  readonly retry: number;
  readonly delaySeconds: number;
  readonly timeoutSeconds: number;
  readonly path: string;
  readonly okCodes: ReadonlyArray<number>;
  readonly maxRedirects: number;
}

export const defaultUrlScanConfig: UrlScanConfig = {
  enabled: true,
  retry: 3,
  delaySeconds: 1,
  timeoutSeconds: 5,
  path: "/",
  okCodes: [],
  maxRedirects: 0,
};

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
  readonly request: HttpClientShape["request"];
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

const makeAttempt = (
  deps: UrlScannerDeps,
  config: UrlScanConfig,
  url: string,
  status: Ref.Ref<AttemptStatus>,
): Effect.Effect<ProbeOutcome> =>
  Effect.gen(function* () {
    const completed = yield* Effect.timeoutTo(
      Effect.either(
        Effect.scoped(
          deps.request({
            url,
            method: "GET",
            timeoutMs: config.timeoutSeconds * 1000,
            redirect: config.maxRedirects > 0 ? "follow" : "manual",
            callerId: "url-scanner",
          }),
        ),
      ),
      {
        duration: Duration.seconds(config.timeoutSeconds),
        onSuccess: (result) => result,
        onTimeout: () => "timeout" as const,
      },
    );

    if (completed === "timeout") {
      yield* Ref.set(status, { _tag: "timeout" });
      return "red";
    }

    if (completed._tag === "Left") {
      yield* Ref.set(status, { _tag: "transport", message: completed.left.message });
      return "red";
    }

    yield* Ref.set(status, { _tag: "response", status: completed.right.status });
    return isAccepted(completed.right.status, config.okCodes) ? "green" : "yellow";
  });

const probeRunError = (url: string, cause: unknown, redactor: Redactor): ScannerError =>
  new ScannerError({
    message: redactor.redactString(
      `URL probe for ${url} could not run. Re-run the scan after checking the app status.`,
    ),
    scannerId: SCANNER_ID,
    cause: redactor.redactValue(cause),
  });

const redDetail = (finalStatus: AttemptStatus, timeoutSeconds: number): string => {
  switch (finalStatus._tag) {
    case "timeout":
      return `timeout after ${timeoutSeconds}s`;
    case "transport":
      return finalStatus.message;
    case "response":
      return `HTTP ${finalStatus.status}`;
  }
};

export const scanTarget = (
  deps: UrlScannerDeps,
  config: UrlScanConfig,
  redactor: Redactor,
  target: ScanTarget,
): Effect.Effect<ScanEndpoint, ScannerError> =>
  Effect.gen(function* () {
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
      detail: redactor.redactString(redDetail(finalStatus, config.timeoutSeconds)),
    };
  });
