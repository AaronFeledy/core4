import { rm } from "node:fs/promises";
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
import { DataMover, EventService, RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { withDestroyProgress } from "../operations/destroy-progress.ts";
import { removeSnapshots, scratchOwnedSnapshots } from "../operations/destroy-snapshots.ts";
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
      const payload = {
        scope: "scratch" as const,
        app,
        reason,
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
      yield* events.publish(PreScratchDestroyEvent.make({ ...payload, timestamp: DateTime.nowUnsafe() }));
      yield* events.publish(PreStopEvent.make({ scope: "app", app, timestamp: DateTime.nowUnsafe() }));
      const stopped =
        provider !== undefined && plan !== undefined
          ? (yield* provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: false })).kind ===
            "destroyed"
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
            ? (yield* provider.destroy({ app: plan.id, plan }, { volumes: !keepVolumes, removeState: true }))
                .kind === "destroyed"
            : yield* orphan?.destroy ?? Effect.succeed(false);
        if (Option.isSome(router)) yield* router.value.removeRoutes(AppId.make(app.id));
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
          }),
      });
      yield* registry.remove(input.id);
      yield* events.publish(PostScratchDestroyEvent.make({ ...payload, timestamp: DateTime.nowUnsafe() }));
    },
    Effect.mapError((cause) =>
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
