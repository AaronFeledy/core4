import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
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
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
      Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(PluginRegistryLayer.layer))),
      Effect.result,
    ),
  );
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(LandofileValidationError);
    if (result.failure instanceof LandofileValidationError)
      expect(result.failure.issues.map(({ path }) => path)).toEqual([["routes", 0, "hostname"]]);
  }
});
