import { Effect, Exit } from "effect";

import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import {
  type PluginUpdateInventoryItem,
  type PluginUpdateMetadata,
  type PluginUpdatePlanRow,
  type PluginUpdateRunner,
  planUpdates,
} from "@lando/engine/operations/update";
import { readInstalledPluginRegistry } from "@lando/engine/plugins/installed-registry";
import { withPluginMutationLock } from "@lando/engine/plugins/mutation-lock";
import { makeLandoPaths } from "@lando/paths";
import type { ConfigError, NotImplementedError } from "@lando/sdk/errors";
import type { PluginManifest } from "@lando/sdk/schema";
import { ConfigService, PluginTrustStore } from "@lando/sdk/services";
import {
  DEFAULT_NPM_REGISTRY_URL,
  type NpmPackument,
  type NpmRegistryClient,
  defaultNpmRegistryClient,
} from "../../recipes/npm-source";
import type { TarballRecipeExtractor, TarballRecipeFetcher } from "../../recipes/tarball-source";
import type { BunSelfSpawner } from "./bun-self-runner";
import { pluginAdd } from "./plugin-add";

export interface PluginUpdateAdapterOptions {
  readonly pluginsRoot?: string;
  readonly userDataRoot?: string;
  readonly cacheRoot?: string;
  readonly registryUrl?: string;
  readonly registryClient?: NpmRegistryClient;
  readonly fetcher?: TarballRecipeFetcher;
  readonly extractor?: TarballRecipeExtractor;
  readonly bunSelfSpawner?: BunSelfSpawner;
}

const advertisedMetadata = (packument: NpmPackument): PluginUpdateMetadata => {
  const versions: Record<string, PluginUpdateMetadata["versions"][string]> = {};
  for (const [publishedVersion, npmVersion] of Object.entries(packument.versions ?? {})) {
    const advertised = npmVersion.landoPlugin;
    const name = advertised?.name ?? npmVersion.name;
    const version = advertised?.version ?? npmVersion.version;
    if (name === undefined || version === undefined || advertised?.requires === undefined) continue;
    versions[publishedVersion] = { name, version, requires: advertised.requires };
  }
  return { distTags: packument["dist-tags"] ?? {}, versions };
};

const loadManifest = (path: string): Effect.Effect<PluginManifest | undefined> =>
  Effect.tryPromise(() => validatePluginManifest(path)).pipe(
    Effect.map(({ manifest }) => manifest),
    Effect.catchAll(() => Effect.succeed(undefined)),
  );

const inventoryFor = (
  pluginsRoot: string,
  trustStore: typeof PluginTrustStore.Service,
  registryClient: NpmRegistryClient,
): Effect.Effect<ReadonlyArray<PluginUpdateInventoryItem>> =>
  Effect.gen(function* () {
    const registry = yield* Effect.promise(() => readInstalledPluginRegistry(pluginsRoot));
    return yield* Effect.forEach(
      Object.values(registry),
      (entry) =>
        Effect.gen(function* () {
          const manifest = yield* loadManifest(entry.path);
          const trusted = yield* trustStore
            .isPluginTrusted(entry.name)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
          const mayResolve =
            entry.requestedSelector !== undefined &&
            entry.source !== "linked" &&
            manifest?.bundled !== true &&
            trusted;
          const packument = mayResolve
            ? yield* Effect.tryPromise(() => registryClient.fetchPackument(entry.name)).pipe(
                Effect.catchAll(() => Effect.succeed(undefined)),
              )
            : undefined;
          return {
            name: entry.name,
            currentVersion: entry.version,
            ...(manifest?.requires === undefined ? {} : { currentRequires: manifest.requires }),
            ...(entry.requestedSelector === undefined ? {} : { requestedSelector: entry.requestedSelector }),
            ...(entry.source === undefined ? {} : { source: entry.source }),
            ...(manifest?.bundled === undefined ? {} : { bundled: manifest.bundled }),
            trusted,
            ...(packument === undefined ? {} : { metadata: advertisedMetadata(packument) }),
          } satisfies PluginUpdateInventoryItem;
        }),
      { concurrency: "unbounded" },
    );
  });

export const makePluginUpdateRunner = (
  options: PluginUpdateAdapterOptions = {},
): Effect.Effect<PluginUpdateRunner, ConfigError | NotImplementedError, ConfigService | PluginTrustStore> =>
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const trustStore = yield* PluginTrustStore;
    let userDataRoot = options.userDataRoot;
    if (userDataRoot === undefined) userDataRoot = yield* config.get("userDataRoot");
    const paths = makeLandoPaths(userDataRoot === undefined ? {} : { userDataRoot });
    const pluginsRoot = options.pluginsRoot ?? paths.pluginsDir;
    const registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
    const registryClient = options.registryClient ?? defaultNpmRegistryClient(registryUrl);

    return (input) =>
      Effect.gen(function* () {
        const inventory = yield* inventoryFor(pluginsRoot, trustStore, registryClient);
        const plan = planUpdates({
          currentCoreVersion: input.currentCoreVersion,
          targetCoreVersion: input.targetCoreVersion,
          selection: input.combined ? "all" : "plugins",
          plugins: inventory,
        });
        const plannedRows = plan.rows.filter((row): row is PluginUpdatePlanRow => row.kind === "plugin");
        const plannedBlockCore = plan.rows.some((row) => row.kind === "core" && row.status === "blocked");
        if (input.dryRun) {
          return {
            rows: plannedRows,
            updatedPlugins: [],
            blockCore: plannedBlockCore,
            hasFailures: plan.hasFailures,
          };
        }

        const updatedPlugins: string[] = [];
        const rows: PluginUpdatePlanRow[] = [];
        for (const row of plannedRows) {
          if (row.status !== "update" || row.targetVersion === undefined || row.selector === undefined) {
            rows.push(row);
            continue;
          }
          const item = inventory.find((candidate) => candidate.name === row.name);
          const advertised = item?.metadata?.versions[row.targetVersion];
          if (item === undefined || advertised === undefined) {
            rows.push({ ...row, status: "failed", reason: "metadata-unavailable" });
            continue;
          }
          const exit = yield* Effect.exit(
            withPluginMutationLock(
              pluginsRoot,
              "meta:update",
              pluginAdd({
                spec: `${row.name}@${row.targetVersion}`,
                pluginsRoot,
                ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
                registryUrl,
                registryClient,
                ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
                ...(options.extractor === undefined ? {} : { extractor: options.extractor }),
                ...(options.bunSelfSpawner === undefined ? {} : { bunSelfSpawner: options.bunSelfSpawner }),
                trustStore: new Set(),
                requestedSelector: row.selector,
                expectedManifest: advertised,
                expectedCurrentVersion: row.currentVersion,
                mutationLockHeld: true,
                nonInteractive: true,
              }).pipe(
                Effect.provideService(ConfigService, config),
                Effect.provideService(PluginTrustStore, trustStore),
              ),
            ),
          );
          if (Exit.isSuccess(exit)) {
            updatedPlugins.push(row.name);
            rows.push(row);
          } else {
            rows.push({ ...row, status: "failed", reason: "apply-failed" });
          }
        }
        const appliedNames = new Set(updatedPlugins);
        const resultingInventory = inventory.map((item): PluginUpdateInventoryItem => {
          if (!appliedNames.has(item.name)) return { ...item, requestedSelector: item.currentVersion };
          const appliedRow = rows.find((row) => row.name === item.name);
          const targetVersion = appliedRow?.targetVersion;
          const advertised = targetVersion === undefined ? undefined : item.metadata?.versions[targetVersion];
          if (targetVersion === undefined || advertised === undefined) {
            return { ...item, requestedSelector: item.currentVersion };
          }
          const { currentRequires: _currentRequires, ...rest } = item;
          return {
            ...rest,
            currentVersion: targetVersion,
            requestedSelector: targetVersion,
            ...(advertised.requires === undefined ? {} : { currentRequires: advertised.requires }),
          };
        });
        const blockCore = input.combined
          ? planUpdates({
              currentCoreVersion: input.currentCoreVersion,
              targetCoreVersion: input.targetCoreVersion,
              selection: "all",
              plugins: resultingInventory,
            }).rows.some((row) => row.kind === "core" && row.status === "blocked")
          : false;
        return {
          rows,
          updatedPlugins,
          blockCore,
          hasFailures: plan.hasFailures || rows.some((row) => row.status === "failed"),
        };
      });
  });
