import { isGlobalScopedVolume, volumeClassFromLabels } from "@lando/container-runtime/volume-classes";
import type { AppResolveError, NoProviderInstalledError } from "@lando/sdk/errors";
import type { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { FileSystem, type ProviderError, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

export interface MissingAppRoot {
  readonly root: AbsolutePath;
  readonly apps: ReadonlyArray<AppId>;
  readonly providers: ReadonlyArray<ProviderId>;
  readonly appliedState: boolean;
  readonly runtimeObserved: boolean;
  readonly services: ReadonlyArray<string>;
  readonly dataVolumes: ReadonlyArray<string>;
  readonly cacheVolumes: ReadonlyArray<string>;
}

export const findMissingAppRoots: Effect.Effect<
  ReadonlyArray<MissingAppRoot>,
  AppResolveError | ProviderError | NoProviderInstalledError,
  RuntimeProviderRegistry | FileSystem
> = Effect.gen(function* () {
  const registry = yield* RuntimeProviderRegistry;
  const fs = yield* FileSystem;
  if (registry.observeRuntime === undefined) return [];
  const snapshots = yield* registry.observeRuntime;
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
      groupFor(plan.identity.appRoot, plan.id, snapshot.providerId, snapshot.runtimeObserved).appliedState =
        true;
    }
    for (const service of snapshot.services) {
      if (
        service.containerId === undefined ||
        service.appRoot === undefined ||
        service.app === "global" ||
        service.labels?.["dev.lando.scratch"] === "TRUE"
      )
        continue;
      groupFor(service.appRoot, service.app, snapshot.providerId, snapshot.runtimeObserved).services.add(
        `${service.app}/${service.service}`,
      );
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
    }
  }
  const results = yield* Effect.forEach(
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ([root, group]) =>
      fs.exists(root).pipe(
        Effect.catch(() => Effect.succeed(true)),
        Effect.map(
          (exists): ReadonlyArray<MissingAppRoot> =>
            exists
              ? []
              : [
                  {
                    root,
                    apps: [...group.apps].sort(),
                    providers: [...group.providers].sort(),
                    appliedState: group.appliedState,
                    runtimeObserved: group.runtimeObserved,
                    services: [...group.services].sort(),
                    dataVolumes: [...group.dataVolumes].sort(),
                    cacheVolumes: [...group.cacheVolumes].sort(),
                  },
                ],
        ),
      ),
  );
  return results.flat();
});
