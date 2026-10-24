import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ProviderUnavailableError, ScannerError } from "@lando/sdk/errors";
import { AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RouterService, RuntimeProvider, type RuntimeProviderShape, UrlScanner } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import * as HttpClient from "effect/http/HttpClient";

import * as ProviderUrlScanner from "../../../src/subsystems/scanner/live.ts";
import { plan, web as webPlan } from "../../operations/start-progress-topology-support.ts";
import { appId, asHttpClient, drive, driveExit, failureOf, httpStatus, requestSequence } from "./support.ts";

const web = ServiceName.make("web");
const worker = ServiceName.make("worker");

const provideScanner = Effect.fnUntraced(
  function* (_provider: RuntimeProviderShape, _http: ReturnType<typeof requestSequence>) {
    return yield* UrlScanner;
  },
  Effect.provide(ProviderUrlScanner.layer),
  (effect, provider, http) =>
    effect.pipe(
      Effect.provide(Layer.succeed(RuntimeProvider, provider)),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, asHttpClient(http))),
    ),
);

describe("ProviderUrlScanner.layer", () => {
  test("scans shared router ingress without claiming it as an app port collision", async () => {
    // Given two routed apps with no direct host publications.
    const plans: readonly AppPlan[] = ["one", "two"].map((name) => ({
      ...plan,
      id: AppId.make(name),
      services: {
        [web]: { ...webPlan, endpoints: [{ _tag: "internal", protocol: "http", port: 80 }] },
      },
      routes: [
        {
          hostname: `${name}.test`,
          scheme: "https",
          priority: 1,
          service: web,
          backend: { service: web, protocol: "http", port: 80 },
        },
      ],
    }));
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      appliedPlans: Effect.succeed(plans),
      inspect: ({ app, service }) =>
        Effect.succeed({
          app,
          service,
          providerId: ProviderId.make("test"),
          status: "running",
          publications: { status: "present", bindings: [] },
        }),
    };
    const router = RouterService.of({
      ...makeTestRouterService(),
      observeRoutes: (_app, routes) =>
        Effect.succeed({
          configuredAuthorities: [],
          observation: {
            status: "present",
            publications: routes.map((route) => ({
              route,
              authority: { hostname: route.hostname, scheme: "https", port: 38443 },
            })),
          },
        }),
    });
    const http = requestSequence([httpStatus(200)]);
    // When the production layer discovers connections for collision checks and scans.
    const result = await drive(
      Effect.gen(function* () {
        const scanner = yield* UrlScanner;
        return {
          collisions: yield* scanner.detectCollisions(plans.map((entry) => entry.id)),
          scan: yield* scanner.scan(AppId.make("one")),
        };
      }).pipe(
        Effect.provide(ProviderUrlScanner.layer),
        Effect.provideService(RuntimeProvider, provider),
        Effect.provideService(HttpClient.HttpClient, asHttpClient(http)),
        Effect.provideService(RouterService, router),
      ),
    );
    // Then shared ingress is not a direct-publication collision, but remains scannable.
    expect(result.collisions).toEqual([]);
    expect(result.scan.endpoints.map((endpoint) => endpoint.url)).toEqual(["https://one.test:38443/"]);
  });

  test("wires the probe scanner from RuntimeProvider endpoints and HttpClient", async () => {
    const http = requestSequence([httpStatus(200)]);
    const provider = {
      ...TestRuntimeProvider,
      appliedPlans: Effect.succeed([
        {
          ...plan,
          id: appId,
          services: {
            [web]: {
              ...webPlan,
              endpoints: [
                { _tag: "published", protocol: "http", port: 8080, publication: { hostPort: 8080 } },
                { _tag: "internal", protocol: "http", port: 8181 },
              ],
            },
            [worker]: { ...webPlan, name: worker },
          },
        },
      ]),
      inspect: ({ service }) =>
        Effect.succeed({
          app: appId,
          service,
          providerId: ProviderId.make(TestRuntimeProvider.id),
          status: "running",
          state: service === worker ? "stopped" : "running",
          publications: {
            status: "present",
            bindings: [{ port: 8080, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
          },
        }),
    } satisfies RuntimeProviderShape;

    const result = await drive(
      provideScanner(provider, http).pipe(Effect.flatMap((scanner) => scanner.scan(appId))),
    );

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.service).toBe(web);
    expect(result.endpoints[0]?.url).toBe("http://localhost:8080/");
    expect(result.endpoints[0]?.outcome).toBe("green");
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
