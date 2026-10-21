import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan } from "@lando/sdk/schema";
import { EventService, PathsService, RouterService, type RuntimeProviderShape } from "@lando/sdk/services";
import type { TaskTreeController } from "@lando/sdk/task-progress";
import { DateTime, Effect, Option } from "effect";
import { verifyActiveVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { cleanupHostProxyRunLandoState } from "../subsystems/host-proxy/transport.ts";
import { cleanupAgentRelayState } from "../subsystems/ssh-agent/cleanup.ts";
import type { TeardownPlan } from "./destroy-plan.ts";

const removeStrayAppContainers = Effect.fnUntraced(function* (provider: RuntimeProviderShape, plan: AppPlan) {
  if (plan.id === "global") return;
  const observed = yield* provider
    .list({ app: plan.id, includeUnplanned: true })
    .pipe(Effect.catch(() => Effect.succeed([])));
  for (const service of observed) {
    if (
      service.containerId !== undefined &&
      service.app === plan.id &&
      service.appRoot === (plan.identity?.appRoot ?? plan.root) &&
      !Object.hasOwn(plan.services, service.service)
    )
      yield* provider.removeObservedService(service);
  }
});

export const destroyPlannedProvider = Effect.fn("AppOperation.destroyPlannedProvider")(function* (
  teardown: TeardownPlan,
  provider: RuntimeProviderShape,
) {
  const target = teardown.target;
  if (target === undefined) return;
  yield* verifyActiveVolumeCoordination(provider);
  yield* removeStrayAppContainers(provider, target.plan);
  yield* provider.destroy(
    { app: target.plan.id, plan: target.plan },
    {
      volumes: teardown.options.volumes === true,
      ...(teardown.options.purgeCaches === undefined ? {} : { purgeCaches: teardown.options.purgeCaches }),
      removeState: true,
    },
  );
});

export const cleanupDestroyWorkers = Effect.fn("AppOperation.cleanupDestroyWorkers")(function* (
  teardown: TeardownPlan,
  tree: TaskTreeController,
) {
  const target = teardown.target;
  if (target === undefined) return;
  const paths = yield* PathsService;
  const roots = { ...paths.roots, platform: paths.platform };
  yield* tree.startTask("host-proxy");
  yield* cleanupAgentRelayState(target.app, roots, "ssh");
  yield* cleanupAgentRelayState(target.app, roots, "gpg");
  yield* cleanupHostProxyRunLandoState(target.app, roots);
  yield* tree.completeTask("host-proxy");
});

export const cleanupDestroyHostState = Effect.fn("AppOperation.cleanupDestroyHostState")(function* (
  teardown: TeardownPlan,
  tree: TaskTreeController,
) {
  const target = teardown.target;
  if (target === undefined) return;
  yield* cleanupDestroyWorkers(teardown, tree);
  const proxy = yield* Effect.serviceOption(RouterService);
  if (Option.isSome(proxy)) {
    yield* tree.startTask("routes");
    yield* proxy.value.removeRoutes(target.plan.id).pipe(Effect.tapError(() => tree.failTask("routes")));
    yield* tree.completeTask("routes");
  } else {
    const events = yield* EventService;
    yield* events.publish(
      MessageWarnEvent.make({
        body: `Proxy service is unavailable; destroying ${target.plan.name} without route cleanup.`,
        timestamp: DateTime.nowUnsafe(),
      }),
    );
  }
});
