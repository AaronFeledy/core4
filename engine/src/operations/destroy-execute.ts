import type { DestroyAppError, DestroyAppResult } from "@lando/sdk/app";
import { PostDestroyEvent, PreDestroyEvent } from "@lando/sdk/events";
import { type ServiceShutdownObservation, appIdentityKey } from "@lando/sdk/schema";
import {
  EventService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import { runAllAndMergeFailures } from "../lifecycle/failure-compensation.ts";
import { routeOwnerFromPlan } from "../lifecycle/route-owner.ts";
import { removeServiceCertificates } from "../lifecycle/service-certificate-paths.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { clearAppBuildResults } from "../services/build-results.ts";
import { removeBuildTranscripts } from "../services/build-transcript-cleanup.ts";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import { clearAppDataIdentityWhenComplete } from "./data-identity-clear.ts";
import { prepareDestroyFileSync } from "./destroy-file-sync.ts";
import type { TeardownPlan } from "./destroy-plan.ts";
import { withDestroyProgress } from "./destroy-progress.ts";
import {
  cleanupDestroyHostState,
  cleanupDestroyWorkers,
  destroyPlannedProvider,
  destroyRoutesTaskDeclared,
} from "./destroy-provider.ts";
import { removeSnapshots } from "./destroy-snapshots.ts";
import { runAppEvent, runAppInitEvents } from "./events.ts";
import { confirmDestroyWithoutLandofileEvents } from "./landofile-events.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { ownedCleanupChanged, prepareOwnedResourceCleanupFrom } from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

const unchanged = (app: string): DestroyAppResult => ({
  app,
  outcome: "unchanged",
  servicesDestroyed: [],
  volumesRemoved: false,
  snapshotsRemoved: 0,
});

const executeLocked = Effect.fnUntraced(function* (plan: TeardownPlan) {
  const stateStore = yield* StateStore;
  const paths = yield* PathsService;
  const buildAppIds = [
    ...new Set([
      ...(plan.buildAppId === undefined ? [] : [plan.buildAppId]),
      ...plan.refs.map((ref) => ref.id),
    ]),
  ];
  const buildProviderId = String(plan.target?.plan.provider ?? plan.applied?.plan.provider ?? "lando");
  // A build.app result only describes the container the step ran in, and a teardown that fails
  // halfway has already removed containers: forget those results before any provider call runs.
  yield* Effect.forEach(buildAppIds, (appId) => clearAppBuildResults(stateStore, appId), {
    discard: true,
  });
  const removeBuildOutput = Effect.forEach(
    buildAppIds,
    (appId) =>
      removeBuildTranscripts({
        providerId: buildProviderId,
        userDataRoot: paths.roots.userDataRoot,
        appId,
        scratch: false,
      }),
    { discard: true },
  );
  const evidence = plan.evidence;
  const ownsUserData = plan.refs.length === 0 || plan.refs.some((ref) => ref.kind === "user");
  if (evidence === undefined) {
    // Early no-evidence path: clear only when --volumes and data volumes already absent.
    if (ownsUserData) {
      yield* clearAppDataIdentityWhenComplete({
        root: plan.root,
        volumesRequested: plan.options.volumes === true,
      });
    }
    // A start that failed after certificate preparation leaves only host-side leaf material.
    if ((yield* TeardownProvider) === undefined)
      yield* removeServiceCertificates(appIdentityKey("owner", plan.root));
    yield* removeBuildOutput;
    return unchanged(plan.name);
  }
  const registry = yield* RuntimeProviderRegistry;
  const target = plan.target;
  const provider = target === undefined ? undefined : yield* registry.select(target.plan);
  const cleanup = yield* prepareOwnedResourceCleanupFrom(plan.inventory, plan.root, {
    volumes: plan.options.volumes === true,
    purgeCaches: plan.options.purgeCaches === true,
  });
  for (const group of plan.groups) yield* registry.select(group.providerId);
  const fileSync =
    target === undefined || provider === undefined || plan.missingStart !== undefined
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
      proxy: destroyRoutesTaskDeclared(plan, proxy),
    },
    work: Effect.fnUntraced(function* (tree) {
      yield* plan.missingStart?.terminate ?? Effect.void;
      const retired = yield* plan.retire ?? Effect.succeed(undefined);
      const targetRetired = target !== undefined && retired?.appIds.includes(target.app.id) === true;
      if (fileSync?.applicable === true) yield* tree.startTask("file-sync");
      if (fileSync !== undefined && !targetRetired) {
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
      const quiesced =
        fileSync === undefined || targetRetired
          ? undefined
          : yield* fileSync.dispose.pipe(Effect.tapError(() => tree.failTask("file-sync")));
      if (fileSync?.applicable === true) yield* tree.completeTask("file-sync");
      const services = new Set<string>(retired?.servicesRemoved);
      const observationSources: Array<readonly ServiceShutdownObservation[] | undefined> = [
        retired?.shutdownObservations,
        quiesced?.shutdownObservations,
      ];
      let volumesRemoved = retired?.volumesRemoved === true;
      let changed = retired !== undefined || snapshotsRemoved > 0;
      let skipped: NonNullable<import("@lando/sdk/schema").OwnedResourcesCleanupResult["skipped"]> = [];
      const ownedCleanup = cleanup.pipe(
        Effect.tap((removed) =>
          Effect.sync(() => {
            skipped = [...skipped, ...(removed.skipped ?? [])];
          }),
        ),
      );
      if (hasProvider) {
        yield* tree.startTask("provider");
        const remove = Effect.gen(function* () {
          if (target !== undefined && provider !== undefined && !targetRetired) {
            const outcome = yield* destroyPlannedProvider({ ...plan, target }, provider);
            observationSources.push(outcome.shutdownObservations);
            switch (outcome.kind) {
              case "destroyed":
                for (const service of Object.values(target.plan.services).reverse())
                  services.add(String(service.name));
                volumesRemoved ||= plan.options.volumes === true || plan.options.purgeCaches === true;
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
              ownedCleanup,
            });
            observationSources.push(removed.shutdownObservations);
            for (const service of removed.services) services.add(service);
            volumesRemoved ||= removed.volumesRemoved;
            changed ||= removed.services.length > 0 || removed.volumesRemoved || removed.ownedChanged;
          } else {
            const removed = yield* ownedCleanup;
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
      if (fileSync !== undefined && !targetRetired) yield* fileSync.complete;
      if (plan.missingStart !== undefined) {
        yield* plan.missingStart.removeTargets;
        yield* plan.missingStart.complete;
        changed = true;
      }
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
          observationSources.push(removed.shutdownObservations);
          for (const service of removed.services) services.add(service);
          volumesRemoved ||= removed.volumesRemoved;
          changed ||= removed.ownedChanged || removed.services.length > 0 || removed.volumesRemoved;
        }
      }
      // Reached only when every removal step succeeded; a failed teardown keeps the leaf material.
      // A provider-scoped destroy keeps it: another provider's realization may still mount it.
      if ((yield* TeardownProvider) === undefined)
        yield* removeServiceCertificates(
          target === undefined
            ? appIdentityKey("owner", plan.root)
            : routeOwnerFromPlan(target.plan).ownerKey,
        );
      const result = withShutdownObservations(
        {
          app: plan.name,
          outcome: changed ? ("destroyed" as const) : ("unchanged" as const),
          servicesDestroyed: [...services],
          volumesRemoved,
          snapshotsRemoved,
        },
        ...observationSources,
      );
      // Never trust volumesRemoved: clear only with complete evidence volumes are gone.
      if (ownsUserData) {
        yield* clearAppDataIdentityWhenComplete({
          root: plan.root,
          volumesRequested: plan.options.volumes === true,
          ...(skipped.length === 0 ? {} : { skipped }),
        });
      }
      return result;
    }),
  });
  yield* removeBuildOutput;
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
    const registry = yield* RuntimeProviderRegistry;
    if (target === undefined) return yield* executeLocked(plan);
    const provider = yield* registry.select(target.plan);
    const stateStore = yield* StateStore;
    return yield* withPlanVolumeCoordination({
      plan: target.plan,
      provider,
      stateStore,
      body: () => executeLocked(plan),
    });
  });
  const refs =
    plan.refs.length === 0 ? [{ kind: "user" as const, id: plan.name, root: plan.root }] : plan.refs;
  return yield* [...refs]
    .sort((a, b) => `${a.root}\0${a.id}`.localeCompare(`${b.root}\0${b.id}`))
    .reduceRight((body, ref) => withAppMutationLock(ref, body), work);
});
