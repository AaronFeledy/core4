/**
 * `@lando/paths` — the single, Effect-free, OCLIF-free primitive that owns
 * Lando's four roots and every path derived from them. Core re-exports this
 * module as the semver-stable `@lando/core/paths` subpath.
 *
 * This module constructs no `Context.Service` and imports neither `effect` nor
 * `@oclif/core`, so it is safe on the level-`none` cold-start fast path,
 * inside `scripts/`, and for embedding hosts / plugin utilities that need a path
 * before (or without) a runtime. Only a type-only `@lando/sdk` import is used.
 *
 * Resolution order, per root:
 *   explicit `RootOverrides` field
 *     → `LANDO_USER_CONF_ROOT` / `LANDO_USER_CACHE_ROOT` / `LANDO_USER_DATA_ROOT`
 *       / `LANDO_SYSTEM_PLUGIN_ROOT`
 *     → value from `config.yml`, then lexical `config.d/*.yml` overlays
 *     → platform default.
 *
 * The `userConfRoot` self-reference rule holds: `config.yml` is located from the
 * conf root that was fixed by option/env/default, and a `userConfRoot` value
 * inside user files never relocates that same load. Host config shares the
 * explicit-override tier; disabling sources.env also disables LANDO root env
 * variables. Platform identity variables still determine platform defaults.
 */

import { createHash } from "node:crypto";

// Type-only: keeps `effect` off the level-`none` cold-start fast path. The
// canonical shapes live in `@lando/sdk/services`; this module owns only the
// runtime resolvers and re-exports the types for `@lando/paths` consumers.
import type { HostPlatform } from "@lando/sdk/schema";
import type { LandoPaths, LandoRoots, RootOverrides } from "@lando/sdk/services";

import {
  type ConfigLayer,
  type ConfigSourceInputs,
  mergeGlobalConfigSources,
  readGlobalConfigSources,
} from "./config-sources.ts";
import { joinFor, normalizeHostPlatform } from "./paths-platform.ts";

export type { LandoPaths, LandoRoots, RootOverrides } from "@lando/sdk/services";
export { isPathWithin } from "./containment.ts";
export { sameRealpath } from "./realpath-equivalence.ts";
export { normalizeHostPlatform } from "./paths-platform.ts";
export { resolveHostHome } from "./paths-platform.ts";

// --- root resolution ---------------------------------------------------------

const resolveLandoRootsForPlatform = (overrides: PathInputs, platform: HostPlatform): LandoRoots => {
  const layers = readGlobalConfigSources({
    env: overrides.env ?? process.env,
    sources: overrides.sources ?? { user: true, env: true },
    host: overrides.host,
    rootOverrides: { ...overrides, platform },
    platform,
  });
  return resolveLandoRootsFromSources(layers);
};

export const resolveLandoRootsFromSources = (layers: readonly ConfigLayer[]): LandoRoots => {
  const merged = mergeGlobalConfigSources(layers).tree;
  const defaults = layers[0]?.tree ?? {};
  const root = (key: keyof LandoRoots): string => {
    const value = merged[key];
    const fallback = defaults[key];
    return typeof value === "string" && value !== "" ? value : typeof fallback === "string" ? fallback : "";
  };
  return {
    userConfRoot: root("userConfRoot"),
    userCacheRoot: root("userCacheRoot"),
    userDataRoot: root("userDataRoot"),
    systemPluginRoot: root("systemPluginRoot"),
  };
};

export type PathInputs = RootOverrides & Pick<Partial<ConfigSourceInputs>, "host" | "sources">;

export const resolveLandoRoots = (overrides: PathInputs = {}): LandoRoots => {
  const env = overrides.env ?? process.env;
  const platform = normalizeHostPlatform({ platform: overrides.platform, env });
  return resolveLandoRootsForPlatform(overrides, platform);
};

// --- app-name sanitization + app-root fingerprint ----------------------------

export const sanitizeAppName = (appName: string): string => {
  const cleaned = appName.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  // Reject all-dot names (`.`, `..`, `...`) so they can't escape the
  // `<cacheRoot>/apps/<name>/` namespace via path normalization.
  if (cleaned.length === 0 || /^\.+$/u.test(cleaned)) return "unnamed";
  return cleaned;
};

// Short, stable fingerprint of an absolute app root path. Two apps that share
// `name:` but live in different directories must not overwrite each other's
// app-scoped caches; 12 hex chars (48 bits) avoids collisions across one user's
// filesystem while keeping the dir name grep-friendly.
const appRootFingerprint = (appRoot: string): string =>
  createHash("sha256").update(appRoot).digest("hex").slice(0, 12);

// --- derived path factory ----------------------------------------------------

export const managedFileLedgerPath = (
  userDataRoot: string,
  appId: string,
  platform = normalizeHostPlatform(),
): string => joinFor(platform)(userDataRoot, "managed-files", appId, "ledger.json");

export const globalAppRootPath = (userDataRoot: string, platform = normalizeHostPlatform()): string =>
  joinFor(platform)(userDataRoot, "global");

/**
 * Resolve every root and return builders for every derived path in the catalog.
 * App-scoped builders sanitize app names and fingerprint the app root so two
 * apps sharing a `name:` never collide.
 */
export const makeLandoPaths = (overrides: PathInputs = {}): LandoPaths => {
  const env = overrides.env ?? process.env;
  const platform = normalizeHostPlatform({ platform: overrides.platform, env });
  const roots = resolveLandoRootsForPlatform(overrides, platform);
  return makeLandoPathsFromRoots(roots, platform);
};

/** Build derived paths from an already resolved runtime snapshot without reading sources. */
export const makeLandoPathsFromRoots = (roots: LandoRoots, platform: HostPlatform): LandoPaths => {
  const j = joinFor(platform);

  const { userConfRoot, userCacheRoot, userDataRoot, systemPluginRoot } = roots;

  const appCacheDir = (appName: string, appRoot: string): string =>
    j(userCacheRoot, "apps", `${sanitizeAppName(appName)}-${appRootFingerprint(appRoot)}`);

  return {
    roots,
    platform,
    // userData-scoped
    pluginsDir: j(userDataRoot, "plugins"),
    pluginStateDir: (pluginId: string) => j(userDataRoot, "plugins", pluginId),
    appPluginsDir: (appId: string) => j(userDataRoot, "apps", appId, "plugins"),
    pluginAuthFile: j(userDataRoot, "plugin-auth.json"),
    binDir: j(userDataRoot, "bin"),
    installRecordFile: j(userDataRoot, "install", "record.json"),
    keysDir: j(userDataRoot, "keys"),
    certsDir: j(userDataRoot, "certs"),
    runtimeDir: j(userDataRoot, "runtime"),
    runtimeBinDir: j(userDataRoot, "runtime", "bin"),
    runtimeRunDir: j(userDataRoot, "runtime", "run"),
    runtimeStorageDir: j(userDataRoot, "runtime", "storage"),
    runtimeConfigDir: j(userDataRoot, "runtime", "config"),
    hostProxyRunRoot: j(userDataRoot, "run"),
    hostProxyRunDir: (appId: string, appRoot: string) =>
      j(userDataRoot, "run", `${sanitizeAppName(appId)}-${appRootFingerprint(appRoot)}`),
    agentRelayRunDir: (kind: "ssh" | "gpg", appId: string, appRoot: string) =>
      j(userDataRoot, "run", `${sanitizeAppName(appId)}-${appRootFingerprint(appRoot)}-${kind}-agent`),
    providerSocketPath: j(userDataRoot, "runtime", "run", "podman.sock"),
    providerPidPath: j(userDataRoot, "runtime", "run", "podman.pid"),
    globalAppRoot: globalAppRootPath(userDataRoot, platform),
    snapshotsDir: j(userDataRoot, "snapshots"),
    appSnapshotsDir: (appId: string) => j(userDataRoot, "snapshots", appId),
    managedFileLedger: (appId: string) => managedFileLedgerPath(userDataRoot, appId, platform),
    // userCache-scoped
    logsDir: j(userCacheRoot, "logs"),
    toolDownloadsDir: (toolId: string) => j(userCacheRoot, "tool-downloads", toolId),
    scratchDir: j(userCacheRoot, "scratch"),
    scratchRegistryFile: j(userCacheRoot, "scratch", "registry.bin"),
    scratchRegistryLockFile: j(userCacheRoot, "scratch", "registry.lock"),
    tunnelRegistryFile: j(userCacheRoot, "tunnels", "registry.bin"),
    tunnelRunDir: j(userDataRoot, "run", "tunnels"),
    appCacheDir,
    appPlanCacheFile: (appName: string, appRoot: string) => j(appCacheDir(appName, appRoot), "plan.bin"),
    shellHistoryFile: (appName: string, appRoot: string) =>
      j(userCacheRoot, "shell", `${sanitizeAppName(appName)}-${appRootFingerprint(appRoot)}`, "history"),
    fileSyncSessionsDir: j(userCacheRoot, "file-sync", "sessions"),
    // systemPluginRoot-scoped
    systemPluginsDir: j(systemPluginRoot, "plugins"),
    // userConf-scoped
    configFile: j(userConfRoot, "config.yml"),
    configDir: userConfRoot,
    userIncludesDir: j(userConfRoot, "includes"),
    globalConfigFile: j(userConfRoot, "global.config.yml"),
    pluginTrustFile: j(userConfRoot, "plugin-trust.yml"),
  };
};
