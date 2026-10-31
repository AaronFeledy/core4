import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { resolveDesiredAppTarget } from "@lando/engine/landofile/app-resolution";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { makeLandoRuntime, withRuntimeProviderRegistryOverride } from "../runtime/layer.ts";
import "../runtime/bundled-plugins.ts";

const canonicalPath = (path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => realpath(path)).pipe(
    Effect.catch(() =>
      Effect.logDebug("scenario-provider canonicalPath falling back to lexical path").pipe(
        Effect.annotateLogs({ path }),
        Effect.as(path),
      ),
    ),
  );

const planAppRoot = (plan: AppPlan): string => plan.identity?.appRoot ?? plan.root;

const planMatchesRoot = (appRoot: string, root: string): boolean => {
  const child = relative(appRoot, root);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

/** Each scenario owns its applied plans, independently of later Landofile edits. */
export const makeScenarioProvider = () => {
  const plans = new Map<AbsolutePath, AppPlan>();
  const exactPlan = (root: string) => plans.get(AbsolutePath.make(root));
  const resolvePlan = (root: string) =>
    canonicalPath(root).pipe(
      Effect.map(
        (canonical) =>
          [...plans.entries()]
            .filter(([appRoot]) => planMatchesRoot(appRoot, canonical))
            .sort(([left], [right]) => right.length - left.length)[0]?.[1],
      ),
    );
  const resolveExactPlan = (root: string) => canonicalPath(root).pipe(Effect.map(exactPlan));
  const indexPlan = (plan: AppPlan) => plans.set(AbsolutePath.make(planAppRoot(plan)), plan);
  const unindexPlan = (plan: AppPlan) => plans.delete(AbsolutePath.make(planAppRoot(plan)));
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    capabilities: { ...TestRuntimeProvider.capabilities, artifactBuild: true },
    appliedPlans: Effect.sync(() => [...plans.values()]),
    apply: (plan, options) =>
      TestRuntimeProvider.apply(plan, options).pipe(Effect.tap(() => Effect.sync(() => indexPlan(plan)))),
    destroy: (target, options) =>
      TestRuntimeProvider.destroy(target, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (options.removeState !== false && target.plan !== undefined) unindexPlan(target.plan);
          }),
        ),
      ),
  };
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: (root) =>
      resolveExactPlan(root).pipe(Effect.map((plan) => (plan === undefined ? [] : [plan]))),
    resolveAppliedPlan: resolvePlan,
    resolveTeardownEvidence: (root) =>
      resolveExactPlan(root).pipe(
        Effect.map((plan) =>
          plan === undefined ? { kind: "absent" as const } : { kind: "applied" as const, plan },
        ),
      ),
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(provider.capabilities),
    select: (target) =>
      Effect.succeed({
        ...provider,
        id: typeof target === "string" ? target : (target?.provider ?? provider.id),
      }),
  });
  const registryLayer = Layer.succeed(RuntimeProviderRegistry, registry);
  // The planner captures its registry at layer construction, before host overrides are merged.
  const plannerDependencies = makeLandoRuntime({ bootstrap: "plugins", plugins: { policy: "bundled-only" } });
  const layer = Layer.merge(
    registryLayer,
    AppPlannerLayer.layer.pipe(Layer.provide(Layer.merge(plannerDependencies, registryLayer)), Layer.orDie),
  );
  return {
    layer,
    provider,
    forget: async (root: string) => {
      const plan = await Effect.runPromise(resolveExactPlan(root));
      if (plan === undefined) return false;
      unindexPlan(plan);
      return true;
    },
    remember: async (cwd: string) => {
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
        indexPlan(target.plan);
      } finally {
        process.chdir(previousCwd);
      }
    },
  };
};
