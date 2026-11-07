import { Effect, Result, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { HttpTrustError } from "../errors/http-client.ts";
import { ContractFailure } from "./_shared.ts";

export interface HttpClientFailureHarness {
  readonly rejectNext: (url: string, code: string) => Effect.Effect<void>;
  readonly serveStatus: (url: string, status: number) => Effect.Effect<void>;
  readonly requestCount: (url: string) => Effect.Effect<number>;
}

export const runHttpClientFailureContract = Effect.fnUntraced(function* (
  service: HttpClient.HttpClient,
  harness: HttpClientFailureHarness,
) {
  for (const [code, kind] of [
    ["SELF_SIGNED_CERT_IN_CHAIN", "missing-custom-ca"],
    ["CERT_HAS_EXPIRED", "certificate-invalid"],
    ["ECONNRESET", undefined],
    ["EPROTO", undefined],
  ] as const) {
    const url = `https://contract.test/failure/${code}`;
    yield* harness.rejectNext(url, code);
    const result = yield* Effect.result(service.get(url));
    if (Result.isSuccess(result)) {
      return yield* Effect.fail(
        new ContractFailure({
          message: `HttpClient accepted a ${code} transport failure`,
          assertion: `${code} fails`,
        }),
      );
    }
    const reason = result.failure.reason;
    const trust =
      reason._tag === "TransportError" && Schema.is(HttpTrustError)(reason.cause) ? reason.cause : undefined;
    if (
      reason._tag !== "TransportError" ||
      (kind === undefined ? trust !== undefined : trust?.kind !== kind)
    ) {
      return yield* Effect.fail(
        new ContractFailure({
          message: `HttpClient misclassified ${code}`,
          assertion: `${code} has trust kind ${kind ?? "none"}`,
          details: result.failure,
        }),
      );
    }
    const count = yield* harness.requestCount(url);
    if (count !== 1) {
      return yield* Effect.fail(
        new ContractFailure({
          message: `HttpClient replayed ${code}`,
          assertion: "transport failures are sent once",
          details: count,
        }),
      );
    }
  }
  const url = "https://contract.test/status/503";
  yield* harness.serveStatus(url, 503);
  const response = yield* service.get(url).pipe(
    Effect.mapError(
      (details) =>
        new ContractFailure({
          message: "HttpClient rejected an HTTP 503 response",
          assertion: "HTTP status is returned",
          details,
        }),
    ),
  );
  const count = yield* harness.requestCount(url);
  if (response.status !== 503 || count !== 1) {
    return yield* Effect.fail(
      new ContractFailure({
        message: "HttpClient did not return HTTP 503 after one request",
        assertion: "HTTP status is never replayed",
        details: { status: response.status, count },
      }),
    );
  }
});
