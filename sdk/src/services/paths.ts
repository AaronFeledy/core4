import { Context } from "effect";

import type { HostPlatform } from "../schema/index.ts";

/**
 * The four roots Lando resolves. Every Lando-owned path is derived from one of
 * these; re-deriving `$HOME`/XDG/`%APPDATA%` fallbacks or hand-joining
 * root-relative paths outside the Paths primitive is forbidden.
 */
export interface LandoRoots {
  readonly userConfRoot: string;
  readonly userCacheRoot: string;
  readonly userDataRoot: string;
  readonly systemPluginRoot: string;
}

/**
 * Per-root overrides plus deterministic `platform`/`env`/`home` injection for
 * testing and host isolation. Every field is optional; omitted fields fall
 * through to env -> `config.yml` -> platform default.
 */
export interface RootOverrides {
  readonly userConfRoot?: string;
  readonly userCacheRoot?: string;
  readonly userDataRoot?: string;
  readonly systemPluginRoot?: string;
  readonly platform?: string;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
}

/**
 * Resolved roots, the active platform, and builders for every Lando-owned
 * derived path. App-scoped builders sanitize app names and fingerprint the app
 * root so two apps that share a `name:` never collide.
 */
export interface LandoPaths {
  readonly roots: LandoRoots;
  readonly platform: HostPlatform;
  // userData-scoped
  readonly pluginsDir: string;
  readonly appPluginsDir: (appId: string) => string;
  readonly pluginAuthFile: string;
  readonly binDir: string;
  readonly keysDir: string;
  readonly certsDir: string;
  readonly runtimeDir: string;
  readonly runtimeBinDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeStorageDir: string;
  readonly runtimeConfigDir: string;
  readonly providerSocketPath: string;
  readonly providerPidPath: string;
  readonly globalAppRoot: string;
  readonly snapshotsDir: string;
  readonly appSnapshotsDir: (appId: string) => string;
  readonly managedFileLedger: (appId: string) => string;
  readonly toolDownloadsDir: (toolId: string) => string;
  // userCache-scoped
  readonly logsDir: string;
  readonly scratchDir: string;
  readonly scratchRegistryFile: string;
  readonly scratchRegistryLockFile: string;
  readonly tunnelRegistryFile: string;
  readonly tunnelRunDir: string;
  readonly appCacheDir: (appName: string, appRoot: string) => string;
  readonly appPlanCacheFile: (appName: string, appRoot: string) => string;
  readonly fileSyncSessionsDir: string;
  // userConf-scoped
  readonly configFile: string;
  readonly configDir: string;
  readonly globalConfigFile: string;
  readonly pluginTrustFile: string;
}

/**
 * `PathsService` — the runtime DI tag that exposes the resolved {@link LandoPaths}
 * (the four roots, the active platform, and every derived-path builder).
 * `PathsService` is host/test-overridable but is NOT a plugin contribution
 * surface (there is no `provides.paths` manifest key).
 */
export class PathsService extends Context.Tag("@lando/core/PathsService")<PathsService, LandoPaths>() {}
