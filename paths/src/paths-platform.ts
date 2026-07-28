/**
 * `@lando/core/paths` platform primitives — HostPlatform detection, the
 * platform-aware path joiner, and the platform-default root matrix.
 *
 * This is a leaf of the paths primitive: it imports neither `effect` nor
 * `@oclif/core` (type-only `@lando/sdk` only), depends on nothing else in
 * `@lando/core/paths`, and owns every decision that varies by the RESOLVED
 * {@link HostPlatform} rather than the host OS. `paths.ts` composes these into
 * root resolution and the derived-path catalog.
 */

import type { HostPlatform } from "@lando/sdk/schema";
import type { RootOverrides } from "@lando/sdk/services";

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

export const joinFor =
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

export const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value !== "" ? value : undefined;

interface DefaultMatrix {
  readonly userConfRoot: string;
  readonly userCacheRoot: string;
  readonly userDataRoot: string;
  readonly systemPluginRoot: string;
}

export const platformDefaults = (platform: HostPlatform, overrides: RootOverrides): DefaultMatrix => {
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
