import { isGlobalScopedVolume, volumeClassFromLabels } from "@lando/container-runtime/volume-classes";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import {
  FileSystem,
  type ProviderRuntimeSnapshot,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { Effect, Option, Result } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import { acceleratedStartInventory } from "./accelerated-start-inventory.ts";
import { type PendingStart, digest } from "./accelerated-start-record.ts";
import { appRootIdentityKey } from "./app-root-identity.ts";
import type { MissingRootScan } from "./missing-app-root-schema.ts";
export { MissingAppRoot } from "./missing-app-root-schema.ts";

const collectMissingAppRoots = Effect.fnUntraced(function* (snapshots: readonly ProviderRuntimeSnapshot[]) {
  const fs = yield* FileSystem;
  const groups = new Map<
    AbsolutePath,
    {
      apps: Set<AppId>;
      providers: Set<ProviderId>;
      appliedState: boolean;
      runtimeObserved: boolean;
      services: Set<string>;
      dataVolumes: Set<string>;
      cacheVolumes: Set<string>;
      journals: PendingStart[];
      observations: Set<string>;
    }
  >();
  const groupFor = (root: AbsolutePath, app: AppId, providerId: ProviderId, runtimeObserved: boolean) => {
    let group = groups.get(root);
    if (group === undefined) {
      group = {
        apps: new Set(),
        providers: new Set(),
        appliedState: false,
        runtimeObserved: true,
        services: new Set(),
        dataVolumes: new Set(),
        cacheVolumes: new Set(),
        journals: [],
        observations: new Set(),
      };
      groups.set(root, group);
    }
    group.apps.add(app);
    group.providers.add(providerId);
    group.runtimeObserved &&= runtimeObserved;
    return group;
  };
  for (const snapshot of snapshots) {
    for (const plan of snapshot.appliedPlans) {
      // Teardown only targets plans by their recorded identity, so report nothing it cannot act on.
      if (
        plan.identity === undefined ||
        plan.id === "global" ||
        plan.extensions["@lando/core/scratch"] !== undefined
      )
        continue;
      const group = groupFor(plan.identity.appRoot, plan.id, snapshot.providerId, snapshot.runtimeObserved);
      group.appliedState = true;
      group.observations.add(digest(plan));
    }
    for (const service of snapshot.services) {
      if (
        service.containerId === undefined ||
        service.appRoot === undefined ||
        service.app === "global" ||
        service.labels?.["dev.lando.scratch"] === "TRUE"
      )
        continue;
      const group = groupFor(service.appRoot, service.app, snapshot.providerId, snapshot.runtimeObserved);
      group.services.add(`${service.app}/${service.service}`);
      group.observations.add(digest(service));
    }
    for (const volume of snapshot.volumes) {
      if (
        volume.identity === undefined ||
        volume.ref.app === "global" ||
        isGlobalScopedVolume(volume.labels) ||
        volume.labels?.["dev.lando.scratch"] === "TRUE"
      )
        continue;
      const group = groupFor(
        volume.identity.ownerRoot,
        volume.ref.app,
        snapshot.providerId,
        snapshot.runtimeObserved,
      );
      const names = volumeClassFromLabels(volume.labels) === "cache" ? group.cacheVolumes : group.dataVolumes;
      names.add(volume.identity.nativeName);
      group.observations.add(digest(volume));
    }
  }
  const store = yield* Effect.serviceOption(StateStore);
  const registry = yield* RuntimeProviderRegistry;
  const capabilityFailures = new Map<ProviderId, typeof MissingRootScan.Type>();
  const selected = yield* TeardownProvider;
  const journals = Option.isNone(store)
    ? { records: [], unreadable: [] }
    : yield* acceleratedStartInventory.pipe(Effect.provideService(StateStore, store.value));
  for (const { path, remediation: _remediation, ...journal } of journals.records) {
    if (journal.appId === "global" || (selected !== undefined && selected !== journal.providerId)) continue;
    // The filename binds app kind and root; scratch journals cannot claim a user root.
    if (
      !path.endsWith(
        `${digest(appRootIdentityKey({ kind: "user", id: AppId.make(journal.appId), root: AbsolutePath.make(journal.appRoot) }, journal.appRoot))}.json`,
      )
    )
      continue;
    const observed =
      snapshots.find((snapshot) => snapshot.providerId === journal.providerId)?.runtimeObserved ?? false;
    groupFor(
      AbsolutePath.make(journal.appRoot),
      AppId.make(journal.appId),
      ProviderId.make(journal.providerId),
      observed,
    ).journals.push(journal);
  }
  const results = yield* Effect.forEach(
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)),
    Effect.fnUntraced(function* ([root, group]) {
      if (yield* fs.exists(root).pipe(Effect.catch(() => Effect.succeed(true)))) return [];
      const providers = yield* Effect.forEach(
        [
          ...new Set(
            group.journals
              .filter((journal) => journal.targets.length > 0)
              .map((journal) => journal.providerId),
          ),
        ],
        (id) =>
          registry.select(ProviderId.make(id)).pipe(
            Effect.map((provider) => provider.capabilities.fileSyncTargets !== "prepared-volume"),
            Effect.catch((error) => {
              const providerId = ProviderId.make(id);
              capabilityFailures.set(providerId, {
                providerId,
                runtimeObserved: snapshots.some(
                  (snapshot) => snapshot.providerId === id && snapshot.runtimeObserved,
                ),
                recordedState: true,
                complete: false,
                message: error.message,
                errorTag: error._tag,
                remediation: error.remediation,
              });
              return Effect.succeed(false);
            }),
          ),
      );
      return [
        {
          root,
          apps: [...group.apps].sort(),
          providers: [...group.providers].sort(),
          appliedState: group.appliedState,
          runtimeObserved: group.runtimeObserved,
          fileSyncCopiesRemovable: providers.every(Boolean),
          services: [...group.services].sort(),
          dataVolumes: [...group.dataVolumes].sort(),
          cacheVolumes: [...group.cacheVolumes].sort(),
          journals: group.journals,
        },
      ];
    }),
  );
  return {
    candidates: results.flat(),
    unreadableJournals: journals.unreadable,
    journalProviders: new Set(journals.records.map((journal) => journal.providerId)),
    capabilityFailures,
    identities: new Map(
      [...groups.entries()].map(([root, group]) => [root, digest([...group.observations].sort())]),
    ),
  };
});

export const scanMissingAppRoots = Effect.fn("AppOperation.scanMissingAppRoots")(function* () {
  const registry = yield* RuntimeProviderRegistry;
  const selected = yield* TeardownProvider;
  const ids = (yield* registry.list).filter((id) => selected === undefined || id === selected);
  const scans: (typeof MissingRootScan.Type)[] = [];
  const snapshots: ProviderRuntimeSnapshot[] = [];
  // Scope each scan so a broken provider cannot hide another provider's leftovers.
  for (const id of ids) {
    const state =
      registry.appliedStateInventory === undefined
        ? undefined
        : yield* registry.appliedStateInventory(id).pipe(Effect.result);
    const recordedState =
      state !== undefined &&
      Result.isSuccess(state) &&
      (state.success.plans.length > 0 || state.success.unreadable.length > 0);
    const result = yield* (
      registry.observeRuntime ??
      Effect.succeed([
        {
          providerId: id,
          runtimeObserved: false,
          appliedPlans: state !== undefined && Result.isSuccess(state) ? state.success.plans : [],
          services: [],
          volumes: [],
        },
      ])
    ).pipe(Effect.provideService(TeardownProvider, id), Effect.result);
    if (Result.isFailure(result)) {
      if (state !== undefined && Result.isSuccess(state))
        snapshots.push({
          providerId: id,
          runtimeObserved: false,
          appliedPlans: state.success.plans,
          services: [],
          volumes: [],
        });
      scans.push({
        providerId: id,
        runtimeObserved: false,
        recordedState,
        complete: false,
        message: result.failure.message,
        errorTag: result.failure._tag,
        remediation: result.failure.remediation,
      });
    } else {
      const providerSnapshots = result.success.filter((item) => item.providerId === id);
      snapshots.push(...providerSnapshots);
      const observed = providerSnapshots[0]?.runtimeObserved === true;
      const stateFailure = state !== undefined && Result.isFailure(state) ? state.failure : undefined;
      const unreadable = state !== undefined && Result.isSuccess(state) ? state.success.unreadable.length : 0;
      scans.push({
        providerId: id,
        runtimeObserved: observed,
        recordedState:
          recordedState ||
          providerSnapshots.some(
            (snapshot) => snapshot.appliedPlans.length > 0 || snapshot.volumes.length > 0,
          ),
        complete: observed && stateFailure === undefined && unreadable === 0,
        message:
          stateFailure?.message ??
          (unreadable > 0
            ? `${unreadable} applied-state records could not be read.`
            : observed
              ? "Runtime resources inspected."
              : "Runtime not observed; containers and volumes are not listed."),
        ...(stateFailure !== undefined
          ? { errorTag: stateFailure._tag, remediation: stateFailure.remediation }
          : unreadable > 0
            ? {
                errorTag: "AppResolveError",
                remediation: "Repair the unreadable applied-state records, then rerun apps:gc.",
              }
            : {}),
      });
    }
  }
  if (ids.length === 0 && selected === undefined && registry.observeRuntime !== undefined)
    snapshots.push(...(yield* registry.observeRuntime));
  const inventory = yield* collectMissingAppRoots(snapshots);
  for (const [id, failure] of inventory.capabilityFailures) {
    const index = scans.findIndex((scan) => scan.providerId === id);
    if (index < 0) scans.push(failure);
    else scans[index] = failure;
  }
  const recordedScans = yield* Effect.forEach(
    scans,
    Effect.fnUntraced(function* (scan) {
      const ownership = yield* (
        registry.hasRecordedOwnership?.(scan.providerId) ?? Effect.succeed(false)
      ).pipe(Effect.result);
      return {
        ...scan,
        recordedState:
          scan.recordedState ||
          inventory.journalProviders.has(scan.providerId) ||
          (Result.isSuccess(ownership) && ownership.success),
        ...(Result.isFailure(ownership)
          ? {
              complete: false,
              message: ownership.failure.message,
              errorTag: ownership.failure._tag,
              remediation: ownership.failure.remediation,
            }
          : {}),
      };
    }),
  );
  return { ...inventory, scans: recordedScans };
});

export const findMissingAppRoots = scanMissingAppRoots().pipe(Effect.map(({ candidates }) => candidates));
