import { RequestPolicy } from "@lando/http-client/live";
import { mapFailures } from "@lando/sdk/command-result";
import { ScannerError } from "@lando/sdk/errors";
import { type ProbeOutcome, ProbeTimeoutError, runProbe } from "@lando/sdk/probe";
import type { AppId, AppPlan, ScanPlan, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import type { ScanAttempt, ScanEndpoint, ScanVerdict } from "@lando/sdk/services";
import { Clock, Duration, Effect, Predicate, Ref } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import { type AttemptStatus, type ScanClassification, classify } from "./classify.ts";
import type { ScanSourceService } from "./connection-targets.ts";

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
  ) => Effect.Effect<ReadonlyArray<ScanSourceService>, ScannerError>;
  readonly onAttempt?: (attempt: ScanAttempt) => Effect.Effect<void>;
}

export interface ScanTarget {
  readonly service: ServiceName;
  readonly url: string;
  readonly idlePort?: number;
}

const retries = (verdict: ScanVerdict): boolean => verdict === "lando-error" || verdict === "service-error";

/** Bun appends a developer hint to fetch transport errors; it means nothing to a Lando user. */
const BUN_FETCH_HINT =
  /\s*For more information, pass `verbose: true` in the second argument to fetch\(\)\.?$/u;

export const transportMessage = (error: HttpClientError.HttpClientError): string => {
  const reason = error.reason;
  if (reason._tag === "TransportError") {
    const cause = reason.cause;
    if (cause instanceof Error) return cause.message.replace(BUN_FETCH_HINT, "");
    if (typeof cause === "string") return cause.replace(BUN_FETCH_HINT, "");
  }
  return error.message.replace(BUN_FETCH_HINT, "");
};

const makeAttempt = Effect.fnUntraced(function* (
  deps: UrlScannerDeps,
  config: UrlScanConfig,
  state: {
    readonly target: ScanTarget;
    readonly status: Ref.Ref<AttemptStatus>;
    readonly attempts: Ref.Ref<number>;
    readonly redactor: Redactor;
    readonly classification: Ref.Ref<ScanClassification>;
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
              const location =
                response.status >= 300 && response.status < 400 ? response.headers.location : undefined;
              return {
                _tag: "response",
                status: response.status,
                ...(routerMarker === undefined ? {} : { routerMarker }),
                ...(location === undefined ? {} : { location }),
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
    const { reason } = completed.failure;
    const refused =
      reason._tag === "TransportError" &&
      Predicate.hasProperty(reason.cause, "code") &&
      reason.cause.code === "ECONNREFUSED";
    yield* Ref.set(status, { _tag: "transport", message, refused });
  } else {
    yield* Ref.set(status, completed.success);
  }
  const finalStatus = yield* Ref.get(status);
  const classification = classify(finalStatus, config.okCodes, { ...target, redactor: state.redactor });
  const { verdict, detail } = classification;
  yield* Ref.set(state.classification, classification);
  const outcome = finalStatus._tag === "response" ? (verdict === "ready" ? "green" : "yellow") : "red";
  const attempt = yield* Ref.updateAndGet(state.attempts, (count) => count + 1);
  const observedAt = yield* Clock.currentTimeMillis;
  const onAttempt = deps.onAttempt;
  if (onAttempt !== undefined) {
    const maxAttempts = Math.max(1, config.retry);
    yield* Effect.suspend(() =>
      onAttempt({
        service: target.service,
        url: target.url,
        attempt,
        maxAttempts,
        outcome,
        verdict,
        willRetry:
          retries(verdict) &&
          attempt < maxAttempts &&
          (config.deadlineMs === undefined ||
            observedAt + config.delaySeconds * 1000 < state.startedAt + config.deadlineMs),
        ...(finalStatus._tag === "response" ? { statusCode: finalStatus.status } : {}),
        detail: detail ?? state.redactor.redactString(redDetail(finalStatus, timeoutMs)),
      }),
    ).pipe(Effect.catchCause(() => Effect.void));
  }
  // runProbe stops only on green. Keep the classified verdict and observed outcome separate.
  return retries(verdict) ? outcome : "green";
});

const probeRunError = (url: string, cause: unknown, redactor: Redactor): ScannerError =>
  new ScannerError({
    message: redactor.redactString(
      `URL probe for ${url} could not run. Re-run the scan after checking the app status.`,
    ),
    scannerId: SCANNER_ID,
    cause: redactor.redactValue(cause),
    remediation:
      "Start the app services and ensure a scanner implementation is installed, then re-run URL checks.",
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
  const classification = yield* Ref.make<ScanClassification>({ verdict: "lando-error" });
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
    makeAttempt(deps, config, { target, status, attempts, redactor, classification, startedAt }),
  ).pipe(mapFailures((cause) => probeRunError(target.url, cause, redactor)));
  const finalStatus = yield* Ref.get(status);
  const statusCode = finalStatus._tag === "response" ? finalStatus.status : undefined;

  const deadline =
    result.lastError instanceof ProbeTimeoutError ||
    (result.outcome !== "green" && config.deadlineMs !== undefined && result.elapsedMs >= config.deadlineMs);
  const observed = yield* Ref.get(classification);
  const verdict = deadline ? "lando-error" : observed.verdict;
  const detail = deadline
    ? `deadline exceeded after ${result.elapsedMs}ms`
    : (observed.detail ??
      (verdict === "ready" ? undefined : redactor.redactString(redDetail(finalStatus, result.elapsedMs))));
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
    ...(detail === undefined ? {} : { detail }),
  };
});
