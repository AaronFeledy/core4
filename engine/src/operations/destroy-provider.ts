import type { AppPlan, AppRef, ServiceShutdownObservation } from "@lando/sdk/schema";
import { PathsService, RouterService, type RouterServiceShape, type RuntimeProviderShape } from "@lando/sdk/services";
import type { TaskTreeController } from "@lando/sdk/task-progress";
import { Effect, Option } from "effect";
import { routeOwnerFromPlan, routeOwnerFromRoot } from "../lifecycle/route-owner.ts";
import { settleRoutesTask, withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { verifyActiveVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
import { cleanupAgentRelayState } from "../subsystems/ssh-agent/cleanup.ts";
import { UNAVAILABLE_ID } from "../subsystems/unavailable.ts";
import type { TeardownPlan } from "./destroy-plan.ts";
import { mergeShutdownObservations } from "./shutdown-observations.ts";

const removeStrayAppContainers = Effect.fnUntraced(function* (provider: RuntimeProviderShape, plan: AppPlan) {
  if (plan.id === "global") return undefined;
  const observed = yield* provider
    .list({ app: plan.id, includeUnplanned: true })
    .pipe(Effect.catch(() => Effect.succeed([])));
  const sources: Array<readonly ServiceShutdownObservation[] | undefined> = [];
  for (const service of observed) {
    if (
      service.containerId !== undefined &&
      service.app === plan.id &&
      service.appRoot === (plan.identity?.appRoot ?? plan.root) &&
      !Object.hasOwn(plan.services, service.service)
    ) {
      const removal = yield* provider.removeObservedService(service);
      sources.push(removal.shutdownObservations);
    }
  }
  return mergeShutdownObservations(...sources);
});

export const destroyPlannedProvider = Effect.fn("AppOperation.destroyPlannedProvider")(function* (
  teardown: TeardownPlan & { readonly target: NonNullable<TeardownPlan["target"]> },
  provider: RuntimeProviderShape,
) {
  const target = teardown.target;
  yield* verifyActiveVolumeCoordination(provider);
  const strayObservations = yield* removeStrayAppContainers(provider, target.plan);
  const outcome = yield* provider.destroy(
    { app: target.plan.id, plan: target.plan },
    {
      volumes: teardown.options.volumes === true,
      ...(teardown.options.purgeCaches === undefined ? {} : { purgeCaches: teardown.options.purgeCaches }),
      removeState: true,
    },
  );
  const shutdownObservations = mergeShutdownObservations(strayObservations, outcome.shutdownObservations);
  return shutdownObservations === undefined ? outcome : { ...outcome, shutdownObservations };
});

/** Removes an app's host worker state: agent relays, then the host proxy. Each step is best-effort. */
export const cleanupAppWorkers = Effect.fn("AppOperation.cleanupAppWorkers")(function* (
  app: Pick<AppRef, "id" | "root">,
) {
  const paths = yield* PathsService;
  const roots = { ...paths.roots, platform: paths.platform };
  yield* cleanupAgentRelayState(app, roots, "ssh");
  yield* cleanupAgentRelayState(app, roots, "gpg");
  yield* cleanupHostProxyRunLandoState(app, roots);
});

export const cleanupDestroyWorkers = Effect.fn("AppOperation.cleanupDestroyWorkers")(function* (
  teardown: TeardownPlan,
  tree: TaskTreeController,
) {
  const target = teardown.target;
  if (target === undefined) return;
  yield* tree.startTask("host-proxy");
  yield* cleanupAppWorkers(target.app);
  yield* tree.completeTask("host-proxy");
});

/** Destroy withdraws routes for a target, or by canonical root for orphan or inventory evidence. */
const destroyWithdrawsRoutes = (teardown: TeardownPlan): boolean =>
  teardown.target !== undefined || teardown.groups.length > 0 || teardown.inventory.length > 0;

/** Whether destroy runs the "routes" task; without a selectable router withdrawal only warns. */
export const destroyRoutesTaskDeclared = (
  teardown: TeardownPlan,
  router: Option.Option<Pick<RouterServiceShape, "id">>,
): boolean => destroyWithdrawsRoutes(teardown) && Option.isSome(router) && router.value.id !== UNAVAILABLE_ID;

export const cleanupDestroyHostState = Effect.fn("AppOperation.cleanupDestroyHostState")(function* (
  teardown: TeardownPlan,
  tree: TaskTreeController,
) {
  const target = teardown.target;
  yield* cleanupDestroyWorkers(teardown, tree);
  if (!destroyWithdrawsRoutes(teardown)) return;
  const owner =
    target === undefined
      ? routeOwnerFromRoot(teardown.refs[0]?.id ?? teardown.name, teardown.root)
      : routeOwnerFromPlan(target.plan);
  const declared = Option.isSome(yield* Effect.serviceOption(RouterService));
  if (declared) yield* tree.startTask("routes");
  const withdrawal = yield* withdrawOwnerRoutes(owner).pipe(
    Effect.tapError(() => (declared ? tree.failTask("routes") : Effect.void)),
  );
  if (declared) yield* settleRoutesTask(tree, withdrawal);
});
