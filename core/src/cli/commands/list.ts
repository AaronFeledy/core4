import { access } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Schema } from "effect";

import type {
  AppLockTimeoutError,
  CacheError,
  ConfigError,
  LandoCommandError,
  StateStoreError,
} from "@lando/sdk/errors";
import type { FileSystem, LandoPaths, StateStoreShape } from "@lando/sdk/services";
import { ConfigService, PathsService, StateStore } from "@lando/sdk/services";

import { deleteCwdAppMapEntriesForRoot, listCwdAppMapEntries } from "@lando/engine/cache/cwd-app-map";
import { resolveUserCacheRoot } from "@lando/engine/cache/paths";
import { withAppMutationLock } from "@lando/engine/operations/app-mutation-lock";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { hasC0OrDel, hyperlink } from "@lando/renderer/console-layout";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { type RenderContext, contextAllowsHyperlinks } from "../renderer-boundary";
import {
  type AppsDiscoveryEvidence,
  type AppsListEntry,
  discoverRunningAppsEvidenceFromSockets,
  mergeAppsListEntries,
  readAppliedPlansFromUserData,
} from "./list-discovery";
import { appRootMatchesPathFilter, isPathLikeFilter, resolveExistingAppsListPath } from "./list-path-filter";
import { pruneAppliedPlanState } from "./list-prune-state";

export type { AppsListEntry } from "./list-discovery";
export { appliedPlansDirectory } from "./list-discovery";

export const APPS_LIST_STATUSES = ["active", "stopped", "unknown"] as const;
export type AppsListStatus = (typeof APPS_LIST_STATUSES)[number];

export const AppsListEntrySchema = Schema.Struct({
  appId: Schema.String,
  appName: Schema.String,
  providerId: Schema.String,
  appRoot: Schema.String,
  services: Schema.Array(Schema.String),
  status: Schema.Literals([...APPS_LIST_STATUSES]),
  stale: Schema.optionalKey(Schema.Boolean),
  scratch: Schema.optionalKey(Schema.Boolean),
});

export const AppsListResultSchema = Schema.Struct({
  apps: Schema.Array(AppsListEntrySchema),
  pruned: Schema.optionalKey(Schema.Array(AppsListEntrySchema)),
});

export interface ListServicesOptions {
  readonly path?: string;
  readonly status?: ReadonlyArray<AppsListStatus>;
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
  readonly includeScratch?: boolean;
}

export type ListServicesResult = typeof AppsListResultSchema.Type;

const cacheEntryToApp = (entry: { readonly appRoot: string }): AppsListEntry => ({
  appId: basename(entry.appRoot) || entry.appRoot,
  appName: basename(entry.appRoot) || entry.appRoot,
  providerId: "cache",
  appRoot: entry.appRoot,
  services: [],
});

const linkAppRoot = (appRoot: string): string => {
  if (appRoot.length === 0 || !isAbsolute(appRoot) || hasC0OrDel(appRoot)) return appRoot;
  return hyperlink(appRoot, pathToFileURL(appRoot).href);
};

export const renderAppsListResult = (
  result: ListServicesResult,
  _format: "json" | "table" = "table",
  ctx?: RenderContext,
  options?: { readonly filtered?: boolean },
): string => {
  const linkRoots = contextAllowsHyperlinks(ctx);
  const inventory = (() => {
    if (result.apps.length === 0) {
      return options?.filtered === true
        ? "No Lando apps match the filters."
        : "No Lando apps applied on this host.";
    }
    const header = ["APP", "STATUS", "PROVIDER", "SERVICES", "ROOT"];
    const rows = result.apps.map((app) => [
      app.appName,
      `${app.status}${app.stale === true ? " (stale)" : ""}`,
      app.providerId,
      app.services.join(",") || "-",
      app.appRoot,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const pad = (cells: ReadonlyArray<string>): string =>
      cells
        .map((c, i) => {
          if (i !== cells.length - 1) return c.padEnd(widths[i] ?? 0);
          return linkRoots ? linkAppRoot(c) : c;
        })
        .join("  ");
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

const listServicesInternal = Effect.fnUntraced(function* <E, R>(
  options: ListServicesOptions,
  pruneCandidate?: PruneCandidate<E, R>,
): Effect.fn.Return<ListServicesResult, CacheError | ConfigError | E | LandoCommandError, ConfigService | R> {
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
  const cachedApps = yield* listCwdAppMapEntries(userCacheRoot).pipe(Effect.catch(() => Effect.succeed([])));

  const discoverEvidence = (): Effect.Effect<AppsDiscoveryEvidence> =>
    Effect.tryPromise(async () => {
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
      return discoverRunningAppsEvidenceFromSockets(
        userDataRoot,
        undefined,
        options.includeScratch === true ? { includeScratch: true } : {},
      );
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({ apps: [], providerConfirmed: false, confirmedProviderIds: [], ownedAppIds: [] }),
      ),
    );
  const evidence = yield* discoverEvidence();
  const running = evidence.apps;

  const merged = mergeAppsListEntries([...persisted, ...cachedApps.map(cacheEntryToApp), ...running]);
  const apps = yield* Effect.promise(() =>
    Promise.all(
      merged.map(async (app) => {
        const status = running.some(
          (entry) => entry.appId === app.appId && entry.providerId === app.providerId,
        )
          ? "active"
          : evidence.confirmedProviderIds.includes(app.providerId)
            ? "stopped"
            : "unknown";
        const entry = { ...app, status } satisfies typeof AppsListEntrySchema.Type;
        if (app.appRoot === "") return entry;
        try {
          await access(app.appRoot);
          return entry;
        } catch {
          return { ...entry, stale: true as const };
        }
      }),
    ),
  );

  const pruned: Array<typeof AppsListEntrySchema.Type> = [];
  if (options.prune === true && evidence.providerConfirmed && pruneCandidate !== undefined) {
    const ownedAppIds = new Set(evidence.ownedAppIds);
    const confirmedProviderIds = new Set(evidence.confirmedProviderIds);
    const candidates = apps
      .filter(
        (entry) =>
          entry.stale === true && confirmedProviderIds.has(entry.providerId) && !ownedAppIds.has(entry.appId),
      )
      .slice(0, options.pruneLimit ?? 100);
    for (const entry of candidates) {
      const removed = yield* pruneCandidate({ discoverEvidence, entry, userCacheRoot });
      if (removed) pruned.push(entry);
    }
  }

  const listed = options.includeScratch === true ? apps : apps.filter((app) => app.scratch !== true);
  const pathFilter = options.path;
  const runtimeCwd = yield* Effect.serviceOption(RuntimeCwd);
  const cwd = runtimeCwd._tag === "Some" ? runtimeCwd.value : process.cwd();
  const resolvedPathFilter =
    pathFilter !== undefined && isPathLikeFilter(pathFilter)
      ? yield* Effect.promise(() => resolveExistingAppsListPath(pathFilter, cwd))
      : undefined;
  const statusFilter = options.status;
  const filtered = listed.filter((app) => {
    if (pathFilter !== undefined && !appRootMatchesPathFilter(app.appRoot, pathFilter, resolvedPathFilter)) {
      return false;
    }
    if (statusFilter !== undefined && !statusFilter.includes(app.status)) return false;
    return true;
  });
  filtered.sort((a, b) => a.appName.localeCompare(b.appName));
  const visible =
    pruneCandidate === undefined ? filtered : filtered.filter((entry) => !pruned.includes(entry));
  return { apps: visible, ...(pruneCandidate === undefined ? {} : { pruned }) };
});

export const listServices = Effect.fn("AppsList.listServices")(
  (
    options: ListServicesOptions = {},
  ): Effect.Effect<ListServicesResult, CacheError | ConfigError | LandoCommandError, ConfigService> =>
    listServicesInternal<never, never>(options),
);

export const listServicesWithPrune = Effect.fn("AppsList.listServicesWithPrune")(function* (
  options: ListServicesOptions = {},
): Effect.fn.Return<
  ListServicesResult,
  AppLockTimeoutError | CacheError | ConfigError | LandoCommandError | StateStoreError,
  ConfigService | FileSystem | PathsService | PrivateFileAccessService | StateStore
> {
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
          const rootGone = yield* Effect.promise(async () => {
            try {
              await access(entry.appRoot);
              return false;
            } catch {
              return true;
            }
          });
          if (!rootGone) return false;
          const removedCache = yield* deleteCwdAppMapEntriesForRoot({
            cacheRoot: userCacheRoot,
            appRoot: entry.appRoot,
          });
          const removedState = yield* pruneAppliedPlanState(
            pruneServices.paths,
            pruneServices.stateStore,
            entry,
          );
          return removedState || removedCache.length > 0;
        }),
      ).pipe(
        Effect.provideService(PathsService, pruneServices.paths),
        Effect.provideService(PrivateFileAccessService, pruneServices.privateFileAccess),
      ),
  );
});
