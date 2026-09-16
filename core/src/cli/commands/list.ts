import { access } from "node:fs/promises";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import type {
  AppLockTimeoutError,
  CacheError,
  ConfigError,
  LandoCommandError,
  StateStoreError,
} from "@lando/sdk/errors";
import type { LandoPaths, StateStoreShape } from "@lando/sdk/services";
import { ConfigService, PathsService, StateStore } from "@lando/sdk/services";

import { deleteCwdAppMapEntriesForRoot, listCwdAppMapEntries } from "@lando/engine/cache/cwd-app-map";
import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { withAppMutationLock } from "@lando/engine/operations/app-mutation-lock";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";

import {
  type AppsDiscoveryEvidence,
  type AppsListEntry,
  discoverRunningAppsEvidenceFromSockets,
  mergeAppsListEntries,
  readAppliedPlansFromUserData,
} from "./list-discovery";
import { pruneAppliedPlanState } from "./list-prune-state";

export type { AppsListEntry } from "./list-discovery";
export { appliedPlansDirectory } from "./list-discovery";

export const AppsListEntrySchema = Schema.Struct({
  appId: Schema.String,
  appName: Schema.String,
  providerId: Schema.String,
  appRoot: Schema.String,
  services: Schema.Array(Schema.String),
  stale: Schema.optional(Schema.Boolean),
});

export const AppsListResultSchema = Schema.Struct({
  apps: Schema.Array(AppsListEntrySchema),
  pruned: Schema.optional(Schema.Array(AppsListEntrySchema)),
});

export interface ListServicesOptions {
  readonly path?: string;
  readonly format?: "json" | "table";
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
  readonly discoverContainers?: (userDataRoot: string) => Promise<ReadonlyArray<AppsListEntry>>;
  readonly discoverContainersEvidence?: (userDataRoot: string) => Promise<{
    readonly apps: ReadonlyArray<AppsListEntry>;
    readonly confirmedProviderIds: ReadonlyArray<string>;
    readonly ownedAppIds?: ReadonlyArray<string>;
  }>;
  readonly prune?: boolean;
  readonly pruneLimit?: number;
}

export interface ListServicesResult {
  readonly apps: ReadonlyArray<AppsListEntry>;
  readonly pruned?: ReadonlyArray<AppsListEntry>;
}

const cacheEntryToApp = (entry: { readonly appRoot: string }): AppsListEntry => ({
  appId: basename(entry.appRoot) || entry.appRoot,
  appName: basename(entry.appRoot) || entry.appRoot,
  providerId: "cache",
  appRoot: entry.appRoot,
  services: [],
});

export const renderAppsListResult = (
  result: ListServicesResult,
  _format: "json" | "table" = "table",
): string => {
  const inventory = (() => {
    if (result.apps.length === 0) return "No Lando apps applied on this host.";
    const header = ["APP", "STATUS", "PROVIDER", "SERVICES", "ROOT"];
    const rows = result.apps.map((app) => [
      app.appName,
      app.stale === true ? "stale" : "active",
      app.providerId,
      app.services.join(",") || "-",
      app.appRoot,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const pad = (cells: ReadonlyArray<string>): string =>
      cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
    return [pad(header), ...rows.map(pad)].join("\n");
  })();
  if (result.pruned === undefined) return inventory;
  if (result.pruned.length === 0) return `${inventory}\nPruned 0 stale inventory entries.`;
  const entries = result.pruned.map((entry) => `- ${entry.appId} (${entry.providerId}) ${entry.appRoot}`);
  return `${inventory}\nPruned ${result.pruned.length} stale inventory ${result.pruned.length === 1 ? "entry" : "entries"}:\n${entries.join("\n")}`;
};

interface PruneServices {
  readonly paths: LandoPaths;
  readonly privateFileAccess: PrivateFileAccess;
  readonly stateStore: StateStoreShape;
}

interface PruneCandidateInput {
  readonly discoverEvidence: () => Effect.Effect<AppsDiscoveryEvidence>;
  readonly entry: AppsListEntry;
  readonly userCacheRoot: string;
}

type PruneCandidate<E, R> = (input: PruneCandidateInput) => Effect.Effect<boolean, E, R>;

const listServicesInternal = <E, R>(
  options: ListServicesOptions,
  pruneCandidate?: PruneCandidate<E, R>,
): Effect.Effect<ListServicesResult, CacheError | ConfigError | E | LandoCommandError, ConfigService | R> =>
  Effect.gen(function* () {
    const configService = yield* ConfigService;
    const userDataRoot = options.userDataRoot ?? (yield* configService.get("userDataRoot"));
    if (userDataRoot === undefined) return { apps: [] };

    const persisted = yield* Effect.promise(async () => {
      try {
        return await readAppliedPlansFromUserData(userDataRoot);
      } catch {
        return [];
      }
    });

    const userCacheRoot = options.userCacheRoot ?? resolveUserCacheRoot();
    const cachedApps = yield* listCwdAppMapEntries(userCacheRoot).pipe(
      Effect.catchAll(() => Effect.succeed([])),
    );

    const discoverEvidence = (): Effect.Effect<AppsDiscoveryEvidence> =>
      Effect.promise(async () => {
        if (options.discoverContainersEvidence !== undefined) {
          const discovered = await options.discoverContainersEvidence(userDataRoot);
          return {
            ...discovered,
            providerConfirmed: discovered.confirmedProviderIds.length > 0,
            ownedAppIds: discovered.ownedAppIds ?? discovered.apps.map((app) => app.appId),
          };
        }
        if (options.discoverContainers !== undefined) {
          const apps = await options.discoverContainers(userDataRoot);
          return {
            apps,
            providerConfirmed: true,
            confirmedProviderIds: [...new Set(apps.map((app) => app.providerId))],
            ownedAppIds: apps.map((app) => app.appId),
          };
        }
        return discoverRunningAppsEvidenceFromSockets(userDataRoot);
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed({ apps: [], providerConfirmed: false, confirmedProviderIds: [], ownedAppIds: [] }),
        ),
      );
    const evidence = yield* discoverEvidence();
    const running = evidence.apps;

    const merged = mergeAppsListEntries([...persisted, ...cachedApps.map(cacheEntryToApp), ...running]);
    const apps = yield* Effect.promise(() =>
      Promise.all(
        merged.map(async (app) => {
          if (app.appRoot === "") return app;
          try {
            await access(app.appRoot);
            return app;
          } catch {
            return { ...app, stale: true as const };
          }
        }),
      ),
    );

    const pruned: AppsListEntry[] = [];
    if (options.prune === true && evidence.providerConfirmed && pruneCandidate !== undefined) {
      const ownedAppIds = new Set(evidence.ownedAppIds);
      const confirmedProviderIds = new Set(evidence.confirmedProviderIds);
      const candidates = apps
        .filter(
          (entry) =>
            entry.stale === true &&
            confirmedProviderIds.has(entry.providerId) &&
            !ownedAppIds.has(entry.appId),
        )
        .slice(0, options.pruneLimit ?? 100);
      for (const entry of candidates) {
        const removed = yield* pruneCandidate({ discoverEvidence, entry, userCacheRoot });
        if (removed) pruned.push(entry);
      }
    }

    const pathFilter = options.path;
    const filtered = pathFilter === undefined ? apps : apps.filter((a) => a.appRoot.includes(pathFilter));
    filtered.sort((a, b) => a.appName.localeCompare(b.appName));
    const visible = options.prune === true ? filtered.filter((entry) => !pruned.includes(entry)) : filtered;
    return { apps: visible, ...(options.prune === true ? { pruned } : {}) };
  });

export const listServices = (
  options: ListServicesOptions = {},
): Effect.Effect<ListServicesResult, CacheError | ConfigError | LandoCommandError, ConfigService> =>
  listServicesInternal<never, never>(options);

export const listServicesWithPrune = (
  options: ListServicesOptions = {},
): Effect.Effect<
  ListServicesResult,
  AppLockTimeoutError | CacheError | ConfigError | LandoCommandError | StateStoreError,
  ConfigService | PathsService | PrivateFileAccessService | StateStore
> =>
  Effect.gen(function* () {
    const paths = yield* PathsService;
    const privateFileAccess = yield* PrivateFileAccessService;
    const stateStore = yield* StateStore;
    const pruneServices = { paths, privateFileAccess, stateStore } satisfies PruneServices;
    return yield* listServicesInternal(
      { ...options, prune: true },
      ({ discoverEvidence, entry, userCacheRoot }) =>
        withAppMutationLock(
          { id: entry.appId, root: entry.appRoot },
          Effect.gen(function* () {
            const currentEvidence = yield* discoverEvidence();
            if (
              !currentEvidence.confirmedProviderIds.includes(entry.providerId) ||
              currentEvidence.ownedAppIds.includes(entry.appId)
            ) {
              return false;
            }
            const removedCache = yield* deleteCwdAppMapEntriesForRoot({
              cacheRoot: userCacheRoot,
              appRoot: entry.appRoot,
            });
            const removedState = yield* pruneAppliedPlanState(
              pruneServices.paths,
              pruneServices.stateStore,
              entry.appId,
              entry.providerId,
            );
            return removedState || removedCache.length > 0;
          }),
        ).pipe(
          Effect.provideService(PathsService, pruneServices.paths),
          Effect.provideService(PrivateFileAccessService, pruneServices.privateFileAccess),
        ),
    );
  });
