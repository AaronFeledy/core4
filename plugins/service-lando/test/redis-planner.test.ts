import { expect, test } from "bun:test";
import { AppPlannerLive, PluginRegistryLive } from "@lando/core/testing";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";

const planEither = (landofile: typeof LandofileShape.Type) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, TestRuntimeProvider.capabilities)).pipe(
      Effect.either,
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

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

test("refuses an authored Redis command that bypasses explicit authentication", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "command-auth",
    services: { cache: { type: "redis", password: "redis-secret", command: ["redis-server"] } },
  });

  // When
  const result = await planEither(landofile);

  // Then
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(LandofileValidationError);
    expect(result.left.message).toMatch(/authored command.*password/);
  }
});

test("refuses an authored Redis entrypoint that bypasses explicit persistence", async () => {
  // Given
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "entrypoint-persist",
    services: { cache: { type: "redis", persist: false, entrypoint: ["redis-server"] } },
  });

  // When
  const result = await planEither(landofile);

  // Then
  expect(result._tag).toBe("Left");
  if (result._tag === "Left") {
    expect(result.left).toBeInstanceOf(LandofileValidationError);
    expect(result.left.message).toMatch(/authored entrypoint.*persist/);
  }
});

test("preserves an authored Redis command when no managed startup options are present", async () => {
  // Given
  const command = ["redis-server", "--port", "6380"];
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "command-only",
    services: { cache: { type: "redis", command } },
  });

  // When
  const result = await planEither(landofile);

  // Then
  expect(result._tag).toBe("Right");
  if (result._tag === "Right")
    expect(Object.values(result.right.services).map((service) => service.command)).toContainEqual(command);
});
