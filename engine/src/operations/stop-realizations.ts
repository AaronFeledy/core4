import type { StopAppResult } from "@lando/sdk/app";
import { orDieWithRole } from "@lando/sdk/command-result";
import { MessageInfoEvent } from "@lando/sdk/events";
import type {
  AbsolutePath,
  AppPlan,
  ContainerBringDownReceipt,
  ServiceShutdownObservation,
} from "@lando/sdk/schema";
import {
  type AppliedOrphanGroup,
  EventService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";

import { appLockTarget, withAppMutationLock } from "./app-mutation-lock.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { isProtectedAppliedState, orphanSelectionPlan } from "./orphan-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";
import { mergeContainerReceipts, servicesTakenDown, withContainerReceipts } from "./stop-receipts.ts";

/** What stopping the realizations an earlier app name left at this root did. */
export type StoppedRealizations = {
  readonly servicesStopped: readonly string[];
  readonly containers?: readonly ContainerBringDownReceipt[];
  readonly shutdownObservations?: readonly ServiceShutdownObservation[];
};

/**
 * Stops the containers of earlier-named realizations at the same root and keeps them. Retiring
 * them (removal, file-sync disposal, applied-state deletion) belongs to the next start or destroy.
 */
export const stopSupersededRealizations = Effect.fn("AppOperation.stopSupersededRealizations")(function* (
  superseded: readonly AppPlan[],
  provider: Pick<RuntimeProviderShape, "bringDown">,
) {
  const events = yield* EventService;
  const receipts: Array<readonly ContainerBringDownReceipt[] | undefined> = [];
  const observations: Array<readonly ServiceShutdownObservation[] | undefined> = [];
  for (const old of superseded) {
    const outcome = yield* provider.bringDown({ app: old.id, plan: old }, { containers: "stop" });
    observations.push(outcome.shutdownObservations);
    const containers = outcome.kind === "no-op" ? undefined : outcome.containers;
    receipts.push(containers);
    yield* cleanupAppWorkers({ id: old.id, root: old.root }, "stop");
    if (servicesTakenDown(containers).length > 0)
      yield* events.publish(
        MessageInfoEvent.make({
          body: `Stopped ${old.name}, an earlier name of this app. Its containers stay until the next \`lando start\` or \`lando destroy\`.`,
          timestamp: DateTime.nowUnsafe(),
        }),
      );
  }
  const containers = mergeContainerReceipts(...receipts);
  return withShutdownObservations(
    withContainerReceipts({ servicesStopped: servicesTakenDown(containers) }, containers),
    ...observations,
  ) satisfies StoppedRealizations;
});

/**
 * Stops the containers recorded against an app root that no applied plan accounts for, by the
 * identity the provider observed. Nothing is removed; app workers retire once their app stopped.
 */
export const stopOrphans = Effect.fn("AppOperation.stopOrphans")(function* (input: {
  readonly root: AbsolutePath;
  readonly groups: ReadonlyArray<AppliedOrphanGroup>;
}) {
  return yield* withAppMutationLock(
    { id: input.groups[0]?.appId ?? input.root, root: input.root },
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const receipts: ContainerBringDownReceipt[] = [];
      const observationSources: Array<readonly ServiceShutdownObservation[] | undefined> = [];
      for (const group of input.groups) {
        const plan = orphanSelectionPlan(group, input.root);
        yield* withAppMutationLock(
          appLockTarget(plan),
          Effect.gen(function* () {
            const provider = yield* registry.select(plan);
            for (const service of group.services) {
              const { shutdownObservations, ...receipt } = yield* provider.bringDownObserved(service, "stop");
              observationSources.push(shutdownObservations);
              receipts.push(receipt);
            }
            yield* cleanupAppWorkers({ id: group.appId, root: input.root }, "stop");
          }),
        ).pipe(
          Effect.catchIf(isProtectedAppliedState, (error) =>
            Effect.gen(function* () {
              const events = yield* Effect.serviceOption(EventService);
              if (Option.isSome(events))
                yield* events.value
                  .publish({
                    _tag: "message.warn",
                    body: `Skipped resources for app ${group.appId}: ${error.message} ${error.remediation}`,
                    timestamp: DateTime.nowUnsafe(),
                  })
                  .pipe(orDieWithRole("cleanup"));
            }),
          ),
        );
      }
      const servicesStopped = servicesTakenDown(receipts);
      return withShutdownObservations(
        withContainerReceipts(
          {
            app: String(input.groups[0]?.appId ?? ""),
            outcome: servicesStopped.length === 0 ? "unchanged" : "stopped",
            servicesStopped,
          } satisfies StopAppResult,
          receipts,
        ),
        ...observationSources,
      );
    }),
  );
});
