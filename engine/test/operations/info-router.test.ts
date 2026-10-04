import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";

import { infoForPlan } from "../../src/operations/info.ts";

const providerId = ProviderId.make("test");
const web = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00.000Z"),
  source: "info-router.test",
  runtime: 4 as const,
};

const published = {
  _tag: "published" as const,
  protocol: "http" as const,
  port: 80,
  publication: { hostPort: 8080 },
  materialization: { bindAddress: "127.0.0.1" as const, hostPort: 8080 },
};

const service: ServicePlan = {
  name: web,
  type: "nginx",
  provider: providerId,
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [published],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const planWithRouter = (enabled: boolean): AppPlan => ({
  id: AppId.make("demo"),
  name: "demo",
  slug: "demo",
  root: AbsolutePath.make("/srv/apps/demo"),
  provider: providerId,
  router: { enabled },
  services: { [web]: service },
  routes: [
    {
      hostname: "web.demo.lndo.site",
      priority: 2,
      scheme: "https",
      service: web,
      backend: { service: web, protocol: "http", port: 80 },
    },
  ],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const infoOf = (plan: AppPlan, endpoints: ServiceRuntimeInfo["endpoints"] = [published]) => {
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints,
      }),
  };
  const proxy = {
    ...makeTestRouterService(),
    status: Effect.succeed({
      state: "running" as const,
      authorities: [{ scheme: "https" as const, hostname: "web.demo.lndo.site", port: 38443 }],
      configuredApps: [plan.id],
    }),
  };
  return Effect.runPromise(
    infoForPlan(plan).pipe(
      Effect.provide(Layer.succeed(RouterService, proxy)),
      Effect.provide(
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            list: Effect.succeed([providerId]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
        ),
      ),
    ),
  );
};

describe("infoForPlan", () => {
  test("renders a Redis TCP endpoint without advertising HTTP", async () => {
    // Given
    const plan = planWithRouter(false);
    const redisPlan = { ...plan, services: { [web]: { ...service, type: "redis" } } };
    // When
    const result = await infoOf(redisPlan, [
      {
        _tag: "published",
        protocol: "tcp",
        port: 6379,
        publication: {},
        materialization: { bindAddress: "127.0.0.1", hostPort: 16379 },
      },
    ]);
    // Then
    expect(result.services[0]?.endpoints).toEqual(["tcp://localhost:16379"]);
  });

  test("omits routed hostnames when the plan disables the router", async () => {
    const result = await infoOf(planWithRouter(false));
    expect(result.services[0]?.endpoints).toEqual(["http://localhost:8080"]);
  });

  test("includes routed hostnames when the plan enables the router", async () => {
    const result = await infoOf(planWithRouter(true));
    expect(result.services[0]?.endpoints).toEqual([
      "https://web.demo.lndo.site:38443",
      "http://localhost:8080",
    ]);
  });
});
