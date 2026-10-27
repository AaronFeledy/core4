import type { DestroyAppError, DestroyAppResult } from "@lando/sdk/app";
import { PostDestroyEvent, PreDestroyEvent } from "@lando/sdk/events";
import { EventService, RouterService, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import { prepareDestroyFileSync } from "./destroy-file-sync.ts";
import type { TeardownPlan } from "./destroy-plan.ts";
import { withDestroyProgress } from "./destroy-progress.ts";
import {
  cleanupDestroyHostState,
  cleanupDestroyWorkers,
  destroyPlannedProvider,
} from "./destroy-provider.ts";
import { removeSnapshots } from "./destroy-snapshots.ts";
import { runAppEvent, runAppInitEvents } from "./events.ts";
import { confirmDestroyWithoutLandofileEvents } from "./landofile-events.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";

const unchanged = (app: string): DestroyAppResult => ({
  app,
  outcome: "unchanged",
  servicesDestroyed: [],
  volumesRemoved: false,
  snapshotsRemoved: 0,
});

const executeLocked = Effect.fnUntraced(function* (plan: TeardownPlan) {
  const evidence = plan.evidence;
  if (evidence === undefined) return unchanged(plan.name);
  const registry = yield* RuntimeProviderRegistry;
  const target = plan.target;
  const provider = target === undefined ? undefined : yield* registry.select(target.plan);
  const cleanup = yield* prepareOwnedResourceCleanupFrom(plan.inventory, plan.root, {
    volumes: plan.options.volumes === true,
    purgeCaches: plan.options.purgeCaches === true,
  });
  for (const group of plan.groups) yield* registry.select(group.providerId);
  const fileSync =
    target === undefined || provider === undefined
      ? undefined
      : yield* prepareDestroyFileSync(target, provider);
  const events = yield* EventService;
  const proxy = yield* Effect.serviceOption(RouterService);
  const applied = evidence === "applied" ? plan.applied : undefined;
  const hooks = plan.authored;
  const authored = hooks?.plan;
  if (
    hooks?.skipLevel === "warn" &&
    (plan.options.volumes === true ||
      plan.options.purgeCaches === true ||
      plan.options.purgeSnapshots === true)
  ) {
    yield* confirmDestroyWithoutLandofileEvents(hooks.outcome, plan.options.yes === true);
  }
  if (authored !== undefined && fileSync?.resumed !== true) yield* runAppInitEvents(authored);
  for (const app of plan.refs) {
    const pre = PreDestroyEvent.make({ app, evidence, timestamp: DateTime.nowUnsafe() });
    yield* events.publish(pre);
  }
  if (applied !== undefined && authored !== undefined && fileSync?.resumed !== true)
    yield* runAppEvent(
      authored,
      "pre-destroy",
      PreDestroyEvent.make({ app: applied.app, evidence, timestamp: DateTime.nowUnsafe() }),
    );
  const hasProvider = target !== undefined || plan.groups.length > 0 || plan.inventory.length > 0;
  const result = yield* withDestroyProgress({
    events,
    plan: { id: plan.refs[0]?.id ?? plan.root, name: plan.name },
    children: {
      fileSync: fileSync?.applicable === true,
      snapshots: plan.snapshots.length > 0,
      provider: hasProvider,
      hostProxy: target !== undefined,
      proxy: target !== undefined && Option.isSome(proxy),
    },
    work: Effect.fnUntraced(function* (tree) {
      if (fileSync?.applicable === true) yield* tree.startTask("file-sync");
      if (fileSync !== undefined) {
        yield* fileSync.quiesceRetained.pipe(Effect.tapError(() => tree.failTask("file-sync")));
      }
      let snapshotsRemoved = 0;
      if (plan.snapshots.length > 0) {
        yield* tree.startTask("snapshots");
        snapshotsRemoved = yield* removeSnapshots(plan.snapshots).pipe(
          Effect.tapError(() => tree.failTask("snapshots")),
        );
        yield* tree.completeTask("snapshots");
      }
      if (fileSync !== undefined)
        yield* fileSync.dispose.pipe(Effect.tapError(() => tree.failTask("file-sync")));
      if (fileSync?.applicable === true) yield* tree.completeTask("file-sync");
      const services = new Set<string>();
      let volumesRemoved = false;
      let changed = snapshotsRemoved > 0;
      if (hasProvider) {
        yield* tree.startTask("provider");
        const remove = Effect.gen(function* () {
          if (target !== undefined && provider !== undefined) {
            const outcome = yield* destroyPlannedProvider({ ...plan, target }, provider);
            switch (outcome.kind) {
              case "destroyed":
                for (const service of Object.values(target.plan.services).reverse())
                  services.add(String(service.name));
                volumesRemoved = plan.options.volumes === true || plan.options.purgeCaches === true;
                changed = true;
                break;
              case "no-op":
                break;
              default: {
                const unreachable: never = outcome;
                return unreachable;
              }
            }
          }
          if (plan.groups.length > 0) {
            const removed = yield* tearDownOrphans({
              root: plan.root,
              groups: plan.groups,
              options: {
                volumes: plan.options.volumes === true,
                purgeCaches: plan.options.purgeCaches === true,
              },
              ownedCleanup: cleanup,
            });
            for (const service of removed.services) services.add(service);
            volumesRemoved ||= removed.volumesRemoved;
            changed ||= removed.services.length > 0 || removed.volumesRemoved || removed.ownedChanged;
          } else {
            const removed = yield* cleanup;
            for (const service of removed.servicesRemoved) services.add(service);
            volumesRemoved ||= removed.volumesRemoved > 0;
            changed ||= ownedCleanupChanged(removed);
          }
          yield* tree.completeTask("provider");
        }).pipe(
          Effect.tapError(() => tree.failTask("provider")),
          Effect.onInterrupt(() => cleanupDestroyWorkers(plan, tree)),
        );
        yield* runAllAndMergeFailures<
          DestroyAppError,
          Effect.Services<ReturnType<typeof cleanupDestroyHostState>> | RuntimeProviderRegistry
        >([remove, cleanupDestroyHostState(plan, tree)]);
      }
      if (fileSync !== undefined) yield* fileSync.complete;
      if (plan.followUpOrphans) {
        const remaining = yield* registry.resolveTeardownEvidence(plan.root);
        if (remaining.kind === "orphans") {
          const removed = yield* tearDownOrphans({
            root: plan.root,
            groups: remaining.groups,
            options: {
              volumes: plan.options.volumes === true,
              purgeCaches: plan.options.purgeCaches === true,
            },
          });
          for (const service of removed.services) services.add(service);
          volumesRemoved ||= removed.volumesRemoved;
          changed ||= removed.ownedChanged || removed.services.length > 0 || removed.volumesRemoved;
        }
      }
      return {
        app: plan.name,
        outcome: changed ? ("destroyed" as const) : ("unchanged" as const),
        servicesDestroyed: [...services],
        volumesRemoved,
        snapshotsRemoved,
      };
    }),
  });
  for (const app of plan.refs) {
    const post = PostDestroyEvent.make({
      app,
      evidence,
      outcome: result.outcome,
      timestamp: DateTime.nowUnsafe(),
    });
    if (authored !== undefined && app.id === authored.id && app.root === authored.root)
      yield* runAppEvent(authored, "post-destroy", post);
    yield* events.publish(post);
  }
  return hooks === undefined ? result : { ...result, landofileEvents: hooks.outcome };
});

export const executeTeardown = Effect.fn("AppOperation.executeTeardown")(function* (plan: TeardownPlan) {
  const target = plan.target;
  const work = Effect.gen(function* () {
    if (target === undefined) return yield* executeLocked(plan);
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(target.plan);
    const stateStore = yield* StateStore;
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof executeLocked>>>();
    return yield* withPlanVolumeCoordination({
      plan: target.plan,
      provider,
      stateStore,
      body: () => executeLocked(plan).pipe(Effect.provide(context)),
    });
  });
  return yield* [...plan.refs]
    .sort((a, b) => `${a.root}\0${a.id}`.localeCompare(`${b.root}\0${b.id}`))
    .reduceRight((body, ref) => withAppMutationLock(ref, body), work);
});
