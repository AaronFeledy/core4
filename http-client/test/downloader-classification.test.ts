import { expect, test } from "bun:test";
import { DownloadFetchError, HttpTrustError } from "@lando/sdk/errors";
import { Cause, Effect, Exit } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeDownloaderService } from "../src/downloader-service.ts";
import { isTransientDownloadFailure } from "../src/downloader-transient.ts";
import { trustFailure } from "../src/trust-failure.ts";

const url = "https://artifacts.test/file.bin";
const cases = [
  ["ECONNRESET", "connection-reset", true],
  ["EPIPE", "connection-reset", true],
  ["ECONNABORTED", "connection-reset", true],
  ["ECONNREFUSED", "connection-refused", true],
  ["ETIMEDOUT", "timeout", true],
  ["EAI_AGAIN", "dns-temporary", true],
  ["ENOTFOUND", "host-not-found", false],
  ["ENETUNREACH", "network-unreachable", true],
  ["EHOSTUNREACH", "network-unreachable", true],
  ["ENETDOWN", "network-unreachable", true],
  ["EPROTO", "tls-handshake", false],
  ["UNKNOWN", "transport", false],
] as const;

const fetchFailureFrom = async (client: HttpClient.HttpClient): Promise<DownloadFetchError> => {
  const exit = await Effect.runPromiseExit(
    Effect.scoped(makeDownloaderService(client).download({ url, destination: { kind: "memory" } })),
  );
  if (Exit.isSuccess(exit)) throw new Error("expected the download to fail");
  const failure = Cause.squash(exit.cause);
  if (!(failure instanceof DownloadFetchError)) throw failure;
  return failure;
};

for (const boundary of ["TransportError", "DecodeError"] as const) {
  test.each(cases)(`${boundary}: %s is observed as %s`, async (code, reason, transient) => {
    const original = Object.assign(new TypeError("raw transport message"), { code });
    const client = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, new Response());
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason:
            boundary === "TransportError"
              ? new HttpClientError.TransportError({ request, cause: original })
              : new HttpClientError.DecodeError({ request, response, cause: original }),
        }),
      );
    });
    const failure = await fetchFailureFrom(client);
    expect(failure).toMatchObject({ reason, transportCode: code, attempts: 1, status: undefined });
    expect(isTransientDownloadFailure(failure)).toBe(transient);
    expect(failure.remediation).not.toContain("lando setup");
    expect(failure.remediation).not.toContain("run the command again");
    if (reason !== "transport") expect(failure.message).not.toContain(original.message);
  });
}

test.each([408, 429, 500, 502, 503, 504, 404, 410, 401, 403, 407])(
  "HTTP %s keeps its status and remediation category",
  async (status) => {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("failure", { status }))),
    );
    const failure = await fetchFailureFrom(client);
    expect(failure).toMatchObject({ reason: "http-status", status, attempts: 1 });
    expect(failure.remediation).not.toContain("run the command again");
    expect(isTransientDownloadFailure(failure)).toBe([408, 429, 500, 502, 503, 504].includes(status));
    if (status === 407) expect(failure.remediation).toContain("proxy requires authentication");
    if (status === 404 || status === 410) expect(failure.remediation).toContain("file isn't at that URL");
  },
);

test("a CONNECT 407 is proxy-authentication rather than a tunnel refusal", () => {
  const cause = Object.assign(new Error("Proxy authentication required"), {
    code: "ERR_PROXY_TUNNEL",
    status: 407,
  });
  const failure = trustFailure(new URL(url), cause, (value) => value);
  expect(failure).toBeInstanceOf(HttpTrustError);
  expect(failure).toMatchObject({ kind: "proxy-authentication", cause });
});

test("an omitted reason from a contributed Downloader is treated as transport", () => {
  expect(
    isTransientDownloadFailure(
      new DownloadFetchError({
        message: "unknown",
        urlOrigin: "https://artifacts.test",
        remediation: "Inspect transport.",
      }),
    ),
  ).toBe(false);
});
