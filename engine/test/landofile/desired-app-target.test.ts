import { expect, test } from "bun:test";
import { NotImplementedError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result } from "effect";
import { planDesiredApp, resolveDesiredAppTarget } from "../../src/landofile/app-resolution.ts";
import { plan } from "../subsystems/gpg-agent/fixture.ts";

const landofile: LandofileShape = { name: "desired", services: {} };
const failure = new NotImplementedError({
  message: "planning failed",
  commandId: "test",
  remediation: "test",
});
const registry = Layer.succeed(RuntimeProviderRegistry, {
  list: Effect.succeed([plan.provider]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.die("Provider selection is not part of planning"),
});

test("resolves a user target when the desired Landofile is planned", async () => {
  // Given
  const calls: string[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.sync(() => {
        calls.push("load");
        return landofile;
      }),
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([plan.provider]),
      capabilities: Effect.sync(() => {
        calls.push("capabilities");
        return TestRuntimeProvider.capabilities;
      }),
      select: () => Effect.die("Unexpected selection"),
    }),
    Layer.succeed(AppPlanner, {
      plan: (input, capabilities) =>
        Effect.sync(() => {
          expect(input).toBe(landofile);
          expect(capabilities).toBe(TestRuntimeProvider.capabilities);
          calls.push("plan");
          return plan;
        }),
    }),
  );
  // When
  const target = await Effect.runPromise(resolveDesiredAppTarget.pipe(Effect.provide(layer)));
  // Then
  expect(target).toEqual({
    plan,
    root: plan.root,
    app: { kind: "user", id: plan.id, root: plan.root },
    landofile,
  });
  expect(calls).toEqual(["load", "capabilities", "plan"]);
});

test("preserves the planner failure when desired planning fails", async () => {
  // Given
  const layer = Layer.mergeAll(
    registry,
    Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.fail(failure) }),
  );
  // When
  const result = await Effect.runPromise(resolveDesiredAppTarget.pipe(Effect.provide(layer), Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toBe(failure);
});

test("returns only the plan and Landofile when planning without a target", async () => {
  // Given
  const layer = Layer.mergeAll(
    registry,
    Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
  );
  // When
  const result = await Effect.runPromise(planDesiredApp.pipe(Effect.provide(layer)));
  // Then
  expect(result).toEqual({ plan, landofile });
});
