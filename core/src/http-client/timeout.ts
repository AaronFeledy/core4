import { Duration, Effect, type Scope } from "effect";

import { HttpRequestError } from "@lando/sdk/errors";
import type { HttpRequest } from "@lando/sdk/schema";

const timeoutUrlOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

export const httpTimeoutError = (url: string, timeoutMs: number): HttpRequestError =>
  new HttpRequestError({
    message: `request exceeded timeoutMs=${timeoutMs}`,
    urlOrigin: timeoutUrlOrigin(url),
    remediation: "Increase timeoutMs or check the remote host and network path.",
  });

export const applyHttpTimeout = <A, R>(
  request: HttpRequest,
  effect: Effect.Effect<A, HttpRequestError, R>,
): Effect.Effect<A, HttpRequestError, R | Scope.Scope> => {
  const timeoutMs = request.timeoutMs;
  if (timeoutMs === undefined || timeoutMs <= 0) return effect;
  return Effect.timeoutFail(effect, {
    duration: Duration.millis(timeoutMs),
    onTimeout: () => httpTimeoutError(request.url, timeoutMs),
  });
};
