import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import type { DiscoveredApp } from "../operations/uninstall.ts";
import { uninstallCleanupFailure } from "./uninstall-cleanup-error.ts";
import { assertManagedStorageResolved } from "./uninstall-managed-storage.ts";
import { cleanupUninstallResources } from "./uninstall-resource-cleanup.ts";
import {
  type RuntimeExec,
  availableUninstallRuntimes,
  defaultRuntimeExec,
  runUninstallRuntime,
} from "./uninstall-runtime.ts";
import { assertUninstallSyncSafe } from "./uninstall-sync-preflight.ts";

const assertNoRecordedUserApps = async (userDataRoot: string): Promise<void> => {
  const plugins = makeLandoPaths({ userDataRoot }).pluginsDir;
  const directories: string[] = [];
  for (const base of [join(plugins, "@lando"), join(userDataRoot, "providers")]) {
    let providers: readonly string[];
    try {
      providers = await readdir(base);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    for (const provider of providers.filter((name) => name.startsWith("provider-")))
      directories.push(
        join(base, provider, base === join(userDataRoot, "providers") ? "apps" : "applied-plans"),
      );
  }
  for (const directory of directories) {
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const envelope: unknown = JSON.parse(await readFile(join(directory, entry), "utf8"));
      const data: unknown =
        typeof envelope === "object" && envelope !== null
          ? (Reflect.get(envelope, "data") ?? Reflect.get(envelope, "plan"))
          : undefined;
      if (typeof data !== "object" || data === null || Reflect.get(data, "id") !== "global")
        throw uninstallCleanupFailure(
          "neither docker nor podman is available to verify recorded Lando apps; preserve their state and restore the runtime.",
        );
    }
  }
};

export const makeListDiscoveredApps =
  (exec: RuntimeExec = defaultRuntimeExec, platform: NodeJS.Platform = process.platform) =>
  async (userDataRoot: string, _userCacheRoot: string): Promise<readonly DiscoveredApp[]> => {
    const runtimes = await availableUninstallRuntimes({ userDataRoot, platform, exec });
    if (runtimes.length === 0) await assertNoRecordedUserApps(userDataRoot);
    const apps: DiscoveredApp[] = [];
    for (const runtime of runtimes) {
      const ids = new Set<string>();
      for (const label of ["dev.lando.app", "com.lando.app"]) {
        const result = await runUninstallRuntime(exec, runtime, {
          args: ["ps", "--filter", `label=${label}`, "--format", `{{.Label "${label}"}}`],
        });
        for (const id of result.stdout.split(/\r?\n/u).filter(Boolean)) ids.add(id);
      }
      for (const appId of ids)
        apps.push({
          appId,
          appName: appId,
          providerId: runtime.providerId,
          appRoot: "(unknown)",
          services: [],
        });
    }
    return apps;
  };

export const makeCleanupDiscoveredApps =
  (
    userDataRoot = makeLandoPaths().roots.userDataRoot,
    exec: RuntimeExec = defaultRuntimeExec,
    platform: NodeJS.Platform = process.platform,
  ) =>
  async (_apps: readonly DiscoveredApp[]): Promise<void> => {
    const runtimes = await availableUninstallRuntimes({ userDataRoot, platform, exec });
    if (platform === "win32") await assertUninstallSyncSafe({ userDataRoot, runtimes, exec });
    for (const runtime of runtimes) await cleanupUninstallResources(exec, runtime);
    for (const runtime of runtimes) await assertManagedStorageResolved(exec, runtime);
  };
