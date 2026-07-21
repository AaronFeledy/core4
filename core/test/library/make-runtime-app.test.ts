import { Effect, Layer } from "effect";

import { AppPlanner, RuntimeProvider, RuntimeProviderRegistry, makeLandoRuntime } from "@lando/core";
import { type LandofileShape, ProviderId, ServiceName } from "@lando/core/schema";
import { TestRuntimeProvider } from "@lando/core/testing";

describe("library makeLandoRuntime app bootstrap", () => {
  test("runs a simple app operation with TestRuntimeProvider", async () => {
    const service = ServiceName.make("web");
    const landofile: LandofileShape = {
      name: "embedded-app",
      runtime: 4,
      provider: ProviderId.make(TestRuntimeProvider.id),
      services: {
        [service]: { image: "node:lts", primary: true },
      },
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const planner = yield* AppPlanner;
        const plan = yield* planner.plan(landofile, TestRuntimeProvider.capabilities, { kind: "user" });
        const registry = yield* RuntimeProviderRegistry;
        const provider = yield* registry.select(plan);
        const apply = yield* provider.apply(plan, { reconcile: false });
        const exec = yield* provider.exec({ app: plan.id, service, plan }, { command: ["echo", "ok"] });

        return { apply, exec, planProvider: String(plan.provider), providerId: provider.id };
      }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "app",
            plugins: {
              policy: "bundled-only",
              layers: [
                Layer.succeed(RuntimeProvider, TestRuntimeProvider),
                Layer.succeed(RuntimeProviderRegistry, {
                  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
                  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
                  select: () => Effect.succeed(TestRuntimeProvider),
                }),
              ],
            },
          }),
        ),
      ),
    );

    expect(result.providerId).toBe(TestRuntimeProvider.id);
    expect(result.planProvider).toBe(TestRuntimeProvider.id);
    expect(result.apply).toEqual({ changed: false });
    expect(result.exec).toEqual({ exitCode: 0, stdout: "echo ok", stderr: "" });
  });
});
