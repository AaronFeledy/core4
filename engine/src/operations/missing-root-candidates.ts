import { isGlobalScopedVolume, volumeClassFromLabels } from "@lando/container-runtime/volume-classes";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import {
  FileSystem,
  type ProviderRuntimeSnapshot,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import { acceleratedStartInventory } from "./accelerated-start-inventory.ts";
import { type PendingStart, digest } from "./accelerated-start-record.ts";
import { appRootIdentityKey } from "./app-root-identity.ts";
import type { MissingRootScan } from "./missing-app-root-schema.ts";

/** Groups observed and recorded leftovers by the app root whose folder no longer exists. */
export const collectMissingAppRoots = Effect.fnUntraced(function* (
  snapshots: readonly ProviderRuntimeSnapshot[],
) {
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
