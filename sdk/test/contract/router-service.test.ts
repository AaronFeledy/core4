import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import {
  AppId,
  ProxyApplyResult,
  ProxyCapabilities,
  ProxyStatus,
  RouteEvidence,
  ServiceName,
} from "@lando/sdk/schema";
import {
  ContractFailure,
  TestRouterService,
  makeRouterServiceContractSuite,
  makeTestRouterService,
  runRouterServiceContractSuite,
} from "@lando/sdk/test";

describe("RouterService contract", () => {
  test("observes only requested matching live routes with their path and backend", async () => {
    const router = makeTestRouterService();
    const app = AppId.make("observed-app");
    const route = {
      hostname: "web.lndo.site",
      priority: 65539,
      scheme: "https",
      service: ServiceName.make("web"),
      pathPrefix: "/api",
      backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
    } as const;
    await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(router.applyRoutes([route], app));
    const evidence = await Effect.runPromise(router.observeRoutes(app, [route]));
    expect(Schema.encodeSync(RouteEvidence)(evidence)).toEqual({
      configuredAuthorities: [{ scheme: "https", hostname: "web.lndo.site", port: 38443 }],
      observation: {
        status: "present",
        publications: [{ route, authority: { scheme: "https", hostname: "web.lndo.site", port: 38443 } }],
      },
    });
    const mismatch = await Effect.runPromise(
      router.observeRoutes(app, [{ ...route, pathPrefix: "/different" }]),
    );
    expect(mismatch.observation).toEqual({ status: "missing" });
  });
  test("observes unknown before setup without starting ingress or configuring routes", async () => {
    const router = makeTestRouterService();
    const evidence = await Effect.runPromise(router.observeRoutes(AppId.make("unconfigured"), []));
    expect(evidence).toEqual({ configuredAuthorities: [], observation: { status: "unknown" } });
    expect((await Effect.runPromise(router.status)).state).toBe("stopped");
    expect(router.routesByApp.size).toBe(0);
  });

  test("distinguishes missing route evidence after setup without mutating requested routes", async () => {
    const router = makeTestRouterService();
    await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));
    const evidence = await Effect.runPromise(router.observeRoutes(AppId.make("unconfigured"), []));
    expect(evidence.observation).toEqual({ status: "missing" });
    expect(router.routesByApp.size).toBe(0);
  });
  test("ProxyStatus accepts omitted listen ports and validates each reported scheme", () => {
    const status = { state: "running", authorities: [], configuredApps: [] };
    expect(Schema.is(ProxyStatus)(status)).toBe(true);
    expect(Schema.is(ProxyStatus)({ ...status, ports: { http: 8080, https: 8443 } })).toBe(true);
    expect(Schema.is(ProxyStatus)({ ...status, ports: { http: 0, https: 8443 } })).toBe(false);
    expect(Schema.is(ProxyStatus)({ ...status, ports: { http: 8080 } })).toBe(false);
  });

  test("TestRouterService satisfies the governed contract suite", async () => {
    const exit = await Effect.runPromiseExit(
      runRouterServiceContractSuite({
        service: TestRouterService,
        readRoutes: (app) => TestRouterService.readRoutes(app),
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("make and run contract-suite exports are aliases", () => {
    expect(makeRouterServiceContractSuite).toBe(runRouterServiceContractSuite);
  });

  test("TestRouterService has the expected id", () => {
    expect(TestRouterService.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestRouterService tracks applyRoutes and removeRoutes by appId", async () => {
    const proxy = makeTestRouterService();
    const appId = AppId.make("myapp");
    const routes = [
      {
        hostname: "web.myapp.lndo.site",
        priority: 2,
        scheme: "https" as const,
        service: ServiceName.make("web"),
        backend: { service: ServiceName.make("web"), protocol: "https" as const, port: 9443 },
      },
    ];

    const result = await Effect.runPromise(proxy.applyRoutes(routes, appId));
    expect(proxy.routesByApp.get("myapp")).toHaveLength(1);
    expect(Schema.is(ProxyApplyResult)(result)).toBe(true);

    await Effect.runPromise(proxy.removeRoutes(appId));
    expect(proxy.routesByApp.get("myapp")).toBeUndefined();
  });

  test("makeTestRouterService setup resolves", async () => {
    const proxy = makeTestRouterService();
    await expect(
      Effect.runPromise(Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" }))),
    ).resolves.toBeUndefined();
    expect(Schema.is(ProxyCapabilities)(proxy.capabilities)).toBe(true);
  });

  test("makeTestRouterService status and stop are schema-backed", async () => {
    const proxy = makeTestRouterService();
    const status = await Effect.runPromise(proxy.status);
    expect(Schema.is(ProxyStatus)(status)).toBe(true);
    await Effect.runPromise(proxy.stop);
  });
});
