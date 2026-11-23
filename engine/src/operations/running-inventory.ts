import { SCRATCH_LABEL } from "@lando/container-runtime/labels";
import { adoptionReceiptsFromSummary } from "@lando/container-runtime/native-ownership";
import { AppResolveError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, LANDO_DATA_ROOT_LABEL, ProviderId } from "@lando/sdk/schema";
import {
  GlobalAppService,
  type ProviderRuntimeSnapshot,
  RuntimeProviderRegistry,
  ScratchAppService,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { globalObserveProviderId } from "../global-app/placement.ts";
import { TeardownProvider } from "../providers/app-placement.ts";
import { matchesAppPlanIdentity } from "../providers/app-plan-identity.ts";
import { readAcceleratedStartInventory } from "./accelerated-start-inventory.ts";
import { digest } from "./accelerated-start-record.ts";
import { appRootIdentityKey } from "./app-root-identity.ts";
import { appliedStateIssueError } from "./applied-state-issue.ts";
import { currentDataRoot, scopeRuntimeSnapshot } from "./data-root-scope.ts";
import { providerInventoryFailure, unobservedRuntimeError } from "./poweroff-failures.ts";

type InventoryFailure = {
  readonly kind: "user" | "scratch";
  readonly appId: string;
  readonly appRoot: string;
  readonly providerId: string;
  readonly error: unknown;
};
type UserTarget = {
  readonly providerId: ProviderId;
  readonly appRoot: AbsolutePath;
  readonly appId: AppId;
};
type ScratchTarget = {
  readonly id: string;
  readonly appRoot: AbsolutePath;
  readonly providerId: ProviderId;
};
type JournalRecord = Effect.Success<ReturnType<typeof readAcceleratedStartInventory>>["records"][number];

const QUIESCENT_SERVICE_STATUSES: ReadonlySet<ServiceRuntimeInfo["status"]> = new Set([
  "absent",
  "exited",
  "dead",
]);

const readProviderSnapshots = Effect.fnUntraced(function* (journalProviders: ReadonlySet<string>) {
  const registry = yield* RuntimeProviderRegistry;
  const failures: InventoryFailure[] = [];
  const snapshots: ProviderRuntimeSnapshot[] = [];
  const idsResult = yield* registry.list.pipe(Effect.result);
  const ids = Result.isSuccess(idsResult) ? idsResult.success : [];
  if (Result.isFailure(idsResult)) failures.push(providerInventoryFailure("providers", idsResult.failure));

  for (const id of ids) {
    const state = yield* registry.appliedStateInventory(id).pipe(Effect.result);
    if (Result.isFailure(state)) failures.push(providerInventoryFailure(String(id), state.failure));
    else
      for (const issue of state.success.unreadable)
        failures.push(
          providerInventoryFailure(String(id), appliedStateIssueError(id, issue, "lando poweroff")),
        );
    const ownership =
      registry.hasRecordedOwnership === undefined
        ? undefined
        : yield* registry.hasRecordedOwnership(id).pipe(Effect.result);
    if (ownership !== undefined && Result.isFailure(ownership))
      failures.push(providerInventoryFailure(String(id), ownership.failure));
    const hasRecordedHoldings =
      journalProviders.has(String(id)) ||
      Result.isFailure(state) ||
      state.success.plans.length > 0 ||
      state.success.unreadable.length > 0 ||
      (ownership !== undefined && (Result.isFailure(ownership) || ownership.success));

    // Scope each observation so a broken provider cannot hide another provider's workloads.
    const observed = yield* (registry.observeRuntime ?? Effect.succeed([])).pipe(
      Effect.provideService(TeardownProvider, id),
      Effect.result,
    );
    if (Result.isFailure(observed) && hasRecordedHoldings) {
      failures.push(providerInventoryFailure(String(id), observed.failure));
      continue;
    }
    if (Result.isSuccess(observed)) {
      const providerSnapshots = observed.success.filter((snapshot) => snapshot.providerId === id);
      snapshots.push(...providerSnapshots);
      if (providerSnapshots.some((snapshot) => snapshot.runtimeObserved)) continue;
    }
    const status = yield* registry.select(id).pipe(
      Effect.flatMap((provider) => provider.getStatus),
      Effect.result,
    );
    if (Result.isFailure(status)) {
      if (hasRecordedHoldings) failures.push(providerInventoryFailure(String(id), status.failure));
      continue;
    }
    if (status.success.state === "idle") continue;
    if (Result.isFailure(observed)) failures.push(providerInventoryFailure(String(id), observed.failure));
    else if (hasRecordedHoldings)
      failures.push(providerInventoryFailure(String(id), unobservedRuntimeError(id)));
  }

  return { snapshots, failures };
});

const userTargetKey = (providerId: ProviderId, appRoot: AbsolutePath): string =>
  `${String(providerId)}\0${appRoot}`;

export const deriveRunningTargets = (
  snapshots: readonly ProviderRuntimeSnapshot[],
  journalRecords: readonly JournalRecord[],
) => {
  const failures: InventoryFailure[] = [];
  const userTargets = new Map<string, UserTarget>();
  const scratchObserved = new Map<string, ScratchTarget>();
  for (const snapshot of snapshots) {
    for (const service of snapshot.services) {
      if (service.app === "global") continue;
      if (QUIESCENT_SERVICE_STATUSES.has(service.status)) continue;
      if (service.labels?.[SCRATCH_LABEL] === "TRUE") {
        scratchObserved.set(String(service.app), {
          id: String(service.app),
          appRoot: service.appRoot ?? AbsolutePath.make(""),
          providerId: service.providerId,
        });
        continue;
      }
      if (service.appRoot === undefined) {
        failures.push({
          kind: "user",
          appId: String(service.app),
          appRoot: "",
          providerId: String(service.providerId),
          error: new AppResolveError({
            reason: "missing-root",
            detail: "container-root",
            message: `The container for ${service.app}/${service.service} has no proven app root.`,
            remediation:
              "Restore the container's app-root label or remove it through its owning provider, then retry `lando poweroff`.",
          }),
        });
        continue;
      }
      const key = userTargetKey(service.providerId, service.appRoot);
      if (!userTargets.has(key))
        userTargets.set(key, {
          providerId: service.providerId,
          appRoot: service.appRoot,
          appId: service.app,
        });
    }
  }

  for (const journal of journalRecords) {
    if (journal.appId === "global") continue;
    const ref = {
      kind: "user" as const,
      id: AppId.make(journal.appId),
      root: AbsolutePath.make(journal.appRoot),
    };
    // The filename binds app kind and root; scratch journals never contribute a user target.
    if (!journal.path.endsWith(`${digest(appRootIdentityKey(ref, journal.appRoot))}.json`)) continue;
    const providerId = ProviderId.make(journal.providerId);
    const key = userTargetKey(providerId, ref.root);
    if (!userTargets.has(key)) userTargets.set(key, { providerId, appRoot: ref.root, appId: ref.id });
  }
  return { userTargets, scratchObserved, failures };
};

const readScratchTargets = Effect.fnUntraced(function* (scratchObserved: ReadonlyMap<string, ScratchTarget>) {
  const scratches = yield* ScratchAppService;
  const scratchList = yield* scratches.list().pipe(Effect.result);
  const scratchTargets = new Map(scratchObserved);
  const failures: InventoryFailure[] = [];
  if (Result.isSuccess(scratchList)) {
    for (const summary of scratchList.success) {
      if (!scratchTargets.has(summary.id))
        scratchTargets.set(summary.id, {
          id: summary.id,
          appRoot: summary.app.root,
          providerId: ProviderId.make("lando"),
        });
    }
  } else {
    failures.push({
      kind: "scratch",
      appId: "scratch",
      appRoot: "",
      providerId: "lando",
      error: scratchList.failure,
    });
  }
  return { scratchTargets, failures };
});

const resolveGlobalStopTarget = Effect.fnUntraced(function* (snapshots: readonly ProviderRuntimeSnapshot[]) {
  const providerId = yield* globalObserveProviderId;
  const selected = snapshots.filter((snapshot) => snapshot.providerId === providerId);
  const observedRoots = selected.flatMap(({ services }) =>
    services.flatMap((service) =>
      service.app === "global" &&
      service.providerId === providerId &&
      service.labels?.[SCRATCH_LABEL] !== "TRUE" &&
      service.appRoot !== undefined
        ? [service.appRoot]
        : [],
    ),
  );
  const roots = [
    ...new Set(
      observedRoots.length > 0
        ? observedRoots
        : selected.flatMap(({ appliedPlans }) =>
            appliedPlans.flatMap((plan) =>
              plan.id === "global" &&
              plan.provider === providerId &&
              matchesAppPlanIdentity(plan, { kind: "global", id: "global" })
                ? [plan.root]
                : [],
            ),
          ),
    ),
  ].sort();
  if (roots.length > 1) {
    return yield* new AppResolveError({
      reason: "ambiguous",
      detail: "provider-resources",
      message: `The global app on ${providerId} has multiple discovered roots: ${roots.join(", ")}.`,
      remediation: "Resolve the conflicting global app roots on the provider, then retry `lando poweroff`.",
    });
  }
  const root = roots[0];
  if (root !== undefined) return { root, providerId };
  const app = yield* GlobalAppService;
  return { root: (yield* app.paths).root, providerId };
});

export const readRunningInventory = Effect.fnUntraced(function* () {
  const journalRead = yield* readAcceleratedStartInventory(false).pipe(Effect.result);
  const journalRecords = Result.isSuccess(journalRead) ? journalRead.success.records : [];
  const inventory = yield* readProviderSnapshots(
    new Set(journalRecords.map((journal) => journal.providerId)),
  );
  const failures = [...inventory.failures];
  if (Result.isFailure(journalRead)) failures.push(providerInventoryFailure("journals", journalRead.failure));
  else {
    for (const unreadable of journalRead.success.unreadable)
      failures.push({
        kind: "user",
        appId: unreadable.path,
        appRoot: "",
        providerId: "journals",
        error: new ProviderUnavailableError({
          providerId: "journals",
          operation: "accelerated-start-journal",
          message: `The accelerated-start journal ${unreadable.path} could not be read (${unreadable._tag}): ${unreadable.message}`,
          remediation: unreadable.remediation,
        }),
      });
  }
  const scope = yield* Effect.result(currentDataRoot);
  if (Result.isFailure(scope)) failures.push(providerInventoryFailure("data-root", scope.failure));
  const registry = yield* RuntimeProviderRegistry;
  const ownershipFailures = new Set<ProviderId>();
  const snapshots = Result.isSuccess(scope)
    ? yield* Effect.forEach(inventory.snapshots, (snapshot) =>
        Effect.gen(function* () {
          const roots = new Set(
            snapshot.services.flatMap((service) =>
              service.appRoot !== undefined && service.labels?.[LANDO_DATA_ROOT_LABEL] === undefined
                ? [service.appRoot]
                : [],
            ),
          );
          const summaries = yield* Effect.forEach(roots, (root) =>
            (registry.resourceOwnership?.(snapshot.providerId, root) ?? Effect.succeed(undefined)).pipe(
              Effect.catch((error) => {
                if (!ownershipFailures.has(snapshot.providerId)) {
                  ownershipFailures.add(snapshot.providerId);
                  failures.push(providerInventoryFailure(snapshot.providerId, error));
                }
                return Effect.succeed(undefined);
              }),
            ),
          );
          return scopeRuntimeSnapshot(
            snapshot,
            scope.success,
            summaries.flatMap(adoptionReceiptsFromSummary),
          );
        }),
      )
    : [];
  const targets = deriveRunningTargets(snapshots, journalRecords);
  return {
    userTargets: targets.userTargets,
    failures: [...failures, ...targets.failures],
    resolveGlobalTarget: resolveGlobalStopTarget(snapshots),
    // User stop hooks can change the scratch list before poweroff reaches that phase.
    readScratch: readScratchTargets(targets.scratchObserved),
  };
});
