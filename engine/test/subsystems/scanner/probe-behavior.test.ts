import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Option, TestClock, TestContext } from "effect";

import { AppId as AppIdSchema, ServiceName } from "@lando/sdk/schema";
import { runScannerContract } from "@lando/sdk/test";

import { makeUrlScanner } from "../../../src/subsystems/scanner/live.ts";
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
  test("green on the third attempt after two fixed delays", async () => {
    const http = requestSequence([httpStatus(500), httpFailure("connection refused"), httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 3, delaySeconds: 10 },
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
    });
  });

  test("fixed backoff waits only between attempts", async () => {
    const http = requestSequence([httpFailure("connection refused")]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 3, delaySeconds: 10 },
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(scanner.scan(appId));
        yield* TestClock.adjust("19 seconds");
        const early = yield* Fiber.poll(fiber);
        expect(Option.isNone(early)).toBe(true);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        expect(result.endpoints[0]?.outcome).toBe("red");
        expect(result.endpoints[0]?.reachable).toBe(false);
        expect(http.requests).toHaveLength(3);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });

  test("per-attempt timeout resolves red with a timeout detail", async () => {
    const http = requestSequence([httpSleep("30 seconds", 200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
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
      detail: "timeout after 5s",
    });
  });

  test("responses outside 2xx and okCodes classify yellow with statusCode detail", async () => {
    const http = requestSequence([httpStatus(500)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 1 },
    );

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints[0]).toEqual({
      service: web,
      url: "http://localhost:8080/",
      reachable: true,
      statusCode: 500,
      outcome: "yellow",
      detail: "HTTP 500",
    });
  });

  test("okCodes extends the accepted statuses beyond 2xx", async () => {
    const redirectHttp = requestSequence([httpStatus(301)]);
    const redirectSource = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const yellowRedirect = await drive(
      makeUrlScanner(
        { request: redirectHttp.request, listEndpoints: redirectSource.listEndpoints },
        { retry: 1 },
      ).scan(appId),
    );
    expect(yellowRedirect.endpoints[0]?.outcome).toBe("yellow");
    expect(yellowRedirect.endpoints[0]?.statusCode).toBe(301);

    const okHttp = requestSequence([httpStatus(301)]);
    const okSource = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const green = await drive(
      makeUrlScanner(
        { request: okHttp.request, listEndpoints: okSource.listEndpoints },
        { retry: 1, okCodes: [301] },
      ).scan(appId),
    );
    expect(green.endpoints[0]?.outcome).toBe("green");
    expect(green.endpoints[0]?.statusCode).toBe(301);
    expect(green.endpoints[0]?.detail).toBeUndefined();
  });

  test("redacts transport failures before they leave the scanner", async () => {
    const http = requestSequence([httpFailure(`proxy saw ${secret}`)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 1 },
    );

    const redacted = await drive(withFakeRedaction(scanner.scan(appId)));
    expect(redacted.endpoints[0]?.outcome).toBe("red");
    expect(redacted.endpoints[0]?.detail).not.toContain(secret);
    expect(redacted.endpoints[0]?.detail).toContain(marker);

    const fallbackHttp = requestSequence([httpFailure("proxy saw MY_TOKEN=abc123")]);
    const fallbackSource = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const fallback = await drive(
      makeUrlScanner(
        { request: fallbackHttp.request, listEndpoints: fallbackSource.listEndpoints },
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
      request: requestSequence([httpStatus(200)]).request,
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
      request: requestSequence([httpStatus(200)]).request,
      listEndpoints: () => Effect.succeed([]),
    });

    const exit = await driveExit(runScannerContract(scanner));

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isFailure(exit)) throw new Error(`Contract failure: ${JSON.stringify(failureOf(exit))}`);
  });
});
