import { Clock, Duration, Effect, Ref } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";

import { ScannerError } from "@lando/sdk/errors";
import { type ProbeOutcome, ProbeTimeoutError, runProbe } from "@lando/sdk/probe";
import type { AppId, AppPlan, ScanPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ScanAttempt, ScanEndpoint, ScanVerdict } from "@lando/sdk/services";

import { RequestPolicy } from "@lando/http-client/live";
import type { ScanSourceEndpoint } from "./connection-targets.ts";
export { type ScanSourceEndpoint, publishedHostPort, scanTargets } from "./connection-targets.ts";

export const SCANNER_ID = "http-probe";

/**
 * Scanner tuning knobs. `retry` is the TOTAL attempt count including the
 * first attempt. App-owned answers are final; infrastructure errors retry.
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

export interface UrlScannerDeps {
  readonly http: HttpClient.HttpClient;
  readonly listEndpoints: (
    appId: AppId,
    plan?: AppPlan,
  ) => Effect.Effect<ReadonlyArray<ScanSourceEndpoint>, ScannerError>;
  readonly onAttempt?: (attempt: ScanAttempt) => Effect.Effect<void>;
}

type AttemptStatus =
  | { readonly _tag: "response"; readonly status: number; readonly routerMarker?: string }
  | { readonly _tag: "transport"; readonly message: string }
  | { readonly _tag: "timeout" };

export interface ScanTarget {
  readonly service: ServiceName;
  readonly url: string;
}

const isAccepted = (status: number, okCodes: ReadonlyArray<number>): boolean =>
  (status >= 200 && status < 300) || okCodes.includes(status);

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
  state: {
    readonly target: ScanTarget;
    readonly status: Ref.Ref<AttemptStatus>;
    readonly attempts: Ref.Ref<number>;
    readonly redactor: Redactor;
    readonly verdict: Ref.Ref<ScanVerdict>;
    readonly startedAt: number;
  },
): Effect.fn.Return<ProbeOutcome> {
  const { target, status } = state;
  const timeoutMs = Math.min(config.timeoutSeconds * 1000, config.deadlineMs ?? Number.POSITIVE_INFINITY);
  const completed = yield* Effect.timeoutOrElse(
    Effect.map(
      Effect.result(
        Effect.scoped(
          deps.http.get(target.url).pipe(
            Effect.provideService(RequestPolicy, {
              redirect: config.maxRedirects > 0 ? "follow" : "manual",
              callerId: "url-scanner",
            }),
            Effect.map((response): AttemptStatus => {
              const routerMarker = response.headers["x-lando-router"];
              return {
                _tag: "response",
                status: response.status,
                ...(routerMarker === undefined ? {} : { routerMarker }),
              };
            }),
          ),
        ),
      ),
      (result) => result,
    ),
    { duration: Duration.millis(timeoutMs), orElse: () => Effect.succeed((() => "timeout" as const)()) },
  );

  if (completed === "timeout") {
    yield* Ref.set(status, { _tag: "timeout" });
  } else if (completed._tag === "Failure") {
    const message = transportMessage(completed.failure);
    yield* Ref.set(status, { _tag: "transport", message });
  } else {
    yield* Ref.set(status, completed.success);
  }
  const finalStatus = yield* Ref.get(status);
  const verdict = classify(finalStatus, config.okCodes);
  yield* Ref.set(state.verdict, verdict);
  const outcome = finalStatus._tag === "response" ? (verdict === "ready" ? "green" : "yellow") : "red";
  const attempt = yield* Ref.updateAndGet(state.attempts, (count) => count + 1);
  const observedAt = yield* Clock.currentTimeMillis;
  const onAttempt = deps.onAttempt;
  if (onAttempt !== undefined) {
    const maxAttempts = Math.max(1, config.retry);
    yield* Effect.suspend(() =>
      onAttempt({
        ...target,
        attempt,
        maxAttempts,
        outcome,
        verdict,
        willRetry:
          (verdict === "lando-error" || verdict === "service-error") &&
          attempt < maxAttempts &&
          (config.deadlineMs === undefined ||
            observedAt + config.delaySeconds * 1000 < state.startedAt + config.deadlineMs),
        ...(finalStatus._tag === "response" ? { statusCode: finalStatus.status } : {}),
        detail: state.redactor.redactString(redDetail(finalStatus, timeoutMs)),
      }),
    ).pipe(Effect.catchCause(() => Effect.void));
  }
  // runProbe stops only on green. Final app answers stop it without losing their real verdict.
  return verdict === "ready" || verdict === "app-error" ? "green" : outcome;
});

const classify = (status: AttemptStatus, okCodes: ReadonlyArray<number>): ScanVerdict => {
  switch (status._tag) {
    case "transport":
    case "timeout":
      return "lando-error";
    case "response":
      if (status.routerMarker !== undefined) return "lando-error";
      if (isAccepted(status.status, okCodes)) return "ready";
      // 502 and 504 are gateway statuses a web server sends when it cannot reach the app
      // runtime; a 503 is usually the app itself (maintenance mode), so it stays app-owned.
      return status.status === 502 || status.status === 504 ? "service-error" : "app-error";
  }
};

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
  const attempts = yield* Ref.make(0);
  const verdictRef = yield* Ref.make<ScanVerdict>("lando-error");
  const startedAt = yield* Clock.currentTimeMillis;

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
    makeAttempt(deps, config, { target, status, attempts, redactor, verdict: verdictRef, startedAt }),
  ).pipe(Effect.mapError((cause) => probeRunError(target.url, cause, redactor)));
  const finalStatus = yield* Ref.get(status);
  const statusCode = finalStatus._tag === "response" ? finalStatus.status : undefined;

  const deadline =
    result.lastError instanceof ProbeTimeoutError ||
    (result.outcome !== "green" && config.deadlineMs !== undefined && result.elapsedMs >= config.deadlineMs);
  const verdict = deadline ? "lando-error" : yield* Ref.get(verdictRef);
  const response = !deadline && finalStatus._tag === "response";
  return {
    service: target.service,
    url: target.url,
    reachable: response,
    verdict,
    ...(response && statusCode !== undefined ? { statusCode } : {}),
    ...(response && finalStatus.routerMarker !== undefined
      ? { routerMarker: redactor.redactString(finalStatus.routerMarker) }
      : {}),
    outcome: response ? (verdict === "ready" ? "green" : "yellow") : "red",
    ...(verdict === "ready"
      ? {}
      : {
          detail: redactor.redactString(
            deadline || (config.deadlineMs !== undefined && result.elapsedMs >= config.deadlineMs)
              ? `deadline exceeded after ${result.elapsedMs}ms`
              : redDetail(finalStatus, result.elapsedMs),
          ),
        }),
  };
});
