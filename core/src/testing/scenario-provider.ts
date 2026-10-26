import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { resolveDesiredAppTarget } from "@lando/engine/landofile/app-resolution";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { makeLandoRuntime, withRuntimeProviderRegistryOverride } from "../runtime/layer.ts";

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

const planMatchesRoot = (plan: AppPlan, root: string): boolean => {
  const appRoot = planAppRoot(plan);
  if (appRoot === root || plan.root === root) return true;
  const child = relative(appRoot, root);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

/** Each scenario owns its applied plans, independently of later Landofile edits. */
export const makeScenarioProvider = () => {
  const plans = new Map<AbsolutePath, AppPlan>();
  const uniquePlans = () => [...new Set(plans.values())];
  const matchingPlans = (root: string): AppPlan[] =>
    uniquePlans()
      .filter((plan) => planMatchesRoot(plan, root))
      .sort((left, right) => planAppRoot(right).length - planAppRoot(left).length);
  const lookupPlan = (root: string): AppPlan | undefined => matchingPlans(root)[0];
  const lookupPlans = (root: string): AppPlan[] => matchingPlans(root);
  const resolvePlan = (root: string) =>
    canonicalPath(root).pipe(Effect.map((canonical) => lookupPlan(canonical) ?? lookupPlan(root)));
  const indexPlan = (plan: AppPlan, ...aliases: string[]) => {
    for (const key of [plan.root, plan.identity?.appRoot, ...aliases]) {
      if (key !== undefined && key.length > 0) plans.set(AbsolutePath.make(key), plan);
    }
  };
  const unindexPlan = (plan: AppPlan) => {
    for (const [key, stored] of plans) {
      if (stored === plan) plans.delete(key);
    }
  };
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    appliedPlans: Effect.sync(() => uniquePlans()),
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
      canonicalPath(root).pipe(
        Effect.map((canonical) => {
          const matched = lookupPlans(canonical);
          return matched.length > 0 ? matched : lookupPlans(root);
        }),
      ),
    resolveAppliedPlan: resolvePlan,
    resolveTeardownEvidence: (root) =>
      resolvePlan(root).pipe(
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
  const layer = Layer.succeed(RuntimeProviderRegistry, registry);
  return {
    layer,
    provider,
    forget: async (root: string) => {
      const plan = await Effect.runPromise(resolvePlan(root));
      if (plan === undefined) return false;
      unindexPlan(plan);
      return true;
    },
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
        const cwdReal = await Effect.runPromise(canonicalPath(cwd));
        indexPlan(target.plan, cwd, cwdReal);
      } finally {
        process.chdir(previousCwd);
      }
    },
  };
};
