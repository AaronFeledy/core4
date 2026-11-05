import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { type ApplyOptions, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { globalRebuild } from "../../src/operations/global-rebuild.ts";
import { globalStart } from "../../src/operations/global-start.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each(["start", "selected start", "rebuild"] as const)(
  "global %s readies a powered-off runtime before apply",
  async (operation) => {
    let ready = false;
    const harness = makeHarness({
      globalServiceIds: ["mail"],
      providerOverrides: {
        ensureReady: Effect.sync(() => {
          ready = true;
        }),
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        const guardedRegistry = RuntimeProviderRegistry.of({
          ...registry,
          select: (target) =>
            registry.select(target).pipe(
              Effect.map((provider) => ({
                ...provider,
                apply: Effect.fnUntraced(function* (plan: AppPlan, options: ApplyOptions) {
                  if (!ready)
                    return yield* Effect.fail(
                      new ProviderUnavailableError({
                        providerId: provider.id,
                        operation: "apply",
                        message: "Runtime is powered off",
                        remediation: "Prepare the runtime before applying the plan.",
                      }),
                    );
                  return yield* provider.apply(plan, options);
                }),
              })),
            ),
        });
        const services =
          operation === "rebuild"
            ? (yield* globalRebuild().pipe(Effect.provideService(RuntimeProviderRegistry, guardedRegistry)))
                .servicesRebuilt
            : (yield* globalStart(operation === "selected start" ? { services: ["mail"] } : {}).pipe(
                Effect.provideService(RuntimeProviderRegistry, guardedRegistry),
              )).servicesStarted;
        return services.map((service) => service.name);
      }).pipe(Effect.provide(harness.layer)),
    );

    expect(result).toEqual(["mail"]);
  },
);
