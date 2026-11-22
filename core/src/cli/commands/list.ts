import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { adoptionReceiptsFromSummary } from "@lando/container-runtime/native-ownership";
import { makeResourceOwnershipStore } from "@lando/container-runtime/provider-assembly";
import { withAppMutationLock } from "@lando/engine/operations/app-mutation-lock";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { makeLandoPaths } from "@lando/paths";
import { hasC0OrDel, hyperlink } from "@lando/renderer/console-layout";
import type { AppLockTimeoutError, CacheError, LandoCommandError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, type CommandWarning } from "@lando/sdk/schema";
import type { FileSystem, LandoPaths, StateStoreShape } from "@lando/sdk/services";
import { ConfigService, PathsService, ProcessRunner, StateStore } from "@lando/sdk/services";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Result, Schema } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";

import { recordCommandWarning } from "../command-warnings";
import { type RenderContext, contextAllowsHyperlinks } from "../renderer-boundary";
import {
  type AppsDiscoveryEvidence,
  type AppsListEntry,
  type OwnedAppResource,
  appsListIdentity,
  containerSocketCandidates,
  discoverRunningAppsEvidenceFromSockets,
  mergeAppsListEntries,
  readAppliedPlansFromUserData,
} from "./list-discovery";
import { AppsListPathResolver, filterAppsByPath } from "./list-path-filter";
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
    readonly ownedResources?: ReadonlyArray<OwnedAppResource>;
    readonly idleProviderIds?: ReadonlyArray<string>;
  }>;
  readonly prune?: boolean;
  readonly pruneLimit?: number;
  readonly includeScratch?: boolean;
}

export type ListServicesResult = typeof AppsListResultSchema.Type;

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
}

type PruneCandidate<E, R> = (input: PruneCandidateInput) => Effect.Effect<boolean, E, R>;

const listServicesInternal = Effect.fnUntraced(function* <E, R>(
  options: ListServicesOptions,
  pruneCandidate?: PruneCandidate<E, R>,
): Effect.fn.Return<ListServicesResult, CacheError | E | LandoCommandError, ConfigService | R> {
  const configService = yield* ConfigService;
  const invocation = yield* CliInvocation;
  const processRunner = yield* Effect.serviceOption(ProcessRunner);
  const stateStore = yield* Effect.serviceOption(StateStore);
  const privateFileAccess = yield* Effect.serviceOption(PrivateFileAccessService);
  const userDataRoot = options.userDataRoot ?? (yield* configService.get("userDataRoot"));
  if (userDataRoot === undefined) return { apps: [] };

  const persisted = yield* Effect.promise(async () => {
    try {
      return await readAppliedPlansFromUserData(userDataRoot);
    } catch {
      return [];
    }
  });

  const ownedFromApps = (apps: ReadonlyArray<AppsListEntry>): ReadonlyArray<OwnedAppResource> =>
    apps.map(
      (app): OwnedAppResource => ({
        appId: app.appId,
        ...(app.appRoot === "" ? {} : { appRoot: app.appRoot }),
      }),
    );
  const ownershipWarnings = new Map<string, CommandWarning>();
  const discoverEvidence = (): Effect.Effect<AppsDiscoveryEvidence> =>
    Effect.tryPromise(async () => {
      if (options.discoverContainersEvidence !== undefined) {
        const discovered = await options.discoverContainersEvidence(userDataRoot);
        return {
          ...discovered,
          providerConfirmed: discovered.confirmedProviderIds.length > 0,
          ownedResources: discovered.ownedResources ?? ownedFromApps(discovered.apps),
        };
      }
      if (options.discoverContainers !== undefined) {
        const apps = await options.discoverContainers(userDataRoot);
        return {
          apps,
          providerConfirmed: true,
          confirmedProviderIds: [...new Set(apps.map((app) => app.providerId))],
          ownedResources: ownedFromApps(apps),
        };
      }
      const evidence = await discoverRunningAppsEvidenceFromSockets(
        userDataRoot,
        containerSocketCandidates(userDataRoot, { env: invocation.env }),
        {
          ...(options.includeScratch === true ? { includeScratch: true } : {}),
          env: invocation.env,
          ...(stateStore._tag === "Some" && privateFileAccess._tag === "Some"
            ? {
                readReceipts: async (providerId: string, root: AbsolutePath) => {
                  const paths = makeLandoPaths({ userDataRoot });
                  const pluginStore = makePluginStateStore(
                    stateStore.value,
                    AbsolutePath.make(paths.pluginStateDir(`@lando/provider-${providerId}`)),
                    privateFileAccess.value,
                  );
                  const ownership = await Effect.runPromise(
                    makeResourceOwnershipStore(providerId, pluginStore).summary(root).pipe(Effect.result),
                  );
                  if (Result.isSuccess(ownership)) return adoptionReceiptsFromSummary(ownership.success);
                  ownershipWarnings.set(providerId, {
                    code: "LANDO_OWNERSHIP_INVENTORY_UNREADABLE",
                    message: `Provider ${providerId}: ${ownership.failure.message}`,
                    remediation:
                      "Check the provider plugin state permissions or restore the ownership inventory from a trusted backup, then rerun `lando list`.",
                    context: { providerId },
                  });
                  return [];
                },
              }
            : {}),
          ...(processRunner._tag === "Some" ? { processRunner: processRunner.value } : {}),
        },
      );
      const confirmedProviderIds = evidence.confirmedProviderIds.filter((id) => !ownershipWarnings.has(id));
      return { ...evidence, confirmedProviderIds, providerConfirmed: confirmedProviderIds.length > 0 };
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          apps: [],
          providerConfirmed: false,
          confirmedProviderIds: [],
          ownedResources: [],
        }),
      ),
    );
  const evidence = yield* discoverEvidence();
  const running = evidence.apps;

  const merged = mergeAppsListEntries([...persisted, ...running]);
  const runningIdentities = new Set(running.map(appsListIdentity));
  const apps = yield* Effect.promise(() =>
    Promise.all(
      merged.map(async (app) => {
        const status = runningIdentities.has(appsListIdentity(app))
          ? "active"
          : evidence.confirmedProviderIds.includes(app.providerId) ||
              evidence.idleProviderIds?.includes(app.providerId) === true
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

  const ownedBy = (entry: AppsListEntry): boolean =>
    evidence.ownedResources.some(
      (resource) =>
        resource.appId === entry.appId &&
        (resource.appRoot === undefined || resource.appRoot === entry.appRoot),
    );
  const pruned: Array<typeof AppsListEntrySchema.Type> = [];
  if (options.prune === true && evidence.providerConfirmed && pruneCandidate !== undefined) {
    const confirmedProviderIds = new Set(evidence.confirmedProviderIds);
    const candidates = apps
      .filter(
        (entry) => entry.stale === true && confirmedProviderIds.has(entry.providerId) && !ownedBy(entry),
      )
      .slice(0, options.pruneLimit ?? 100);
    for (const entry of candidates) {
      const removed = yield* pruneCandidate({ discoverEvidence, entry });
      if (removed) pruned.push(entry);
    }
  }

  const listed = options.includeScratch === true ? apps : apps.filter((app) => app.scratch !== true);
  const pathFilter = options.path;
  const runtimeCwd = yield* Effect.serviceOption(RuntimeCwd);
  const cwd = runtimeCwd._tag === "Some" ? runtimeCwd.value : invocation.cwd;
  const pathMatched =
    pathFilter === undefined
      ? listed
      : yield* filterAppsByPath(listed, pathFilter, cwd).pipe(Effect.provide(AppsListPathResolver.layer));
  const statusFilter = options.status;
  const filtered = pathMatched.filter((app) => {
    if (statusFilter !== undefined && !statusFilter.includes(app.status)) return false;
    return true;
  });
  // Same-named apps at different roots get a stable order instead of filesystem read order.
  filtered.sort(
    (a, b) =>
      a.appName.localeCompare(b.appName) ||
      a.appRoot.localeCompare(b.appRoot) ||
      a.providerId.localeCompare(b.providerId),
  );
  const visible =
    pruneCandidate === undefined ? filtered : filtered.filter((entry) => !pruned.includes(entry));
  for (const warning of ownershipWarnings.values()) yield* recordCommandWarning(warning);
  return { apps: visible, ...(pruneCandidate === undefined ? {} : { pruned }) };
});

export const listServices = Effect.fn("AppsList.listServices")(
  (
    options: ListServicesOptions = {},
  ): Effect.Effect<ListServicesResult, CacheError | LandoCommandError, ConfigService> =>
    listServicesInternal<never, never>(options),
);

export const listServicesWithPrune = Effect.fn("AppsList.listServicesWithPrune")(function* (
  options: ListServicesOptions = {},
): Effect.fn.Return<
  ListServicesResult,
  AppLockTimeoutError | CacheError | LandoCommandError | StateStoreError,
  ConfigService | FileSystem | PathsService | PrivateFileAccessService | StateStore
> {
  const paths = yield* PathsService;
  const privateFileAccess = yield* PrivateFileAccessService;
  const stateStore = yield* StateStore;
  const pruneServices = { paths, privateFileAccess, stateStore } satisfies PruneServices;
  return yield* listServicesInternal({ ...options, prune: true }, ({ discoverEvidence, entry }) =>
    withAppMutationLock(
      {
        id: entry.appId,
        root: entry.appRoot,
        kind: entry.scratch === true ? "scratch" : entry.appId === "global" ? "global" : "user",
      },
      Effect.gen(function* () {
        const currentEvidence = yield* discoverEvidence();
        if (
          !currentEvidence.confirmedProviderIds.includes(entry.providerId) ||
          currentEvidence.ownedResources.some(
            (resource) =>
              resource.appId === entry.appId &&
              (resource.appRoot === undefined || resource.appRoot === entry.appRoot),
          )
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
        return yield* pruneAppliedPlanState(pruneServices.paths, pruneServices.stateStore, entry);
      }),
    ).pipe(
      Effect.provideService(PathsService, pruneServices.paths),
      Effect.provideService(PrivateFileAccessService, pruneServices.privateFileAccess),
    ),
  );
});
