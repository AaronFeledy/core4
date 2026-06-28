/**
 * `@lando/core/paths` — the single, Effect-free, OCLIF-free primitive that owns
 * Lando's four roots and every path derived from them.
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
 *     → value from `config.yml`
 *     → platform default.
 *
 * The `userConfRoot` self-reference rule holds: `config.yml` is located from the
 * conf root that was fixed by option/env/default, and a `userConfRoot` value
 * inside `config.yml` never relocates that same load. The other three roots read
 * `config.yml` only after the conf root is fixed, and the env short-circuit
 * keeps the conf/data/cache fast path IO-free when the matching `LANDO_*` env
 * var is set.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as hostJoin } from "node:path";

import type { HostPlatform } from "@lando/sdk/schema";
// Type-only: keeps `effect` off the level-`none` cold-start fast path. The
// canonical shapes live in `@lando/sdk/services`; this module owns only the
// runtime resolvers and re-exports the types for `@lando/core/paths` consumers.
import type { LandoPaths, LandoRoots, RootOverrides } from "@lando/sdk/services";

import { envOverlay, resolveConfigFileRoot } from "./overlay.ts";
import { parseMinimalYaml } from "./yaml-min.ts";

export type { LandoPaths, LandoRoots, RootOverrides } from "@lando/sdk/services";

// --- platform resolution -----------------------------------------------------

/**
 * Resolve the {@link HostPlatform} that selects the platform-default
 * column. WSL is detected as `linux` + (`WSL_DISTRO_NAME` | `WSL_INTEROP`); any
 * unknown platform falls back to the Linux column.
 */
export const normalizeHostPlatform = (
  input: { platform?: string | undefined; env?: Record<string, string | undefined> | undefined } = {},
): HostPlatform => {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  if (platform === "wsl") return "wsl";
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  if (platform === "linux" && (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined))
    return "wsl";
  return "linux";
};

// --- platform-aware path joining --------------------------------------------

// `node:path` resolves separators against the HOST OS, so it cannot build a
// win32 path on a posix host (and vice versa). Derived builders must honor the
// RESOLVED platform's separator, so we join manually with a tiny, deterministic
// helper rather than `node:path`'s host-bound `join`.
const separatorFor = (platform: HostPlatform): string => (platform === "win32" ? "\\" : "/");

const joinFor =
  (platform: HostPlatform) =>
  (...segments: ReadonlyArray<string>): string => {
    const sep = separatorFor(platform);
    const trailing = /[\\\/]+$/u;
    const leading = /^[\\\/]+/u;
    const parts: string[] = [];
    for (const [index, raw] of segments.entries()) {
      const segment =
        index === 0 ? raw.replace(trailing, "") : raw.replace(leading, "").replace(trailing, "");
      if (segment === "" && index !== 0) continue;
      parts.push(segment);
    }
    return parts.join(sep);
  };

// --- platform default matrix -------------------------------------------------

const homeOf = (overrides: RootOverrides): string => {
  if (overrides.home !== undefined) return overrides.home;
  const env = overrides.env ?? process.env;
  return env.HOME ?? env.USERPROFILE ?? ".";
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value !== "" ? value : undefined;

interface DefaultMatrix {
  readonly userConfRoot: string;
  readonly userCacheRoot: string;
  readonly userDataRoot: string;
  readonly systemPluginRoot: string;
}

const platformDefaults = (platform: HostPlatform, overrides: RootOverrides): DefaultMatrix => {
  const env = overrides.env ?? process.env;
  const home = homeOf(overrides);
  const j = joinFor(platform);

  if (platform === "darwin") {
    const appSupport = j(home, "Library", "Application Support", "Lando");
    return {
      userConfRoot: appSupport,
      userCacheRoot: j(home, "Library", "Caches", "Lando"),
      userDataRoot: appSupport,
      systemPluginRoot: "/usr/local/share/lando",
    };
  }

  if (platform === "win32") {
    const appData = nonEmpty(env.APPDATA) ?? j(home, "AppData", "Roaming");
    const localAppData = nonEmpty(env.LOCALAPPDATA) ?? j(home, "AppData", "Local");
    const programData = nonEmpty(env.PROGRAMDATA) ?? "C:\\ProgramData";
    return {
      userConfRoot: j(appData, "Lando"),
      userCacheRoot: j(localAppData, "Lando", "Cache"),
      userDataRoot: j(localAppData, "Lando", "Data"),
      systemPluginRoot: j(programData, "Lando"),
    };
  }

  // linux / wsl / unknown → Linux/BSD XDG column.
  const xdgConfig = nonEmpty(env.XDG_CONFIG_HOME) ?? j(home, ".config");
  const xdgCache = nonEmpty(env.XDG_CACHE_HOME) ?? j(home, ".cache");
  const xdgData = nonEmpty(env.XDG_DATA_HOME) ?? j(home, ".local", "share");
  return {
    userConfRoot: j(xdgConfig, "lando"),
    userCacheRoot: j(xdgCache, "lando"),
    userDataRoot: j(xdgData, "lando"),
    systemPluginRoot: "/usr/local/share/lando",
  };
};

// --- config.yml read (lazy, cached per resolve) ------------------------------

/**
 * Read a top-level string key from `<confRoot>/config.yml` without constructing
 * Effect or `ConfigService`. Uses the same YAML subset parser the config layer
 * uses. Any missing/unreadable/malformed file (or non-string value) yields
 * `undefined`, exactly like the merged config layer would. The file is read at
 * most once per `resolveLandoRoots` call via the supplied lazy reader.
 */
const makeConfigReader = (confRoot: string): ((key: string) => string | undefined) => {
  let loaded = false;
  let parsed: Record<string, unknown> = {};
  const load = (): void => {
    if (loaded) return;
    loaded = true;
    let text: string;
    try {
      // The file is read on the HOST OS, so join with the host-bound separator.
      text = readFileSync(hostJoin(confRoot, "config.yml"), "utf8");
    } catch {
      return;
    }
    try {
      parsed = parseMinimalYaml(text);
    } catch {
      parsed = {};
    }
  };
  return (key: string): string | undefined => {
    load();
    const value = parsed[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
};

// --- root resolution ---------------------------------------------------------

/**
 * Resolve the four roots in order per root: explicit override →
 * `LANDO_*` env → `config.yml` → platform default. The conf root is fixed first
 * (option → env → default); `config.yml` is then located from it, and a
 * `userConfRoot` value inside `config.yml` never relocates that load.
 */
export const resolveLandoRoots = (overrides: RootOverrides = {}): LandoRoots => {
  const env = overrides.env ?? process.env;
  const platform = normalizeHostPlatform({ platform: overrides.platform, env });
  const defaults = platformDefaults(platform, overrides);

  const envConfRoot = nonEmpty(env.LANDO_USER_CONF_ROOT);
  const baseConfRoot = envConfRoot ?? defaults.userConfRoot;
  const userConfRoot =
    overrides.userConfRoot ??
    resolveConfigFileRoot(baseConfRoot, envOverlay(env), { ...env, LANDO_USER_CONF_ROOT: envConfRoot });

  const readConfig = makeConfigReader(userConfRoot);

  const resolveOther = (
    overrideValue: string | undefined,
    envValue: string | undefined,
    configKey: keyof LandoRoots,
    defaultValue: string,
  ): string => {
    if (overrideValue !== undefined) return overrideValue;
    const fromEnv = nonEmpty(envValue);
    if (fromEnv !== undefined) return fromEnv; // env short-circuit: no config.yml read
    return readConfig(configKey) ?? defaultValue;
  };

  return {
    userConfRoot,
    userCacheRoot: resolveOther(
      overrides.userCacheRoot,
      env.LANDO_USER_CACHE_ROOT,
      "userCacheRoot",
      defaults.userCacheRoot,
    ),
    userDataRoot: resolveOther(
      overrides.userDataRoot,
      env.LANDO_USER_DATA_ROOT,
      "userDataRoot",
      defaults.userDataRoot,
    ),
    systemPluginRoot: resolveOther(
      overrides.systemPluginRoot,
      env.LANDO_SYSTEM_PLUGIN_ROOT,
      "systemPluginRoot",
      defaults.systemPluginRoot,
    ),
  };
};

// --- app-name sanitization + app-root fingerprint ----------------------------

const sanitizeAppName = (appName: string): string => {
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

/**
 * Resolve every root and return builders for every derived path in the catalog.
 * App-scoped builders sanitize app names and fingerprint the app root so two
 * apps sharing a `name:` never collide.
 */
export const makeLandoPaths = (overrides: RootOverrides = {}): LandoPaths => {
  const env = overrides.env ?? process.env;
  const platform = normalizeHostPlatform({ platform: overrides.platform, env });
  const roots = resolveLandoRoots(overrides);
  const j = joinFor(platform);

  const { userConfRoot, userCacheRoot, userDataRoot } = roots;

  const appCacheDir = (appName: string, appRoot: string): string =>
    j(userCacheRoot, "apps", `${sanitizeAppName(appName)}-${appRootFingerprint(appRoot)}`);

  return {
    roots,
    platform,
    // userData-scoped
    pluginsDir: j(userDataRoot, "plugins"),
    appPluginsDir: (appId: string) => j(userDataRoot, "apps", appId, "plugins"),
    pluginAuthFile: j(userDataRoot, "plugin-auth.json"),
    binDir: j(userDataRoot, "bin"),
    keysDir: j(userDataRoot, "keys"),
    certsDir: j(userDataRoot, "certs"),
    runtimeDir: j(userDataRoot, "runtime"),
    runtimeBinDir: j(userDataRoot, "runtime", "bin"),
    runtimeRunDir: j(userDataRoot, "runtime", "run"),
    providerSocketPath: j(userDataRoot, "runtime", "run", "podman.sock"),
    providerPidPath: j(userDataRoot, "runtime", "run", "podman.pid"),
    globalAppRoot: j(userDataRoot, "global"),
    snapshotsDir: j(userDataRoot, "snapshots"),
    appSnapshotsDir: (appId: string) => j(userDataRoot, "snapshots", appId),
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
    fileSyncSessionsDir: j(userCacheRoot, "file-sync", "sessions"),
    // userConf-scoped
    configFile: j(userConfRoot, "config.yml"),
    configDir: userConfRoot,
    globalConfigFile: j(userConfRoot, "global.config.yml"),
    pluginTrustFile: j(userConfRoot, "plugin-trust.yml"),
  };
};
