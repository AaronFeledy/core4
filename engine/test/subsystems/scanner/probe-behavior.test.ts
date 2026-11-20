import { describe, expect, test } from "bun:test";
import { AppId as AppIdSchema, PortNumber, ServiceName } from "@lando/sdk/schema";
import { runScannerContract } from "@lando/sdk/test";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { makeUrlScanner } from "../../../src/subsystems/scanner/live.ts";
import * as scanModule from "../../../src/subsystems/scanner/scan-target.ts";
import { web as servicePlan } from "../../operations/start-progress-topology-support.ts";
import {
  appId,
  drive,
  driveExit,
  endpointsOf,
  failureOf,
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
const worker = ServiceName.make("worker");
const db = ServiceName.make("db");

describe("makeUrlScanner probe behavior", () => {
  test("overall deadline stops retrying before maxAttempts", async () => {
    // Given a retry delay that crosses the overall deadline.
    const http = requestSequence([httpStatus(502)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 5, delaySeconds: 1, deadlineMs: 1500 },
    );
    // When the virtual clock advances beyond all possible attempts.
    const timed = await runExitUnderClock(scanner.scan(appId), "10 seconds");
    // Then the last verdict is retained and only two attempts ran.
    expect(http.requests).toHaveLength(2);
    expect(timed.elapsedMs).toBe(1500);
    expect(successOf(timed.exit).endpoints[0]?.verdict).toBe("lando-error");
  });

  test.each([
    [0, 1],
    [3, 4],
  ])("scanConfigFromPlan maps retries %i to %i attempts", (retries, attempts) => {
    // Given resolved settings distinct from every overridden base field.
    const scan = { enabled: false, path: "/ready", okCodes: [418], retries, timeoutMs: 1234 };
    // When the plan is mapped onto the base configuration.
    const config = scanModule.scanConfigFromPlan(scan, scanModule.defaultUrlScanConfig);
    // Then retries become total attempts and unrelated tuning survives.
    expect(config).toEqual({
      ...scanModule.defaultUrlScanConfig,
      enabled: false,
      path: "/ready",
      okCodes: [418],
      retry: attempts,
      deadlineMs: 1234,
    });
  });

  test("per-attempt timeout is capped by a smaller overall deadline", async () => {
    // Given an HTTP response slower than the overall budget.
    const http = requestSequence([httpSleep("30 seconds", 200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 1, timeoutSeconds: 5, deadlineMs: 250 },
    );
    // When scanning under a virtual clock.
    const timed = await runExitUnderClock(scanner.scan(appId), "10 seconds");
    // Then neither the request budget nor completion exceeds the deadline.
    expect(timed.elapsedMs).toBe(250);
    expect(successOf(timed.exit).endpoints[0]?.outcome).toBe("red");
  });

  test("green on the third attempt after two fixed delays", async () => {
    const http = requestSequence([httpStatus(502), httpFailure("connection refused"), httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 3, delaySeconds: 10, deadlineMs: 30000 },
    );

    const timed = await runExitUnderClock(scanner.scan(appId), "20 seconds");
    const result = successOf(timed.exit);

    expect(timed.elapsedMs).toBe(20_000);
    expect(http.requests).toHaveLength(3);
    expect(result.endpoints[0]).toEqual({
      service: web,
      url: "http://localhost:8080/",
      reachable: true,
      statusCode: 200,
      outcome: "green",
      verdict: "ready",
    });
  });

  test("fixed backoff waits only between attempts", async () => {
    const http = requestSequence([httpFailure("connection refused")]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 3, delaySeconds: 10, deadlineMs: 30000 },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(scanner.scan(appId));
        yield* TestClock.adjust("19 seconds");
        const early = fiber.pollUnsafe();
        expect(early).toBeUndefined();
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(result.endpoints[0]?.outcome).toBe("red");
        expect(result.endpoints[0]?.reachable).toBe(false);
        expect(http.requests).toHaveLength(3);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("per-attempt timeout resolves red with a timeout detail", async () => {
    const http = requestSequence([httpSleep("30 seconds", 200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { http: http.http, listEndpoints: source.listEndpoints },
      { retry: 2, delaySeconds: 10, timeoutSeconds: 5 },
    );

    const timed = await runExitUnderClock(scanner.scan(appId), "20 seconds");
    const result = successOf(timed.exit);

    expect(timed.elapsedMs).toBe(20_000);
    expect(http.requests).toHaveLength(2);
    expect(result.endpoints[0]).toEqual({
      service: web,
      url: "http://localhost:8080/",
      reachable: false,
      outcome: "red",
      verdict: "lando-error",
      detail: "deadline exceeded after 20000ms",
    });
  });

  test("responses outside 2xx and okCodes classify yellow with statusCode detail", async () => {
    const http = requestSequence([httpStatus(500)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner({ http: http.http, listEndpoints: source.listEndpoints }, { retry: 1 });

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints[0]).toEqual({
      service: web,
      url: "http://localhost:8080/",
      reachable: true,
      statusCode: 500,
      outcome: "yellow",
      verdict: "app-error",
      detail: "HTTP 500",
    });
  });

  test.each([
    ["/admin/", [], "ready"],
    ["https://localhost:8443/admin/", [], "ready"],
    ["https://localhost/admin/", [], "app-error"],
    ["http://localhost:8443/admin/", [], "app-error"],
    ["//production.example/admin/", [], "app-error"],
    ["https://[", [], "app-error"],
    [undefined, [], "app-error"],
    ["https://production.example/admin/", [302], "ready"],
  ] as const)(
    "classifies Location %s with okCodes %j as %s without following",
    async (location, okCodes, verdict) => {
      const http = requestSequence([httpStatus(302, location === undefined ? {} : { location })]);
      const scanner = makeUrlScanner(
        { http: http.http, listEndpoints: () => Effect.succeed([]) },
        { okCodes },
      );
      const url = "https://localhost:8443/";
      const result = await drive(scanner.scan(appId, { urls: [{ service: web, url }] }));
      expect(result.endpoints[0]).toMatchObject({ statusCode: 302, verdict });
      expect(http.requests).toEqual([{ url, method: "GET", redirect: "manual", callerId: "url-scanner" }]);
    },
  );

  test.each(["/admin/", "//user:credential@production.example/admin/"])(
    "redacts Location %s in attempts and results",
    async (target) => {
      const http = requestSequence([httpStatus(302, { location: `${target}?token=query-secret` })]);
      const scanner = makeUrlScanner({ http: http.http, listEndpoints: () => Effect.succeed([]) });
      const attempts: string[] = [];
      const result = await drive(
        scanner.scan(appId, {
          urls: [{ service: web, url: "https://localhost:8443/" }],
          onAttempt: (attempt) =>
            Effect.sync(() => {
              attempts.push(attempt.detail ?? "");
            }),
        }),
      );
      expect(attempts).toEqual([expect.stringContaining("/admin/")]);
      expect(result.endpoints[0]?.detail).toBe(attempts[0]);
      expect(JSON.stringify([result, attempts])).not.toMatch(/credential|query-secret/u);
    },
  );

  test.each([
    [true, 502, undefined, 8080, [], "expected", 1],
    [true, 504, "upstream-unreachable", 8080, [], "expected", 1],
    [true, 502, undefined, 8080, [502], "ready", 1],
    [true, 404, "no-route", 8080, [], "lando-error", 3],
    [false, 502, undefined, 8080, [], "service-error", 3],
    [true, 502, undefined, 9000, [], "service-error", 3],
    [false, 504, "upstream-unreachable", 8080, [], "lando-error", 3],
  ] as const)(
    "classifies keepAlive %s, HTTP %s, marker %s, listener %s, okCodes %j as %s",
    async (keepAlive, status, routerMarker, port, okCodes, verdict, count) => {
      const http = requestSequence([
        httpStatus(status, routerMarker === undefined ? {} : { "x-lando-router": routerMarker }),
      ]);
      const service = {
        ...servicePlan,
        listenerAuthority: {
          owner: "application",
          port: PortNumber.make(8080),
          daemon: "Node.js",
          variables: ["PORT"],
          ...(keepAlive ? { keepAlive } : {}),
        },
      } as const;
      const scanner = makeUrlScanner(
        {
          http: http.http,
          listEndpoints: () =>
            Effect.succeed([{ ...publishedEndpoint(web, "http", port), servicePlan: service }]),
        },
        { okCodes },
      );
      const retries: boolean[] = [];
      const run = await runExitUnderClock(
        scanner.scan(appId, {
          onAttempt: (attempt) =>
            Effect.sync(() => {
              retries.push(attempt.willRetry ?? false);
            }),
        }),
        "10 seconds",
      );
      expect(successOf(run.exit).endpoints[0]?.verdict).toBe(verdict);
      expect(http.requests).toHaveLength(count);
      expect(retries).toEqual(count === 1 ? [false] : [true, true, false]);
    },
  );

  test("redacts transport failures before they leave the scanner", async () => {
    const http = requestSequence([httpFailure(`proxy saw ${secret}`)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner({ http: http.http, listEndpoints: source.listEndpoints }, { retry: 1 });

    const redacted = await drive(withFakeRedaction(scanner.scan(appId)));
    expect(redacted.endpoints[0]?.outcome).toBe("red");
    expect(redacted.endpoints[0]?.detail).not.toContain(secret);
    expect(redacted.endpoints[0]?.detail).toContain(marker);

    const fallbackHttp = requestSequence([httpFailure("proxy saw MY_TOKEN=abc123")]);
    const fallbackSource = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const fallback = await drive(
      makeUrlScanner(
        { http: fallbackHttp.http, listEndpoints: fallbackSource.listEndpoints },
        { retry: 1 },
      ).scan(appId),
    );
    expect(fallback.endpoints[0]?.detail).not.toContain("abc123");
    expect(fallback.endpoints[0]?.detail).toContain("[redacted]");
  });

  test("detectCollisions reports ports claimed by two or more distinct apps", async () => {
    const appOne = AppIdSchema.make("app-one");
    const appTwo = AppIdSchema.make("app-two");
    const perApp = new Map([
      [
        appOne,
        [
          publishedEndpoint(web, "http", 8080),
          publishedEndpoint(worker, "tcp", 9000),
          publishedEndpoint(db, "tcp", 9000),
        ],
      ],
      [appTwo, [publishedEndpoint(web, "http", 8080)]],
    ]);
    const scanner = makeUrlScanner({
      http: requestSequence([httpStatus(200)]).http,
      listEndpoints: (app) => Effect.succeed(perApp.get(app) ?? []),
    });

    const collisions = await drive(scanner.detectCollisions([appOne, appTwo]));

    expect(collisions).toEqual([
      {
        port: 8080,
        apps: [
          { appId: appOne, service: web },
          { appId: appTwo, service: web },
        ],
      },
    ]);
  });

  test("satisfies the SDK scanner contract", async () => {
    const scanner = makeUrlScanner({
      http: requestSequence([httpStatus(200)]).http,
      listEndpoints: () => Effect.succeed([]),
    });

    const exit = await driveExit(runScannerContract(scanner));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error(`Contract failure: ${JSON.stringify(failureOf(exit))}`);
  });
});
