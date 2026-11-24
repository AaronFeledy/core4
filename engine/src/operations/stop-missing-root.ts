import type { StopAppResult } from "@lando/sdk/app";
import { FileSyncStopError } from "@lando/sdk/errors";
import {
  type AbsolutePath,
  AppId,
  type AppRef,
  type ContainerBringDownReceipt,
  type ServiceShutdownObservation,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { routeOwnerFromPlan, routeOwnerFromRoot } from "../lifecycle/route-owner.ts";
import { withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { shellArg } from "../services/shell-quote.ts";
import { readDiscardableStart } from "./accelerated-start-disposal.ts";
import type { TeardownResolution } from "./applied-state-target.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { prepareMissingRootStartDisposal } from "./missing-root-start-disposal.ts";
import { mergeShutdownObservations, withShutdownObservations } from "./shutdown-observations.ts";
import { stopOrphans } from "./stop-realizations.ts";
import { mergeContainerReceipts, servicesTakenDown, withContainerReceipts } from "./stop-receipts.ts";
import { stopUnplannedContainers } from "./stop-unplanned.ts";

const journalRef = (root: AbsolutePath, id: string): AppRef => ({
  kind: "user",
  id: AppId.make(id),
  root,
});

export const journalPending = Effect.fnUntraced(function* (root: AbsolutePath, id: string) {
  const { pending } = yield* readDiscardableStart(journalRef(root, id));
  return pending === null || pending.phase === "completed" ? undefined : pending;
});

/**
 * The journal preflight already proved the attempt identity, so stopping these writers needs
 * neither desired config nor live file-sync preflight.
 */
const stopMissingRootWriters = Effect.fnUntraced(function* (app: AppRef, resolution: TeardownResolution) {
  const registry = yield* RuntimeProviderRegistry;
  let containers: readonly ContainerBringDownReceipt[] | undefined;
  let shutdownObservations: readonly ServiceShutdownObservation[] | undefined;
  switch (resolution.kind) {
    case "applied": {
      const target = resolution.target;
      const provider = yield* registry.select(target.plan);
      if ((yield* provider.getStatus).state !== "idle") {
        const outcome = yield* provider.bringDown(
          { app: target.plan.id, plan: target.plan },
          { containers: "stop" },
        );
        const unplanned = yield* stopUnplannedContainers(target.plan, provider);
        shutdownObservations = mergeShutdownObservations(
          outcome.shutdownObservations,
          unplanned.shutdownObservations,
        );
        containers = mergeContainerReceipts(
          outcome.kind === "no-op" ? undefined : outcome.containers,
          unplanned.containers,
        );
      }
      break;
    }
    case "orphans": {
      const stopped = yield* stopOrphans(resolution);
      containers = stopped.containers;
      shutdownObservations = stopped.shutdownObservations;
      break;
    }
    // An ownership inventory with no observed container has nothing left to stop.
    case "owned":
    case "absent":
      break;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
  yield* cleanupAppWorkers(app, "stop");
  yield* withdrawOwnerRoutes(
    resolution.kind === "applied"
      ? routeOwnerFromPlan(resolution.target.plan)
      : routeOwnerFromRoot(String(app.id), app.root),
  );
  return withShutdownObservations(
    withContainerReceipts(
      {
        app: resolution.kind === "applied" ? resolution.target.plan.name : String(app.id),
        outcome: "stopped",
        servicesStopped: servicesTakenDown(containers),
      } satisfies StopAppResult,
      containers,
    ),
    shutdownObservations,
  );
});

export const stopMissingRootStart = Effect.fnUntraced(function* (
  { root, retryCommand }: { readonly root: AbsolutePath; readonly retryCommand: string },
  pending: NonNullable<Effect.Success<ReturnType<typeof journalPending>>>,
  resolution: TeardownResolution,
) {
  if (resolution.kind === "applied") {
    const expected = resolution.target;
    if (expected.app.id !== pending.appId || expected.plan.provider !== pending.providerId) {
      return yield* Effect.fail(
        new FileSyncStopError({
          engineId: pending.engineId,
          sessionRef: pending.appId,
          message: "The applied app or provider differs from the pending file-sync journal.",
          remediation: `Restore the app folder or run \`lando destroy --root ${shellArg(root)}\`.`,
        }),
      );
    }
  }
  const app = journalRef(root, pending.appId);
  const disposal = yield* prepareMissingRootStartDisposal(app, pending, { volumes: false, retryCommand });
  const result = yield* stopMissingRootWriters(app, resolution);
  // Writers are gone; termination never flushes and the journal stays for the next start.
  yield* disposal.terminate;
  return result;
});
