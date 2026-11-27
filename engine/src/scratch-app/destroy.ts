import { rm } from "node:fs/promises";
import { join } from "node:path";
import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { ScratchAppError } from "@lando/sdk/errors";
import {
  PostDestroyEvent,
  PostScratchDestroyEvent,
  PostStopEvent,
  PreDestroyEvent,
  PreScratchDestroyEvent,
  PreStopEvent,
} from "@lando/sdk/events";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { routeOwnerFromPlan, routeOwnerFromRoot, routeOwnerFromScratch } from "../lifecycle/route-owner.ts";
import { withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { removeServiceCertificates } from "../lifecycle/service-certificate-paths.ts";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import { withDestroyProgress } from "../operations/destroy-progress.ts";
import { removeSnapshots, scratchOwnedSnapshots } from "../operations/destroy-snapshots.ts";
import { BuildOwner } from "../services/build-owner.ts";
import { clearAppBuildResults } from "../services/build-results.ts";
import { removeAppBuildOutput, warnBuildOutputCleanupFailure } from "../services/build-transcript-cleanup.ts";
import { cleanupScratchInventory, cleanupScratchOwnedState } from "./owned-cleanup.ts";
import { ScratchRegistry } from "./registry.ts";
import { ScratchResourceScanner } from "./scanner.ts";
import { resolveScratchTeardown } from "./teardown-evidence.ts";

export interface ScratchReapInput {
  readonly id: string;
  readonly instanceRoot: AbsolutePath;
  readonly keepVolumes?: boolean;
  readonly plan?: AppPlan;
  readonly reason?: PreScratchDestroyEvent["reason"];
}

export const makeScratchReaper = Effect.gen(function* () {
  const events = yield* EventService;
  const registry = yield* ScratchRegistry;
  const providers = yield* RuntimeProviderRegistry;
  const scanner = yield* ScratchResourceScanner;
  const mover = yield* DataMover;
  const router = yield* RouterService;
  const paths = yield* Effect.serviceOption(PathsService);
  const stateStore = yield* StateStore;
  return Effect.fn("ScratchApp.reap")(
    function* (input: ScratchReapInput) {
      const entry = yield* registry.get(input.id);
      const reason = input.reason ?? "acquire-failure";
      if (reason === "acquire-failure" && entry === undefined) return;
      // The managed root as plans, inventories, and route owners record it, even once it is gone.
      const managedRoot = AbsolutePath.make(
        yield* canonicalMissingAppRoot(join(String(input.instanceRoot), "root")),
      );
      // The desired cache may miss after a frame bump; recover the matching applied plan
      // before planless orphan cleanup so snapshots and provider teardown still own the app.
      const lookupRoot = entry?.layout === "legacy" ? AbsolutePath.make(entry.rootPath) : managedRoot;
      const { plan, ownership, inventoryOnly } = yield* resolveScratchTeardown({
        id: input.id,
        lookupRoot,
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      }).pipe(Effect.provideService(RuntimeProviderRegistry, providers));
      const app = {
        kind: "scratch" as const,
        id: input.id,
        root: plan?.root ?? lookupRoot,
      };
      const keepVolumes = input.keepVolumes === true;
      const scratchProviderId = String(plan?.provider ?? "lando");
      const payload = {
        scope: "scratch" as const,
        app,
        reason,
        ...(plan === undefined ? {} : { plan }),
        ...(entry === undefined
          ? {}
          : { source: entry.source, isolate: entry.isolate, detached: entry.detached }),
        ...(entry?.shareGlobalStorage === undefined ? {} : { shareGlobalStorage: entry.shareGlobalStorage }),
        retainedArtifacts: {
          volumes: keepVolumes,
          snapshots: keepVolumes
            ? ("kept" as const)
            : plan === undefined
              ? ("unknown-owner" as const)
              : ("none" as const),
        },
      };
      const provider = plan === undefined ? undefined : yield* providers.select(plan);
      const orphan = plan === undefined ? yield* scanner.prepareScratch(input.id, keepVolumes) : undefined;
      const evidence =
        plan !== undefined && entry?.status !== "acquiring"
          ? ("applied" as const)
          : inventoryOnly
            ? ("inventory" as const)
            : ("orphans" as const);
      yield* events.publish(PreScratchDestroyEvent.make({ ...payload, timestamp: DateTime.nowUnsafe() }));
      yield* Effect.gen(function* () {
        yield* events.publish(PreStopEvent.make({ scope: "app", app, timestamp: DateTime.nowUnsafe() }));
        const stopped =
          provider !== undefined && plan !== undefined
            ? (yield* provider.bringDown(
                { app: plan.id, plan },
                { containers: "remove", volumes: false, removeState: false },
              )).kind === "removed"
            : yield* orphan?.stop ?? Effect.succeed(false);
        yield* events.publish(PostStopEvent.make({ scope: "app", app, timestamp: DateTime.nowUnsafe() }));
        yield* events.publish(PreDestroyEvent.make({ app, evidence, timestamp: DateTime.nowUnsafe() }));
        const destroy = Effect.gen(function* () {
          const snapshots =
            keepVolumes || plan === undefined
              ? []
              : yield* scratchOwnedSnapshots(plan).pipe(Effect.provideService(DataMover, mover));
          const removed = yield* removeSnapshots(snapshots).pipe(Effect.provideService(DataMover, mover));
          const destroyed =
            provider !== undefined && plan !== undefined
              ? (yield* provider.bringDown(
                  { app: plan.id, plan },
                  { containers: "remove", volumes: !keepVolumes, removeState: false },
                )).kind === "removed"
              : yield* orphan?.destroy ?? Effect.succeed(false);
          // Without a plan, the registry layout says which owner published; with neither, try both.
          const managedOwner = routeOwnerFromRoot(input.id, managedRoot);
          const routeOwners =
            plan !== undefined
              ? [routeOwnerFromPlan(plan)]
              : entry?.layout === "legacy"
                ? [routeOwnerFromScratch(input.id)]
                : entry?.layout === "managed"
                  ? [managedOwner]
                  : [routeOwnerFromScratch(input.id), managedOwner];
          for (const routeOwner of routeOwners) {
            yield* withdrawOwnerRoutes(routeOwner).pipe(
              Effect.provideService(EventService, events),
              Effect.provideService(RouterService, router),
            );
            yield* removeServiceCertificates(routeOwner.ownerKey).pipe(
              Effect.provideService(EventService, events),
              Option.isSome(paths) ? Effect.provideService(PathsService, paths.value) : (effect) => effect,
            );
          }
          if (plan !== undefined && provider !== undefined) {
            yield* cleanupScratchOwnedState({ plan, provider, keepVolumes }).pipe(
              Effect.provideService(RuntimeProviderRegistry, providers),
              Effect.provideService(StateStore, stateStore),
            );
            // Last: a retry after any failure above recovers the plan from this receipt.
            yield* provider.bringDown(
              { app: plan.id, plan },
              { containers: "remove", volumes: false, removeState: true },
            );
          } else
            yield* cleanupScratchInventory({ id: input.id, ownership, keepVolumes }).pipe(
              Effect.provideService(RuntimeProviderRegistry, providers),
              Effect.provideService(StateStore, stateStore),
            );
          return stopped || destroyed || removed > 0 ? ("destroyed" as const) : ("unchanged" as const);
        });
        const outcome = yield* reason === "gc"
          ? destroy
          : withDestroyProgress({
              events,
              plan: { id: app.id, name: app.id },
              children: { fileSync: false, snapshots: false, proxy: false, provider: true, hostProxy: false },
              work: Effect.fnUntraced(function* (tree) {
                yield* tree.startTask("provider");
                const outcome = yield* destroy.pipe(Effect.tapError(() => tree.failTask("provider")));
                yield* tree.completeTask("provider");
                return outcome;
              }),
            });
        // teardown succeeded: the destroyed container's build output is stale.
        const buildOwner = BuildOwner.scratch(AppId.make(input.id));
        yield* (
          Option.isSome(paths)
            ? removeAppBuildOutput(buildOwner, scratchProviderId, undefined, {
                images: "release",
              }).pipe(
                Effect.provideService(PathsService, paths.value),
                Effect.provideService(StateStore, stateStore),
                Effect.provideService(RuntimeProviderRegistry, providers),
              )
            : clearAppBuildResults(stateStore, buildOwner)
        ).pipe(
          Effect.catch((failure) =>
            warnBuildOutputCleanupFailure({ providerId: scratchProviderId, message: failure.message }),
          ),
        );
        yield* events.publish(
          PostDestroyEvent.make({ app, evidence, outcome, timestamp: DateTime.nowUnsafe() }),
        );
        yield* Effect.tryPromise({
          try: () => rm(input.instanceRoot, { recursive: true, force: true }),
          catch: (cause) =>
            new ScratchAppError({
              operation: "cleanup",
              message: `Unable to remove scratch root ${input.instanceRoot}.`,
              cause,
              remediation: `Remove ${input.instanceRoot} manually or fix directory permissions, then retry destroy.`,
            }),
        });
        yield* registry.remove(input.id);
      }).pipe(
        Effect.onError(() =>
          entry === undefined
            ? Effect.void
            : registry
                .upsert("mark-pending-cleanup", {
                  ...entry,
                  updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                })
                .pipe(Effect.exit, Effect.asVoid),
        ),
      );
      // Outside the guard: once the entry is removed, a failed post-event must not bring it back.
      yield* events.publish(PostScratchDestroyEvent.make({ ...payload, timestamp: DateTime.nowUnsafe() }));
    },
    mapFailures((cause) =>
      cause instanceof ScratchAppError
        ? cause
        : new ScratchAppError({
            operation: "destroy",
            message: "Unable to destroy scratch resources.",
            cause,
            remediation:
              causeRemediation(cause) ??
              "Repair the failed provider, snapshot, or route operation and retry scratch destroy.",
          }),
    ),
  );
});
