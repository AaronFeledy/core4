import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Layer, Option, TestClock, TestContext } from "effect";

import { ProviderUnavailableError, ScannerError } from "@lando/sdk/errors";
import { type AppId, AppId as AppIdSchema, ServiceName } from "@lando/sdk/schema";
import { HttpClient, RuntimeProvider, type RuntimeProviderShape, UrlScanner } from "@lando/sdk/services";
import { TestRuntimeProvider, runScannerContract } from "@lando/sdk/test";

import * as liveModule from "../../../src/subsystems/scanner/live.ts";
import {
  appId,
  asHttpClient,
  drive,
  driveExit,
  failureOf,
  httpFailure,
  httpSleep,
  httpStatus,
  marker,
  requestSequence,
  runExitUnderClock,
  secret,
  successOf,
  withFakeRedaction,
} from "./support.ts";

const { UrlScannerDefaultLayer, UrlScannerLive, makeUrlScanner } = liveModule;
type ScanSourceEndpoint = liveModule.ScanSourceEndpoint;

const web = ServiceName.make("web");
const worker = ServiceName.make("worker");
const db = ServiceName.make("db");

const endpointsOf = (
  endpoints: ReadonlyArray<ScanSourceEndpoint>,
): {
  calls: AppId[];
  listEndpoints: (app: AppId) => Effect.Effect<ReadonlyArray<ScanSourceEndpoint>, ScannerError>;
} => {
  const calls: AppId[] = [];
  return {
    calls,
    listEndpoints: (app) =>
      Effect.sync(() => {
        calls.push(app);
        return endpoints;
      }),
  };
};

describe("makeUrlScanner", () => {
  test("scans http endpoints through the HttpClient chokepoint and resolves green", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });

    expect(scanner.id).toBe("http-probe");

    const result = await drive(scanner.scan(appId));

    expect(result).toEqual({
      appId,
      endpoints: [
        {
          service: web,
          url: "http://localhost:8080/",
          reachable: true,
          statusCode: 200,
          outcome: "green",
        },
      ],
    });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe("GET");
    expect(http.requests[0]?.timeoutMs).toBe(5_000);
    expect(http.requests[0]?.redirect).toBe("manual");
    expect(http.requests[0]?.callerId).toBe("url-scanner");
  });

  test("maxRedirects and path map onto the outbound request", async () => {
    const http = requestSequence([httpStatus(204)]);
    const source = endpointsOf([{ service: web, protocol: "https", port: 8443 }]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { maxRedirects: 3, path: "/healthz", timeoutSeconds: 2 },
    );

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints[0]?.url).toBe("https://localhost:8443/healthz");
    expect(result.endpoints[0]?.outcome).toBe("green");
    expect(http.requests[0]?.redirect).toBe("follow");
    expect(http.requests[0]?.timeoutMs).toBe(2_000);
  });

  test("skips non-http and port-less endpoints", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([
      { service: db, protocol: "tcp", port: 5432 },
      { service: worker, protocol: "unix" },
      { service: web, protocol: "http", port: 8080 },
    ]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.service).toBe(web);
    expect(http.requests).toHaveLength(1);
  });

  test("enabled false short-circuits without probing", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { enabled: false },
    );

    const result = await drive(scanner.scan(appId));

    expect(result).toEqual({ appId, endpoints: [] });
    expect(source.calls).toHaveLength(0);
    expect(http.requests).toHaveLength(0);
  });

  test("green on the third attempt after two fixed delays", async () => {
    const http = requestSequence([httpStatus(500), httpFailure("connection refused"), httpStatus(200)]);
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const redirectSource = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
    const yellowRedirect = await drive(
      makeUrlScanner(
        { request: redirectHttp.request, listEndpoints: redirectSource.listEndpoints },
        { retry: 1 },
      ).scan(appId),
    );
    expect(yellowRedirect.endpoints[0]?.outcome).toBe("yellow");
    expect(yellowRedirect.endpoints[0]?.statusCode).toBe(301);

    const okHttp = requestSequence([httpStatus(301)]);
    const okSource = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 1 },
    );

    const redacted = await drive(withFakeRedaction(scanner.scan(appId)));
    expect(redacted.endpoints[0]?.outcome).toBe("red");
    expect(redacted.endpoints[0]?.detail).not.toContain(secret);
    expect(redacted.endpoints[0]?.detail).toContain(marker);

    const fallbackHttp = requestSequence([httpFailure("proxy saw MY_TOKEN=abc123")]);
    const fallbackSource = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const perApp = new Map<AppId, ReadonlyArray<ScanSourceEndpoint>>([
      [
        appOne,
        [
          { service: web, protocol: "http", port: 8080 },
          { service: worker, protocol: "tcp", port: 9000 },
          { service: db, protocol: "tcp", port: 9000 },
          { service: worker, protocol: "unix" },
        ],
      ],
      [appTwo, [{ service: web, protocol: "http", port: 8080 }]],
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

describe("UrlScannerLive", () => {
  const provideScanner = (provider: RuntimeProviderShape, http: ReturnType<typeof requestSequence>) =>
    Effect.gen(function* () {
      return yield* UrlScanner;
    }).pipe(
      Effect.provide(UrlScannerLive),
      Effect.provide(Layer.succeed(RuntimeProvider, provider)),
      Effect.provide(Layer.succeed(HttpClient, asHttpClient(http))),
    );

  test("wires the probe scanner from RuntimeProvider endpoints and HttpClient", async () => {
    const http = requestSequence([httpStatus(200)]);
    const provider = {
      ...TestRuntimeProvider,
      list: () =>
        Effect.succeed([
          {
            app: appId,
            service: web,
            providerId: TestRuntimeProvider.id,
            status: "running",
            endpoints: [{ protocol: "http" as const, port: 8080 }],
          },
          {
            app: appId,
            service: worker,
            providerId: TestRuntimeProvider.id,
            status: "running",
            state: "stopped",
            endpoints: [{ protocol: "http" as const, port: 9090 }],
          },
        ]),
    } satisfies RuntimeProviderShape;

    const result = await drive(
      provideScanner(provider, http).pipe(Effect.flatMap((scanner) => scanner.scan(appId))),
    );

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.service).toBe(web);
    expect(result.endpoints[0]?.url).toBe("http://localhost:8080/");
    expect(result.endpoints[0]?.outcome).toBe("green");
    expect(UrlScannerDefaultLayer).toBe(UrlScannerLive);
  });

  test("maps provider list failures to ScannerError", async () => {
    const http = requestSequence([httpStatus(200)]);
    const provider = {
      ...TestRuntimeProvider,
      list: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: TestRuntimeProvider.id,
            operation: "list",
            message: "provider saw MY_TOKEN=abc123",
          }),
        ),
    } satisfies RuntimeProviderShape;

    const exit = await driveExit(
      provideScanner(provider, http).pipe(Effect.flatMap((scanner) => scanner.scan(appId))),
    );
    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(ScannerError);
    if (failure instanceof ScannerError) {
      expect(failure.scannerId).toBe("http-probe");
      expect(failure.message).not.toContain("abc123");
      expect(failure.message).toContain("[redacted]");
    }
  });
});
