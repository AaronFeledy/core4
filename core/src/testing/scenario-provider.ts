import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { makeAppliedPlanCache } from "@lando/container-runtime/applied-plan-cache";
import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { scratchLabelsForPlan } from "@lando/container-runtime/labels";
import { forgetAppliedPlanUnlessKept, rememberAppliedPlan } from "@lando/container-runtime/provider-assembly";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import type { ScenarioProps } from "@lando/sdk/docs/components";
import { ProxyApplyError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, type AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  UrlScanner,
} from "@lando/sdk/services";
import {
  makeMintingCertificateAuthority,
  makeTestRouterService,
  makeTestRuntimeProvider,
  makeTestRuntimeProviderRegistry,
  makeTestUrlScanner,
} from "@lando/sdk/test";
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
export const makeScenarioProvider = (faults: ScenarioProps["faults"] = []) => {
  const testProvider = makeTestRuntimeProvider();
  const stateStore = makeTestStateStore().service;
  const appliedState: PluginStateStore = {
    open: (spec) => stateStore.open({ ...spec, root: { path: appliedPlanStateRoot } }),
    withLock: (key, body) => stateStore.withLock(key, body),
  };
  const store = makeAppliedPlanStore({ providerId: "lando", layout: "record" });
  const appliedPlanCache = makeAppliedPlanCache({
    providerId: ProviderId.make(testProvider.id),
    providerName: "scenario",
    appliedPlanState: appliedState,
    load: (state, appId) => store.loadAppliedPlanStrict(state, appId),
    persist: (state, plan) => store.persistAppliedPlan(state, plan),
    remove: (state, appId) => store.removeAppliedPlan(state, appId),
  });
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
        .pipe(Effect.tap(() => rememberAppliedPlan(appliedPlanCache, plan, options))),
    bringDown: (target, options) =>
      testProvider
        .bringDown(target, options)
        .pipe(Effect.tap(() => forgetAppliedPlanUnlessKept(appliedPlanCache, target.app, options))),
  };
  const registry = makeTestRuntimeProviderRegistry({
    readAppliedPlanStrict: ({ id }) => store.loadAppliedPlanStrict(appliedState, id),
    appliedStateInventory: () => store.listAppliedPlans(appliedState),
    observeRuntime: Effect.all({ appliedPlans, services: provider.list({}) }).pipe(
      Effect.map(({ appliedPlans, services }) => [
        {
          providerId: ProviderId.make(provider.id),
          runtimeObserved: true,
          appliedPlans,
          services: services.map((service) => {
            const plan = appliedPlans.find(
              (plan) => plan.id === service.app && planAppRoot(plan) === service.appRoot,
            );
            return plan === undefined
              ? service
              : { ...service, labels: { ...service.labels, ...scratchLabelsForPlan(plan) } };
          }),
          volumes: [],
        },
      ]),
    ),
    appliedPlansFor: (root) =>
      resolveExactPlan(root).pipe(Effect.map((plan) => (plan === undefined ? [] : [plan]))),
    resolveAppliedPlan: (root, _app, lookup) =>
      lookup === "exact" ? resolveExactPlan(root) : resolvePlan(root),
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
  // containers for a real proxy to reach, and nothing listens on the routed URLs, so the post-start
  // scan has no host to probe. The CA resolver uses an in-memory `mkcert` authority to match
  // the planner's platform default without downloading or trusting a host tool.
  const router = makeTestRouterService();
  const certificateAuthority = makeMintingCertificateAuthority({ id: "mkcert" });
  const hostServices = Layer.mergeAll(
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...router,
        id: "traefik",
        applyRoutes: faults.includes("router.apply-routes")
          ? (_routes, owner) =>
              Effect.fail(
                new ProxyApplyError({
                  app: owner.id,
                  proxyId: "traefik",
                  message: "Scenario injected a route publication failure.",
                  remediation: "Retry with a working router.",
                }),
              )
          : router.applyRoutes,
      }),
    ),
    Layer.succeed(UrlScanner, UrlScanner.of(makeTestUrlScanner())),
    Layer.succeed(
      CertificateAuthorityResolver,
      CertificateAuthorityResolver.of({
        selectedId: certificateAuthority.id,
        resolve: Effect.succeed(certificateAuthority),
      }),
    ),
  );
  return { layer: Layer.succeed(RuntimeProviderRegistry, registry), hostServices, provider, appliedPlans };
};
