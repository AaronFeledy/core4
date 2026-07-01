import { Duration, Effect, Stream } from "effect";

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
  remainingMs = request.timeoutMs,
): Effect.Effect<A, HttpRequestError, R> => {
  const timeoutMs = request.timeoutMs;
  if (timeoutMs === undefined || timeoutMs <= 0) return effect;
  if (remainingMs === undefined || remainingMs <= 0)
    return Effect.fail(httpTimeoutError(request.url, timeoutMs));
  return Effect.timeoutFail(effect, {
    duration: Duration.millis(remainingMs),
    onTimeout: () => httpTimeoutError(request.url, timeoutMs),
  });
};

export const applyHttpStreamTimeout = <A, R>(
  request: HttpRequest,
  stream: Stream.Stream<A, HttpRequestError, R>,
  remainingMs = request.timeoutMs,
): Stream.Stream<A, HttpRequestError, R> => {
  const timeoutMs = request.timeoutMs;
  if (timeoutMs === undefined || timeoutMs <= 0) return stream;
  if (remainingMs === undefined || remainingMs <= 0)
    return Stream.fail(httpTimeoutError(request.url, timeoutMs));
  return stream.pipe(
    Stream.interruptWhen(
      Effect.sleep(Duration.millis(remainingMs)).pipe(
        Effect.flatMap(() => Effect.fail(httpTimeoutError(request.url, timeoutMs))),
      ),
    ),
  );
};
