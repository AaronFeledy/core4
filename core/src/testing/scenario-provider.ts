import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  type ListFilter,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
  UrlScanner,
} from "@lando/sdk/services";
import { makeTestRouterService, makeTestRuntimeProvider, makeTestUrlScanner } from "@lando/sdk/test";
import { Clock, DateTime, Effect, Layer } from "effect";

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
  // Containers this scenario has created, so observation reports what apply, stop, and destroy did.
  const containers = new Map<string, { readonly status: "running" | "exited"; readonly startedAt: number }>();
  const containerKey = (app: string, service: string) => `${app}/${service}`;
  const setRunState = (app: string, service: string, status: "running" | "exited") =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        const key = containerKey(app, service);
        const current = containers.get(key);
        if (current === undefined) return;
        containers.set(key, { status, startedAt: status === "running" ? now : current.startedAt });
      }),
    );
  const observe = (filter: ListFilter) =>
    appliedPlans.pipe(
      Effect.map((plans) =>
        plans
          .filter((plan) => filter.app === undefined || plan.id === filter.app)
          .flatMap((plan) =>
            Object.keys(plan.services).flatMap((service): ReadonlyArray<ServiceRuntimeInfo> => {
              const key = containerKey(plan.id, service);
              const container = containers.get(key);
              if (container === undefined) return [];
              return [
                {
                  app: plan.id,
                  appRoot: AbsolutePath.make(planAppRoot(plan)),
                  service: ServiceName.make(service),
                  providerId: plan.provider,
                  containerId: key,
                  status: container.status,
                  lastStartedAt: DateTime.toDateUtc(DateTime.makeUnsafe(container.startedAt)),
                  publications: { status: "unknown" },
                },
              ];
            }),
          ),
      ),
    );
  const provider: RuntimeProviderShape = {
    ...testProvider,
    capabilities: { ...testProvider.capabilities, artifactBuild: true },
    appliedPlans,
    apply: (plan, options) =>
      testProvider.apply(plan, options).pipe(
        Effect.tap(() => store.persistAppliedPlan(appliedState, options.recordedPlan ?? plan)),
        Effect.tap(() =>
          Clock.currentTimeMillis.pipe(
            Effect.map((startedAt) => {
              // An apply leaves an already running container running, as reconciling an unchanged one does.
              for (const service of Object.keys(plan.services)) {
                const key = containerKey(plan.id, service);
                const current = containers.get(key);
                containers.set(key, {
                  status: "running",
                  startedAt: current?.status === "running" ? current.startedAt : startedAt,
                });
              }
            }),
          ),
        ),
      ),
    start: (target) => setRunState(target.app, target.service, "running"),
    restart: (target) => setRunState(target.app, target.service, "running"),
    stop: (target) => setRunState(target.app, target.service, "exited"),
    list: observe,
    removeObservedService: (observed) =>
      Effect.sync(() => {
        const key = containerKey(observed.app, observed.service);
        if (observed.containerId !== key || !containers.has(key)) return { kind: "absent" as const };
        containers.delete(key);
        return { kind: "removed" as const };
      }),
    inspect: (target) =>
      observe({ app: target.app }).pipe(
        Effect.map(
          (services): ServiceRuntimeInfo =>
            services.find((service) => service.service === target.service) ?? {
              app: target.app,
              service: target.service,
              providerId: ProviderId.make(testProvider.id),
              status: "absent",
              publications: { status: "unknown" },
            },
        ),
      ),
    destroy: (target, options) =>
      testProvider.destroy(target, options).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const key of containers.keys()) if (key.startsWith(`${target.app}/`)) containers.delete(key);
          }),
        ),
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
