import { expect, test } from "bun:test";
import { AppPlannerLive, PluginRegistryLive } from "@lando/core/testing";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";

test("creates no generated stores when Redis persistence is disabled", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "ephemeral",
    services: { cache: { type: "redis", persist: false } },
  });
  // When
  const plan = await Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );
  // Then
  expect(plan.stores).toEqual([]);
  expect(Object.values(plan.services).flatMap((service) => service.storage)).toEqual([]);
});
