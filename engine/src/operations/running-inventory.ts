import { SCRATCH_LABEL } from "@lando/container-runtime/labels";
import { AppResolveError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import {
  type ProviderRuntimeSnapshot,
  RuntimeProviderRegistry,
  ScratchAppService,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import { readAcceleratedStartInventory } from "./accelerated-start-inventory.ts";
import { digest } from "./accelerated-start-record.ts";
import { appRootIdentityKey } from "./app-root-identity.ts";
import {
  providerInventoryFailure,
  unobservedRuntimeError,
  unreadableAppliedState,
} from "./poweroff-failures.ts";

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

const ACTIVE_SERVICE_STATUSES: ReadonlySet<ServiceRuntimeInfo["status"]> = new Set([
  "running",
  "paused",
  "restarting",
  "created",
]);

const readProviderSnapshots = Effect.fnUntraced(function* (journalProviders: ReadonlySet<string>) {
  const registry = yield* RuntimeProviderRegistry;
  const failures: InventoryFailure[] = [];
  const snapshots: ProviderRuntimeSnapshot[] = [];
  const idsResult = yield* registry.list.pipe(Effect.result);
  const ids = Result.isSuccess(idsResult) ? idsResult.success : [];
  if (Result.isFailure(idsResult)) failures.push(providerInventoryFailure("providers", idsResult.failure));

  for (const id of ids) {
    const state =
      registry.appliedStateInventory === undefined
        ? undefined
        : yield* registry.appliedStateInventory(id).pipe(Effect.result);
    if (state !== undefined && Result.isFailure(state))
      failures.push(providerInventoryFailure(String(id), state.failure));
    if (state !== undefined && Result.isSuccess(state) && state.success.unreadable.length > 0)
      failures.push(
        providerInventoryFailure(String(id), unreadableAppliedState(id, state.success.unreadable.length)),
      );
    const ownership =
      registry.hasRecordedOwnership === undefined
        ? undefined
        : yield* registry.hasRecordedOwnership(id).pipe(Effect.result);
    if (ownership !== undefined && Result.isFailure(ownership))
      failures.push(providerInventoryFailure(String(id), ownership.failure));
    const hasRecordedHoldings =
      journalProviders.has(String(id)) ||
      (state !== undefined &&
        (Result.isFailure(state) || state.success.plans.length > 0 || state.success.unreadable.length > 0)) ||
      (ownership !== undefined && (Result.isFailure(ownership) || ownership.success));

    // Scope each observation so a broken provider cannot hide another provider's workloads.
    const observed = yield* (registry.observeRuntime ?? Effect.succeed([])).pipe(
      Effect.provideService(TeardownProvider, id),
      Effect.result,
    );
    if (Result.isFailure(observed)) {
      if (hasRecordedHoldings) failures.push(providerInventoryFailure(String(id), observed.failure));
      continue;
    }
    const providerSnapshots = observed.success.filter((snapshot) => snapshot.providerId === id);
    snapshots.push(...providerSnapshots);
    if (providerSnapshots.some((snapshot) => snapshot.runtimeObserved)) continue;
    // A failed status observation is indistinguishable from idle in the snapshot. Classify it
    // without launching, and fail only when this provider has recorded holdings to protect.
    const status = yield* registry.select(id).pipe(
      Effect.flatMap((provider) => provider.getStatus),
      Effect.result,
    );
    if (Result.isFailure(status)) {
      if (hasRecordedHoldings) failures.push(providerInventoryFailure(String(id), status.failure));
      continue;
    }
    if (status.success.state !== "idle" && hasRecordedHoldings)
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
      if (service.labels?.[SCRATCH_LABEL] === "TRUE") {
        if (ACTIVE_SERVICE_STATUSES.has(service.status))
          scratchObserved.set(String(service.app), {
            id: String(service.app),
            appRoot: service.appRoot ?? AbsolutePath.make(""),
            providerId: service.providerId,
          });
        continue;
      }
      if (!ACTIVE_SERVICE_STATUSES.has(service.status)) continue;
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
  const targets = deriveRunningTargets(inventory.snapshots, journalRecords);
  return {
    userTargets: targets.userTargets,
    failures: [...failures, ...targets.failures],
    // User stop hooks can change the scratch list before poweroff reaches that phase.
    readScratch: readScratchTargets(targets.scratchObserved),
  };
});
