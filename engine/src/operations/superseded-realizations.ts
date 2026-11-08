import { AppResolveError, FileSyncStartError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { type AppPlan, planDataId } from "@lando/sdk/schema";
import { EventService, FileSyncEngine, ManagedFileTransactionGuard, StateStore } from "@lando/sdk/services";
import { quoteYamlScalar } from "@lando/sdk/yaml";
import { DateTime, Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";
import { readJournal } from "./accelerated-start-journal.ts";
import { prepareDestroyFileSync } from "./destroy-file-sync.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import {
  acquireFileSyncEngine,
  requireFileSyncProvider,
  validateDesiredFileSyncEngine,
} from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";

/** Runs under the root mutation lock, before acquiring any desired-plan volume locks. */
export const retireSupersededRealizations = Effect.fn("AppOperation.retireSupersededRealizations")(function* (
  target: ResolvedAppTarget,
  superseded: readonly AppPlan[],
  execution: {
    readonly provider: PreparedRuntimeProvider;
    readonly selectedServices?: boolean;
    readonly volumes?: boolean;
    readonly purgeCaches?: boolean;
  },
) {
  if (superseded.length === 0) return false;
  if (execution.selectedServices === true)
    return yield* Effect.fail(
      new AppResolveError({
        reason: "mismatch",
        detail: "applied-state",
        message: `App folder ${target.root} has an earlier name: ${superseded.map((plan) => plan.name).join(", ")}. Selected services cannot reconcile a rename.`,
        remediation: "Run `lando start` or whole-app `lando rebuild` first.",
      }),
    );
  // Read the root-keyed record without validating it against the desired name's plan.
  const { pending, path } = yield* readJournal(target.app);
  if (pending !== null && pending.phase !== "completed") {
    const recorded = superseded.find((plan) => plan.id === pending.appId);
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: pending.engineId,
        message: `App ${pending.appId} has an unfinished accelerated start in ${pending.appRoot}; rename cannot retire its realization.`,
        remediation: `${recorded === undefined ? `Restore the original authored name of app id ${pending.appId}` : `Restore name: ${quoteYamlScalar(recorded.name)}`} and its recorded provider and mount settings, then run \`lando start\` in ${pending.appRoot} to finish the recorded app before renaming. Journal: \`${path}\`.`,
        cause: {
          appId: pending.appId,
          appRoot: pending.appRoot,
          ...(recorded === undefined ? {} : { appName: recorded.name }),
        },
      }),
    );
  }
  const { provider } = execution;
  yield* validateDesiredFileSyncEngine(target.plan);
  yield* requireFileSyncProvider(yield* fileSyncBundle(target.plan), provider);
  const stateStore = yield* StateStore;
  const events = yield* EventService;
  const prepared = yield* Effect.forEach(
    superseded,
    Effect.fnUntraced(function* (old) {
      const app = { kind: "user" as const, id: old.id, root: old.root };
      const inspected =
        provider.inspectAppliedFileSync === undefined
          ? undefined
          : yield* provider.inspectAppliedFileSync(old);
      const prepare = prepareDestroyFileSync({ app, root: old.root, plan: old }, provider);
      const disposal =
        inspected?.status === "accelerated"
          ? yield* prepare.pipe(
              Effect.provideService(FileSyncEngine, yield* acquireFileSyncEngine(inspected.engineId)),
            )
          : yield* prepare;
      return { old, app, disposal };
    }),
  );
  const guard = yield* ManagedFileTransactionGuard;
  yield* guard.ensureConsistent(String(target.root));
  for (const { old, app, disposal } of prepared) {
    const context = yield* Effect.context<
      Effect.Services<typeof disposal.dispose> | Effect.Services<ReturnType<typeof cleanupAppWorkers>>
    >();
    yield* withLaunchVolumeCoordination({
      plan: old,
      provider,
      stateStore,
      body: () =>
        Effect.gen(function* () {
          yield* disposal.quiesceRetained;
          yield* disposal.dispose;
          yield* cleanupAppWorkers(app);
          yield* provider.destroy(
            { app: old.id, plan: old },
            {
              volumes: execution.volumes === true,
              purgeCaches: execution.purgeCaches === true,
              removeState: true,
            },
          );
          yield* disposal.complete;
          const carriesData = planDataId(old) === planDataId(target.plan);
          const retained = carriesData
            ? []
            : old.stores
                .filter((store) => store.kind === "data" && store.scope !== "global")
                .map((store) => store.name);
          yield* events.publish(
            MessageWarnEvent.make({
              body: carriesData
                ? `${old.name} is now ${target.plan.name}: removed the containers and networks of ${old.name}. Its data carries over to ${target.plan.name}.`
                : `${old.name} is now ${target.plan.name}: removed the containers and networks of ${old.name} and kept its named volumes: ${retained.length === 0 ? "none" : retained.join(", ")}.`,
              timestamp: DateTime.nowUnsafe(),
            }),
          );
        }).pipe(Effect.provide(context)),
    });
  }
  return true;
});
