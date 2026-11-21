import { expect, spyOn, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { CurrentExecutableAppPlan, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import * as PlanCache from "../../src/cache/app-plan.ts";
import * as Cache from "../../src/cache/service.ts";
import { decodeAppPlan } from "../../src/planner/plan-decode.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { planTestLandofile } from "../compiled-landofile.ts";

const planService = (service: string, certs: boolean) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "route-plan",
    services: { [service]: { type: "nginx", certs, healthcheck: { kind: "none" } } },
  });
  return Effect.flatMap(AppPlanner, (planner) =>
    planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer))));
};

test.each([
  ["a".repeat(63), false, "a".repeat(63)],
  ["pma_theme", true, "pma-theme"],
  ["8.3", false, "8.3"],
] as const)("plans the default hostname for %s", async (service, certs, label) => {
  const plan = await Effect.runPromise(planService(service, certs));

  const hostname = `${label}.route-plan.lndo.site`;
  expect(plan.routes.map((route) => [route.service, route.hostname])).toEqual([[service, hostname]]);
  const certificate = plan.services[Schema.decodeUnknownSync(ServiceName)(service)]?.certs;
  if (certs) expect(certificate?.sans).toContain(hostname);
  else expect(certificate).toBeUndefined();
});

test.each([false, true])(
  "rejects a valid key whose derived internal DNS name is too long (certs: %s)",
  async (certs) => {
    const service = Array.from({ length: 4 }, () => "a".repeat(60)).join(".");
    const result = await Effect.runPromise(planService(service, certs).pipe(Effect.result));

    if (Result.isSuccess(result) || !(result.failure instanceof LandofileValidationError))
      throw new Error("Expected service DNS validation to fail");
    expect(result.failure.issues).toMatchObject([
      {
        rule: "landofile.dns-name",
        path: ["services", service],
        message: expect.stringContaining("internal DNS name exceed 253"),
      },
    ]);
  },
);

test("final plan validation rejects an HTTPS route no certificate can cover, from any producer", async () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "route-plan",
    services: { web: { type: "nginx", routes: ["app.lndo.site"] } },
  });
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer)))),
  );
  const encoded = Schema.encodeSync(CurrentExecutableAppPlan)(plan);
  const contributed = { ...encoded.routes[0], hostname: "wild.*.app.lndo.site" };
  const decode = (scheme: "http" | "https" | "both") =>
    Effect.runPromise(
      decodeAppPlan(plan.root, { ...encoded, routes: [...encoded.routes, { ...contributed, scheme }] }).pipe(
        Effect.result,
      ),
    );

  for (const scheme of ["https", "both"] as const) {
    const result = await decode(scheme);
    if (Result.isSuccess(result)) throw new Error(`Expected ${scheme} coverage to fail`);
    expect(result.failure.issues).toMatchObject([
      { rule: "landofile.route", path: ["routes", encoded.routes.length, "hostname"] },
    ]);
  }
  expect(Result.isSuccess(await decode("http"))).toBe(true);
});

test("final plan validation rejects verified backend TLS intent only on a plain backend", async () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "route-plan",
    services: { web: { type: "nginx", routes: ["app.lndo.site"] } },
  });
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer)))),
  );
  const encoded = Schema.encodeSync(CurrentExecutableAppPlan)(plan);
  const route = encoded.routes[0];
  if (route === undefined) throw new Error("expected a planned route");
  const decode = (scheme: "http" | "https", protocol: "http" | "https") =>
    Effect.runPromise(
      decodeAppPlan(plan.root, {
        ...encoded,
        routes: [
          {
            ...route,
            scheme,
            backend: {
              ...route.backend,
              protocol,
              tls: { caId: "mkcert", serverName: "web.route-plan.internal" },
            },
          },
        ],
      }).pipe(Effect.result),
    );

  const plain = await decode("https", "http");
  if (Result.isSuccess(plain)) throw new Error("Expected TLS intent on a plain backend to fail");
  expect(plain.failure.issues).toMatchObject([
    { rule: "landofile.route", path: ["routes", 0, "backend", "tls"] },
  ]);
  expect(Result.isSuccess(await decode("https", "https"))).toBe(true);
  expect(Result.isSuccess(await decode("http", "https"))).toBe(true);
});

test("a cached plan whose HTTPS route no certificate can cover is rejected on the cache hit", async () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "route-plan",
    services: { web: { type: "nginx", routes: ["app.lndo.site"] } },
  });
  const plan = <E>(layer: Layer.Layer<AppPlanner, E>) =>
    Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
      ).pipe(Effect.provide(layer), Effect.result),
    );
  const planner = AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer));
  const fresh = await plan(planner);
  if (Result.isFailure(fresh)) throw new Error("Expected the fresh plan to succeed");
  const route = fresh.success.routes[0];
  if (route === undefined) throw new Error("Expected a planned route");
  const cached = {
    ...fresh.success,
    routes: [...fresh.success.routes, { ...route, hostname: "wild.*.app.lndo.site" }],
  };
  const read = spyOn(PlanCache, "readCachedAppPlan").mockReturnValue(Effect.succeed(cached));
  try {
    const result = await plan(planner.pipe(Layer.provide(Cache.layer)));

    expect(read).toHaveBeenCalled();
    if (Result.isSuccess(result) || !(result.failure instanceof LandofileValidationError))
      throw new Error("Expected the cache hit to fail validation");
    expect(result.failure.issues).toMatchObject([
      { rule: "landofile.route", path: ["routes", fresh.success.routes.length, "hostname"] },
    ]);
  } finally {
    read.mockRestore();
  }
});
