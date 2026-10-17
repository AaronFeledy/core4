import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";
import type { ScanAttempt } from "@lando/sdk/services";

import { makeUrlScanner } from "../../../src/subsystems/scanner/live.ts";
import {
  appId,
  drive,
  endpointsOf,
  httpFailure,
  httpSleep,
  httpStatus,
  marker,
  publishedEndpoint,
  requestSequence,
  runExitUnderClock,
  secret,
  successOf,
  withFakeRedaction,
} from "./support.ts";

const web = ServiceName.make("web");
const target = { service: web, url: "http://localhost:8080/" };

describe("UrlScanner onAttempt", () => {
  test.each([
    [200, undefined, [], "ready", 1],
    [301, undefined, [], "app-error", 1],
    [401, undefined, [], "app-error", 1],
    [403, undefined, [], "app-error", 1],
    [404, undefined, [], "app-error", 1],
    [500, undefined, [], "app-error", 1],
    [501, undefined, [], "app-error", 1],
    [502, undefined, [], "service-error", 3],
    [503, undefined, [], "app-error", 1],
    [504, undefined, [], "service-error", 3],
    [505, undefined, [], "app-error", 1],
    [503, undefined, [503], "ready", 1],
    [200, "no-route", [], "lando-error", 3],
    [200, "", [], "lando-error", 3],
    [503, "upstream-unreachable", [503], "lando-error", 3],
  ] as const)(
    "classifies status %i marker %s before stopping or retrying",
    async (status, routerMarker, okCodes, verdict, count) => {
      const http = requestSequence([
        httpStatus(status, routerMarker === undefined ? {} : { "X-Lando-Router": routerMarker }),
      ]);
      const attempts: ScanAttempt[] = [];
      const scanner = makeUrlScanner(
        { http: http.http, listEndpoints: () => Effect.succeed([]) },
        { retry: 3, delaySeconds: 0, okCodes },
      );
      const result = await drive(
        scanner.scan(appId, {
          urls: [target],
          onAttempt: (attempt) =>
            Effect.sync(() => {
              attempts.push(attempt);
            }),
        }),
      );
      expect(http.requests).toHaveLength(count);
      expect(result.endpoints[0]).toMatchObject({ verdict, statusCode: status, reachable: true });
      expect(result.endpoints[0]?.routerMarker).toBe(routerMarker);
      expect(attempts.map((attempt) => attempt.verdict)).toEqual(
        Array.from({ length: count }, () => verdict),
      );
      expect(attempts.at(-1)?.willRetry).toBe(false);
    },
  );

  test("redacts the router marker when returning a router-owned response", async () => {
    // Given
    const http = requestSequence([httpStatus(503, { "X-Lando-Router": secret })]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: () => Effect.succeed([]) },
      { retry: 1 },
    );
    // When
    const result = await drive(withFakeRedaction(scanner.scan(appId, { urls: [target] })));
    // Then
    expect(result.endpoints[0]).toMatchObject({ verdict: "lando-error", routerMarker: marker });
  });

  test("TLS trust failures retry and a later ready answer is final", async () => {
    const http = requestSequence([httpFailure("unable to verify the first certificate"), httpStatus(200)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: () => Effect.succeed([]) },
      { delaySeconds: 0 },
    );
    const result = await drive(scanner.scan(appId, { urls: [target] }));
    expect(http.requests).toHaveLength(2);
    expect(result.endpoints[0]?.verdict).toBe("ready");
  });

  test("does not promise a retry when the delay consumes the remaining deadline", async () => {
    const http = requestSequence([httpStatus(502)]);
    const attempts: ScanAttempt[] = [];
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: () => Effect.succeed([]) },
      { retry: 3, delaySeconds: 1, deadlineMs: 500 },
    );
    const timed = await runExitUnderClock(
      scanner.scan(appId, {
        urls: [target],
        onAttempt: (attempt) =>
          Effect.sync(() => {
            attempts.push(attempt);
          }),
      }),
      "1 second",
    );
    expect(http.requests).toHaveLength(1);
    expect(attempts[0]?.willRetry).toBe(false);
    expect(successOf(timed.exit).endpoints[0]?.verdict).toBe("lando-error");
  });
  test("reports every completed response and transport attempt with redacted detail", async () => {
    const http = requestSequence([
      httpStatus(502),
      httpFailure(`connection refused ${secret}`),
      httpStatus(200),
    ]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 3, delaySeconds: 0 },
    );
    const attempts: ScanAttempt[] = [];
    const result = await drive(
      withFakeRedaction(
        scanner.scan(appId, {
          urls: [target],
          onAttempt: (attempt) =>
            Effect.sync(() => {
              attempts.push(attempt);
            }),
        }),
      ),
    );
    expect(attempts).toEqual([
      {
        ...target,
        attempt: 1,
        maxAttempts: 3,
        outcome: "yellow",
        verdict: "service-error",
        willRetry: true,
        statusCode: 502,
        detail: "HTTP 502",
      },
      {
        ...target,
        attempt: 2,
        maxAttempts: 3,
        outcome: "red",
        verdict: "lando-error",
        willRetry: true,
        detail: `connection refused ${marker}`,
      },
      {
        ...target,
        attempt: 3,
        maxAttempts: 3,
        outcome: "green",
        verdict: "ready",
        willRetry: false,
        statusCode: 200,
        detail: "HTTP 200",
      },
    ]);
    expect(result.endpoints[0]?.outcome).toBe("green");
    expect(source.calls).toHaveLength(0);
  });

  test("reports the per-attempt timeout and clamps the attempt budget to one", async () => {
    const http = requestSequence([httpSleep("30 seconds", 200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 0, timeoutSeconds: 1 },
    );
    const attempts: ScanAttempt[] = [];
    const timed = await runExitUnderClock(
      scanner.scan(appId, {
        onAttempt: (attempt) =>
          Effect.sync(() => {
            attempts.push(attempt);
          }),
      }),
      "1 second",
    );
    expect(attempts).toEqual([
      {
        ...target,
        attempt: 1,
        maxAttempts: 1,
        outcome: "red",
        verdict: "lando-error",
        willRetry: false,
        detail: "timeout after 1000ms",
      },
    ]);
    expect(successOf(timed.exit).endpoints[0]?.outcome).toBe("red");
  });

  test.each(["effect defect", "synchronous throw"])(
    "a callback %s does not change retry verdicts",
    async (failure) => {
      const http = requestSequence([httpStatus(502), httpStatus(200)]);
      const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
      const scanner = makeUrlScanner(
        { http: http.http, listEndpoints: source.listEndpoints },
        { retry: 2, delaySeconds: 0 },
      );
      let calls = 0;
      const result = await drive(
        scanner.scan(appId, {
          onAttempt: () => {
            calls++;
            if (failure === "synchronous throw") throw new Error("observer failed");
            return Effect.die(new Error("observer failed"));
          },
        }),
      );
      expect(calls).toBe(2);
      expect(result.endpoints[0]).toEqual({
        ...target,
        reachable: true,
        outcome: "green",
        verdict: "ready",
        statusCode: 200,
      });
    },
  );
});
