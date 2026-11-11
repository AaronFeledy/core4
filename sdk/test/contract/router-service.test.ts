import { describe, expect, test } from "bun:test";
import {
  AppId,
  AppRouteOwner,
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
import { Effect, Schema } from "effect";

const OWNER_KEY = "a".repeat(64);
const otherOwnerKey = "b".repeat(64);

const routeOwner = (id: string, ownerKey: string = OWNER_KEY): AppRouteOwner => ({
  id: AppId.make(id),
  ownerKey,
});

describe("RouterService contract", () => {
  test("AppRouteOwner requires id and a lowercase 64-hex ownerKey", () => {
    expect(Schema.is(AppRouteOwner)(routeOwner("myapp"))).toBe(true);
    expect(Schema.is(AppRouteOwner)({ id: "myapp", ownerKey: "A".repeat(64) })).toBe(false);
    expect(Schema.is(AppRouteOwner)({ id: "myapp", ownerKey: "a".repeat(63) })).toBe(false);
    expect(Schema.is(AppRouteOwner)({ id: "myapp", ownerKey: "g".repeat(64) })).toBe(false);
    expect(Schema.is(AppRouteOwner)({ id: "myapp", ownerKey: `${OWNER_KEY}\n` })).toBe(false);
    expect(Schema.is(AppRouteOwner)({ id: "myapp" })).toBe(false);
  });

  test("observes only requested matching live routes with their path and backend", async () => {
    const router = makeTestRouterService();
    const owner = routeOwner("observed-app");
    const route = {
      hostname: "web.lndo.site",
      priority: 65539,
      scheme: "https",
      service: ServiceName.make("web"),
      pathPrefix: "/api",
      backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
    } as const;
    await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(router.applyRoutes([route], owner));
    const evidence = await Effect.runPromise(router.observeRoutes(owner, [route]));
    expect(Schema.encodeSync(RouteEvidence)(evidence)).toEqual({
      configuredAuthorities: [{ scheme: "https", hostname: "web.lndo.site", port: 38443 }],
      observation: {
        status: "present",
        publications: [{ route, authority: { scheme: "https", hostname: "web.lndo.site", port: 38443 } }],
      },
    });
    const mismatch = await Effect.runPromise(
      router.observeRoutes(owner, [{ ...route, pathPrefix: "/different" }]),
    );
    expect(mismatch.observation).toEqual({ status: "missing" });
  });
  test("observes unknown before setup without starting ingress or configuring routes", async () => {
    const router = makeTestRouterService();
    const evidence = await Effect.runPromise(router.observeRoutes(routeOwner("unconfigured"), []));
    expect(evidence).toEqual({ configuredAuthorities: [], observation: { status: "unknown" } });
    expect((await Effect.runPromise(router.status)).state).toBe("stopped");
    expect(router.routesByOwner.size).toBe(0);
  });

  test("distinguishes missing route evidence after setup without mutating requested routes", async () => {
    const router = makeTestRouterService();
    await Effect.runPromise(Effect.scoped(router.setup({ defaultDomain: "lndo.site" })));
    const evidence = await Effect.runPromise(router.observeRoutes(routeOwner("unconfigured"), []));
    expect(evidence.observation).toEqual({ status: "missing" });
    expect(router.routesByOwner.size).toBe(0);
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
        readRoutes: (owner) => TestRouterService.readRoutes(owner),
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

  test("makeTestRouterService tracks applyRoutes and removeRoutes by ownerKey", async () => {
    const proxy = makeTestRouterService();
    const owner = routeOwner("myapp");
    const routes = [
      {
        hostname: "web.myapp.lndo.site",
        priority: 2,
        scheme: "https" as const,
        service: ServiceName.make("web"),
        backend: { service: ServiceName.make("web"), protocol: "https" as const, port: 9443 },
      },
    ];

    const result = await Effect.runPromise(proxy.applyRoutes(routes, owner));
    expect(proxy.routesByOwner.get(OWNER_KEY)).toHaveLength(1);
    expect(Schema.is(ProxyApplyResult)(result)).toBe(true);
    expect(result.app).toBe(owner.id);

    await Effect.runPromise(proxy.removeRoutes(owner));
    expect(proxy.routesByOwner.get(OWNER_KEY)).toBeUndefined();
  });

  test("makeTestRouterService replaces routes under the same ownerKey after rename", async () => {
    const proxy = makeTestRouterService();
    const before = routeOwner("old-name");
    const after = routeOwner("new-name");
    const first = [
      {
        hostname: "old.lndo.site",
        priority: 2,
        scheme: "http" as const,
        service: ServiceName.make("web"),
        backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 80 },
      },
    ];
    const second = [
      {
        hostname: "new.lndo.site",
        priority: 2,
        scheme: "https" as const,
        service: ServiceName.make("web"),
        backend: { service: ServiceName.make("web"), protocol: "http" as const, port: 8080 },
      },
    ];

    await Effect.runPromise(proxy.applyRoutes(first, before));
    const renamed = await Effect.runPromise(proxy.applyRoutes(second, after));
    expect(proxy.routesByOwner.size).toBe(1);
    expect(proxy.routesByOwner.get(OWNER_KEY)?.[0]?.hostname).toBe("new.lndo.site");
    expect(renamed.app).toBe(after.id);
    expect((await Effect.runPromise(proxy.status)).configuredApps).toEqual([after.id]);

    await Effect.runPromise(proxy.applyRoutes(second, routeOwner("other", otherOwnerKey)));
    expect(proxy.routesByOwner.size).toBe(2);
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
