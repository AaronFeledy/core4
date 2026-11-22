import { makeLandoPaths, normalizeHostPlatform } from "@lando/paths";
import { causeMessage } from "@lando/sdk/errors";
import type { LandoPluginModule, ProviderPurgeHook, ProviderPurgeResult } from "@lando/sdk/plugins";
import { Effect, Result } from "effect";
import { canonicalMissingAppRoot } from "../operations/app-mutation-lock.ts";
import type { DiscoveredApp, PreparedUninstallCleanup } from "../operations/uninstall.ts";
import { artifactBuildStoreKey } from "../services/build-artifact-name.ts";
import { UninstallResourceCleanupError, uninstallCleanupFailure } from "./uninstall-cleanup-error.ts";
import { assertManagedStorageResolved } from "./uninstall-managed-storage.ts";
import { cleanupUninstallResources } from "./uninstall-resource-cleanup.ts";
import {
  type RuntimeExec,
  type UninstallRuntimeSeams,
  availableUninstallRuntimes,
  defaultRuntimeExec,
} from "./uninstall-runtime.ts";
import { assertUninstallSyncSafe } from "./uninstall-sync-preflight.ts";

export type UninstallProviderHook = { readonly providerId: string; readonly purge: ProviderPurgeHook };

export const providerPurgeHooks = (
  modules: readonly Pick<LandoPluginModule, "runtimeProviders">[],
): readonly UninstallProviderHook[] =>
  modules.flatMap((module) =>
    [...(module.runtimeProviders?.values() ?? [])].flatMap(({ id, purge }) =>
      purge === undefined ? [] : [{ providerId: id, purge }],
    ),
  );

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const summary = (result: ProviderPurgeResult): string =>
  [
    `${result.endpoint}: removed ${plural(result.removed.length, "resource")}.`,
    ...(result.retained.length === 0 ? [] : [`Kept: ${result.retained.join("; ")}.`]),
    ...(result.failed.length === 0 ? [] : [`Failed: ${result.failed.join("; ")}.`]),
    ...(result.outsideScope === 0
      ? []
      : [`Left ${plural(result.outsideScope, "resource")} from other installations in place.`]),
  ].join(" ");

export const makePrepareUninstallCleanup =
  (
    hooks: readonly UninstallProviderHook[],
    exec: RuntimeExec = defaultRuntimeExec,
    platform: NodeJS.Platform = process.platform,
    seams: UninstallRuntimeSeams = {},
  ) =>
  async (userDataRoot: string, userCacheRoot: string): Promise<PreparedUninstallCleanup> => {
    const env = seams.hostEnv ?? { ...process.env };
    const dataRoot = await Effect.runPromise(canonicalMissingAppRoot(userDataRoot));
    const buildStore = await Effect.runPromise(artifactBuildStoreKey(userCacheRoot));
    const input = {
      platform: normalizeHostPlatform({ platform, env: { ...env } }),
      env,
      dataRoot,
      buildStore,
    };
    const observed = await Effect.runPromise(
      Effect.forEach(hooks, ({ providerId, purge }) =>
        Effect.map(Effect.result(purge(input)), (result) => ({ providerId, result })),
      ),
    );
    const apps: DiscoveredApp[] = [];
    const details: string[] = [];
    const observations = observed.flatMap(({ providerId, result }) => {
      if (Result.isFailure(result)) {
        throw uninstallCleanupFailure(
          `Cannot inspect ${providerId} resources: ${causeMessage(result.failure)}`,
          result.failure,
        );
      }
      const found = result.success;
      if (!found) return [];
      switch (found.kind) {
        case "skipped":
          details.push(
            `${providerId}: no engine answered at ${found.endpoint} (${found.reason.replace(/\.$/u, "")}), so there was nothing to clean there.`,
          );
          return [];
        case "reachable": {
          const { container, network, volume, image } = found.counts;
          details.push(
            `${providerId} (${found.endpoint}): this installation owns ${plural(container, "container")}, ${plural(network, "network")}, ${plural(volume, "volume")}, and ${plural(image, "built image")} there.`,
          );
          apps.push(
            ...found.apps.map(({ appId, appRoot }) => ({
              appId,
              appRoot,
              appName: appId,
              providerId,
              services: [],
            })),
          );
          return [found];
        }
        default:
          return found satisfies never;
      }
    });
    const scope = "Resources from other Lando installations stay in place.";
    return {
      apps,
      detail: [...details, scope].join(" "),
      cleanup: async () => {
        const runtimes = await availableUninstallRuntimes({ userDataRoot, platform, exec, seams });
        if (platform === "win32")
          await assertUninstallSyncSafe({
            userDataRoot,
            runtimes,
            exec,
            hostSyncPresent: observations.some(({ syncPresent }) => syncPresent),
          });
        const results = await Effect.runPromise(Effect.forEach(observations, (found) => found.sweep()));
        const actual = [...details, ...results.map(summary), scope].join(" ");
        const retained = results.flatMap((result) => result.retained);
        const failed = results.flatMap((result) => result.failed);
        if (retained.length > 0 || failed.length > 0)
          throw new UninstallResourceCleanupError({
            message: `Incomplete provider cleanup. ${actual}`,
            removed: results.flatMap((result) => result.removed),
            retained,
            failed,
            remediation: "Inspect retained or failed resources and recover their data before retrying purge.",
          });
        for (const runtime of runtimes) {
          await cleanupUninstallResources(exec, runtime);
          await assertManagedStorageResolved(exec, runtime);
        }
        return actual;
      },
    };
  };

export const makeListDiscoveredApps =
  (
    exec: RuntimeExec = defaultRuntimeExec,
    platform: NodeJS.Platform = process.platform,
    seams: UninstallRuntimeSeams = {},
    hooks: readonly UninstallProviderHook[] = [],
  ) =>
  async (userDataRoot: string, userCacheRoot: string): Promise<readonly DiscoveredApp[]> =>
    (await makePrepareUninstallCleanup(hooks, exec, platform, seams)(userDataRoot, userCacheRoot)).apps;

export const makeCleanupDiscoveredApps =
  (
    userDataRoot = makeLandoPaths().roots.userDataRoot,
    exec: RuntimeExec = defaultRuntimeExec,
    platform: NodeJS.Platform = process.platform,
    seams: UninstallRuntimeSeams = {},
    hooks: readonly UninstallProviderHook[] = [],
  ) =>
  async (
    _apps: readonly DiscoveredApp[],
    userCacheRoot = makeLandoPaths().roots.userCacheRoot,
  ): Promise<string> =>
    (await makePrepareUninstallCleanup(hooks, exec, platform, seams)(userDataRoot, userCacheRoot)).cleanup();
