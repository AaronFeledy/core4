import { access } from "node:fs/promises";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { deleteCwdAppMapEntriesForRoot, listCwdAppMapEntries } from "@lando/engine/cache/cwd-app-map";
import { resolveUserCacheRoot } from "@lando/engine/cache/paths";

import {
  type AppsListEntry,
  discoverRunningAppsEvidenceFromSockets,
  mergeAppsListEntries,
  pruneAppliedPlanFromUserData,
  readAppliedPlansFromUserData,
} from "./list-discovery";

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

export const listServices = (
  options: ListServicesOptions = {},
): Effect.Effect<ListServicesResult, ConfigError | LandoCommandError, ConfigService> =>
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

    const evidence = yield* Effect.promise(async () => {
      if (options.discoverContainersEvidence !== undefined) {
        const discovered = await options.discoverContainersEvidence(userDataRoot);
        return {
          ...discovered,
          providerConfirmed: discovered.confirmedProviderIds.length > 0,
        };
      }
      if (options.discoverContainers !== undefined) {
        const apps = await options.discoverContainers(userDataRoot);
        return {
          apps,
          providerConfirmed: true,
          confirmedProviderIds: [...new Set(apps.map((app) => app.providerId))],
        };
      }
      return discoverRunningAppsEvidenceFromSockets(userDataRoot);
    }).pipe(
      Effect.catchAll(() => Effect.succeed({ apps: [], providerConfirmed: false, confirmedProviderIds: [] })),
    );
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
    if (options.prune === true && evidence.providerConfirmed) {
      const runningIds = new Set(running.map((entry) => entry.appId));
      const confirmedProviderIds = new Set(evidence.confirmedProviderIds);
      const candidates = apps
        .filter(
          (entry) =>
            entry.stale === true &&
            confirmedProviderIds.has(entry.providerId) &&
            !runningIds.has(entry.appId),
        )
        .slice(0, options.pruneLimit ?? 100);
      for (const entry of candidates) {
        const removedState = yield* Effect.promise(() =>
          pruneAppliedPlanFromUserData(userDataRoot, entry.appId, entry.providerId),
        );
        const removedCache = yield* deleteCwdAppMapEntriesForRoot({
          cacheRoot: userCacheRoot,
          appRoot: entry.appRoot,
        }).pipe(Effect.catchAll(() => Effect.succeed([])));
        if (removedState || removedCache.length > 0) pruned.push(entry);
      }
    }

    const pathFilter = options.path;
    const filtered = pathFilter === undefined ? apps : apps.filter((a) => a.appRoot.includes(pathFilter));
    filtered.sort((a, b) => a.appName.localeCompare(b.appName));
    const visible = options.prune === true ? filtered.filter((entry) => !pruned.includes(entry)) : filtered;
    return { apps: visible, ...(options.prune === true ? { pruned } : {}) };
  });
