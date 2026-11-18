import type { StopAppResult } from "@lando/sdk/app";
import { FileSyncStopError } from "@lando/sdk/errors";
import { type AbsolutePath, AppId, type AppRef, type ServiceShutdownObservation } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { routeOwnerFromPlan, routeOwnerFromRoot } from "../lifecycle/route-owner.ts";
import { withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { shellArg } from "../services/shell-quote.ts";
import { readDiscardableStart } from "./accelerated-start-disposal.ts";
import type { TeardownResolution } from "./applied-state-target.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { prepareMissingRootStartDisposal } from "./missing-root-start-disposal.ts";
import { tearDownOrphans } from "./orphan-teardown.ts";
import { prepareOwnedResourceCleanup, tearDownOwnedResources } from "./owned-resource-teardown.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

export const stopOrphans = (resolution: Extract<TeardownResolution, { readonly kind: "orphans" }>) =>
  tearDownOrphans({
    root: resolution.root,
    groups: resolution.groups,
    options: { volumes: false, purgeCaches: false },
  }).pipe(
    Effect.map((removed): StopAppResult => {
      const base: StopAppResult = {
        app: removed.app,
        outcome: removed.services.length === 0 && !removed.ownedChanged ? "unchanged" : "stopped",
        servicesStopped: removed.services,
      };
      return withShutdownObservations(base, removed.shutdownObservations);
    }),
  );

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
  const services: string[] = [];
  let shutdownObservations: readonly ServiceShutdownObservation[] | undefined;
  switch (resolution.kind) {
    case "applied": {
      const target = resolution.target;
      const provider = yield* registry.select(target.plan);
      if ((yield* provider.getStatus).state !== "idle") {
        const outcome = yield* provider.destroy(
          { app: target.plan.id, plan: target.plan },
          { volumes: false, removeState: false },
        );
        shutdownObservations = outcome.shutdownObservations;
        if (outcome.kind === "destroyed")
          services.push(
            ...Object.values(target.plan.services)
              .reverse()
              .map((service) => String(service.name)),
          );
      }
      const cleanup = yield* prepareOwnedResourceCleanup(
        app.root,
        { volumes: false, purgeCaches: false },
        "stop",
      );
      services.push(...(yield* cleanup).servicesRemoved);
      break;
    }
    case "orphans": {
      const removed = yield* stopOrphans(resolution);
      services.push(...removed.servicesStopped);
      shutdownObservations = removed.shutdownObservations;
      break;
    }
    case "owned": {
      const removed = yield* tearDownOwnedResources(app.root, { volumes: false, purgeCaches: false }, "stop");
      services.push(...removed.servicesRemoved);
      break;
    }
    case "absent":
      break;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
  yield* cleanupAppWorkers(app);
  yield* withdrawOwnerRoutes(
    resolution.kind === "applied"
      ? routeOwnerFromPlan(resolution.target.plan)
      : routeOwnerFromRoot(String(app.id), app.root),
  );
  return withShutdownObservations(
    {
      app: resolution.kind === "applied" ? resolution.target.plan.name : String(app.id),
      outcome: "stopped",
      servicesStopped: [...new Set(services)],
    } satisfies StopAppResult,
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
