import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  UrlScanner,
} from "@lando/sdk/services";
import { makeTestRouterService, makeTestRuntimeProvider, makeTestUrlScanner } from "@lando/sdk/test";
import { Effect, Layer } from "effect";

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

const appliedPlanStateRoot = AbsolutePath.make("/lando-scenario-provider-state");

/**
 * A scenario's own runtime provider and registry. The provider keeps its own in-memory data
 * plane, and applied plans go through the same applied-state store real providers persist to,
 * so later commands read the encoded, hook-free record rather than the object that was applied.
 */
export const makeScenarioProvider = () => {
  const testProvider = makeTestRuntimeProvider();
  const stateStore = makeTestStateStore().service;
  const appliedState: PluginStateStore = {
    open: (spec) => stateStore.open({ ...spec, root: { path: appliedPlanStateRoot } }),
    withLock: (key, body) => stateStore.withLock(key, body),
  };
  const store = makeAppliedPlanStore({ providerId: "lando", layout: "record" });
  const appliedPlans = store.listAppliedPlans(appliedState).pipe(
    Effect.map((inventory) => inventory.plans),
    Effect.orDie,
  );
  const resolvePlan = (root: string) =>
    Effect.all([canonicalPath(root), appliedPlans]).pipe(
      Effect.map(
        ([canonical, plans]) =>
          plans
            .filter((plan) => planMatchesRoot(planAppRoot(plan), canonical))
            .sort((left, right) => planAppRoot(right).length - planAppRoot(left).length)[0],
      ),
    );
  const resolveExactPlan = (root: string) =>
    Effect.all([canonicalPath(root), appliedPlans]).pipe(
      Effect.map(([canonical, plans]) => plans.find((plan) => planAppRoot(plan) === canonical)),
    );
  const provider: RuntimeProviderShape = {
    ...testProvider,
    // Guides show resource limits and GPU requests, so the scenario provider realizes those knobs too.
    capabilities: {
      ...testProvider.capabilities,
      artifactBuild: true,
      composeKnobs: {
        supported: [...(testProvider.capabilities.composeKnobs?.supported ?? []), "deploy.resources", "gpus"],
      },
    },
    appliedPlans,
    apply: (plan, options) =>
      testProvider
        .apply(plan, options)
        .pipe(Effect.tap(() => store.persistAppliedPlan(appliedState, options.recordedPlan ?? plan))),
    destroy: (target, options) =>
      testProvider
        .destroy(target, options)
        .pipe(
          Effect.tap(() =>
            options.removeState === false ? Effect.void : store.removeAppliedPlan(appliedState, target.app),
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
  // Routes go to an in-memory stand-in for the default Traefik router: the scenario has no
  // containers for a real proxy to reach, and no host ports or certificate authority to touch.
  // Nothing listens on the scenario's routed URLs, so the post-start scan has no host to probe.
  const hostServices = Layer.mergeAll(
    Layer.succeed(RouterService, RouterService.of({ ...makeTestRouterService(), id: "traefik" })),
    Layer.succeed(UrlScanner, UrlScanner.of(makeTestUrlScanner())),
  );
  return { layer: Layer.succeed(RuntimeProviderRegistry, registry), hostServices, provider, appliedPlans };
};
