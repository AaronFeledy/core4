import { basename } from "node:path";

import { Effect, Schema } from "effect";

import type { ConfigError, LandoCommandError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { listCwdAppMapEntries } from "@lando/engine/cache/cwd-app-map";
import { resolveUserCacheRoot } from "@lando/engine/cache/paths";

import {
  type AppsListEntry,
  discoverRunningAppsFromSockets,
  mergeAppsListEntries,
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
});

export const AppsListResultSchema = Schema.Struct({
  apps: Schema.Array(AppsListEntrySchema),
});

export interface ListServicesOptions {
  readonly path?: string;
  readonly format?: "json" | "table";
  readonly userDataRoot?: string;
  readonly userCacheRoot?: string;
  readonly discoverContainers?: (userDataRoot: string) => Promise<ReadonlyArray<AppsListEntry>>;
}

export interface ListServicesResult {
  readonly apps: ReadonlyArray<AppsListEntry>;
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
  if (result.apps.length === 0) {
    return "No Lando apps applied on this host.";
  }
  const header = ["APP", "PROVIDER", "SERVICES", "ROOT"];
  const rows = result.apps.map((app) => [
    app.appName,
    app.providerId,
    app.services.join(",") || "-",
    app.appRoot,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  return [pad(header), ...rows.map(pad)].join("\n");
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

    const discover = options.discoverContainers ?? discoverRunningAppsFromSockets;
    const running = yield* Effect.promise(async () => {
      try {
        return await discover(userDataRoot);
      } catch {
        return [];
      }
    });

    const apps = mergeAppsListEntries([...persisted, ...cachedApps.map(cacheEntryToApp), ...running]);

    const pathFilter = options.path;
    const filtered = pathFilter === undefined ? apps : apps.filter((a) => a.appRoot.includes(pathFilter));
    filtered.sort((a, b) => a.appName.localeCompare(b.appName));
    return { apps: filtered };
  });
