import { realpath } from "node:fs/promises";
import { resolveDesiredAppTarget } from "@lando/engine/landofile/app-resolution";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { makeLandoRuntime, withRuntimeProviderRegistryOverride } from "../runtime/layer.ts";

/** Each scenario owns its applied plans, independently of later Landofile edits. */
export const makeScenarioProvider = () => {
  const plans = new Map<AbsolutePath, AppPlan>();
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    appliedPlans: Effect.sync(() => [...plans.values()]),
    apply: (plan, options) =>
      TestRuntimeProvider.apply(plan, options).pipe(
        Effect.tap(() => Effect.sync(() => plans.set(plan.root, plan))),
      ),
    destroy: (target, options) =>
      TestRuntimeProvider.destroy(target, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (options.removeState !== false && target.plan !== undefined) plans.delete(target.plan.root);
          }),
        ),
      ),
  };
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: (root) => Effect.sync(() => [...plans.values()].filter((plan) => plan.root === root)),
    resolveAppliedPlan: (root) => Effect.sync(() => plans.get(root)),
    resolveTeardownEvidence: (root) =>
      Effect.sync(() => {
        const plan = plans.get(root);
        return plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan };
      }),
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(provider.capabilities),
    select: (target) =>
      Effect.succeed({
        ...provider,
        id: typeof target === "string" ? target : (target?.provider ?? provider.id),
      }),
  });
  const layer = Layer.succeed(RuntimeProviderRegistry, registry);
  return {
    layer,
    provider,
    forget: async (root: string) => plans.delete(AbsolutePath.make(await realpath(root))),
    remember: async (cwd: string) => {
      await import("../runtime/bundled-plugins.ts");
      const previousCwd = process.cwd();
      try {
        process.chdir(cwd);
        const target = await withRuntimeProviderRegistryOverride(layer, () =>
          Effect.runPromise(
            resolveDesiredAppTarget.pipe(
              Effect.provide(
                makeLandoRuntime({ bootstrap: "app", cwd, plugins: { policy: "bundled-only" } }),
              ),
            ),
          ),
        );
        plans.set(target.root, target.plan);
      } finally {
        process.chdir(previousCwd);
      }
    },
  };
};
