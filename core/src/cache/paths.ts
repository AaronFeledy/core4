import { join } from "node:path";

const DEFAULT_CACHE_HOME = `${process.env.HOME ?? "."}/.cache`;

export const resolveUserCacheRoot = (): string => {
  if (process.env.LANDO_USER_CACHE_ROOT !== undefined) return process.env.LANDO_USER_CACHE_ROOT;
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg ?? DEFAULT_CACHE_HOME, "lando");
};

const trimTrailingSlashes = (path: string): string => path.replace(/\/+$/u, "");

const sanitizeAppName = (appName: string): string => {
  const cleaned = appName.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  // Reject all-dot names (`.`, `..`, `...`) so they can't escape the
  // `<cacheRoot>/apps/<name>/` namespace via path normalization.
  if (cleaned.length === 0 || /^\.+$/u.test(cleaned)) return "unnamed";
  return cleaned;
};

export const pluginCommandCachePath = (cacheRoot: string): string =>
  `${trimTrailingSlashes(cacheRoot)}/plugin-command-cache.bin`;

export const appCommandCachePath = (cacheRoot: string, appName: string): string =>
  `${trimTrailingSlashes(cacheRoot)}/apps/${sanitizeAppName(appName)}/commands.bin`;
