import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { CurrentExecutableAppPlan, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import { decodeAppPlan } from "../../src/planner/plan-decode.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

test("rejects an invalid generated route at the final AppPlan boundary", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "route-plan",
    services: { ["a".repeat(64)]: { type: "nginx" } },
  });
  // When
  const result = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer))),
      Effect.result,
    ),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(LandofileValidationError);
    if (result.failure instanceof LandofileValidationError)
      expect(result.failure.issues.map(({ path, suggestion }) => [path, suggestion !== undefined])).toEqual([
        [["routes", 0, "hostname"], true],
      ]);
  }
});
import { planTestLandofile } from "../compiled-landofile.ts";

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
