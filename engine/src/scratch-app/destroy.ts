import { rm } from "node:fs/promises";
import { mapFailures } from "@lando/sdk/command-result";
import { ScratchAppError } from "@lando/sdk/errors";
import {
  PostDestroyEvent,
  PostScratchDestroyEvent,
  PostStopEvent,
  PreDestroyEvent,
  PreScratchDestroyEvent,
  PreStopEvent,
} from "@lando/sdk/events";
import { AbsolutePath, type AppPlan } from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { routeOwnerFromScratch } from "../lifecycle/route-owner.ts";
import { withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { removeServiceCertificates } from "../lifecycle/service-certificate-paths.ts";
import { withDestroyProgress } from "../operations/destroy-progress.ts";
import { removeSnapshots, scratchOwnedSnapshots } from "../operations/destroy-snapshots.ts";
import { clearAppBuildResults } from "../services/build-results.ts";
import {
  removeBuildTranscripts,
  warnBuildOutputCleanupFailure,
} from "../services/build-transcript-cleanup.ts";
import { ScratchRegistry } from "./registry.ts";
import { ScratchResourceScanner } from "./scanner.ts";

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
  const router = yield* Effect.serviceOption(RouterService);
  const paths = yield* Effect.serviceOption(PathsService);
  const stateStore = yield* StateStore;
  return Effect.fn("ScratchApp.reap")(
    function* (input: ScratchReapInput) {
      const entry = yield* registry.get(input.id);
      const plan = input.plan;
      const reason = input.reason ?? "acquire-failure";
      if (reason === "acquire-failure" && entry === undefined) return;
      if (plan !== undefined && plan.id !== input.id)
        return yield* Effect.fail(
          new ScratchAppError({
            operation: "destroy",
            message: "Cached scratch plan belongs to a different app.",
            remediation: "Repair the scratch plan cache before retrying destroy.",
          }),
        );
      const app = {
        kind: "scratch" as const,
        id: input.id,
        root: plan?.root ?? AbsolutePath.make(entry?.rootPath ?? input.instanceRoot),
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
        plan === undefined || entry?.status === "acquiring" ? ("orphans" as const) : ("applied" as const);
      // Forget app-step results before the first provider call: a teardown that fails halfway has
      // already removed containers. The transcripts are removed only after teardown succeeds.
      yield* clearAppBuildResults(stateStore, input.id).pipe(
        Effect.catch((failure) =>
          warnBuildOutputCleanupFailure({ providerId: scratchProviderId, message: failure.message }),
        ),
      );
      yield* events.publish(PreScratchDestroyEvent.make({ ...payload, timestamp: DateTime.nowUnsafe() }));
      yield* Effect.gen(function* () {
        yield* events.publish(PreStopEvent.make({ scope: "app", app, timestamp: DateTime.nowUnsafe() }));
        const stopped =
          provider !== undefined && plan !== undefined
            ? (yield* provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: false }))
                .kind === "destroyed"
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
              ? (yield* provider.destroy(
                  { app: plan.id, plan },
                  { volumes: !keepVolumes, removeState: true },
                )).kind === "destroyed"
              : yield* orphan?.destroy ?? Effect.succeed(false);
          yield* withdrawOwnerRoutes(routeOwnerFromScratch(input.id)).pipe(
            Effect.provideService(EventService, events),
            Option.isSome(router) ? Effect.provideService(RouterService, router.value) : (effect) => effect,
          );
          yield* removeServiceCertificates(routeOwnerFromScratch(input.id).ownerKey).pipe(
            Effect.provideService(EventService, events),
            Option.isSome(paths) ? Effect.provideService(PathsService, paths.value) : (effect) => effect,
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
        if (Option.isSome(paths)) {
          yield* removeBuildTranscripts({
            providerId: scratchProviderId,
            userDataRoot: paths.value.roots.userDataRoot,
            appId: input.id,
            scratch: true,
          });
        }
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
              "Repair the failed provider, snapshot, or route operation and retry scratch destroy.",
          }),
    ),
  );
});
