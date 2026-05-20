import { createHash } from "node:crypto";
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

// Short, stable fingerprint of an absolute app root path. Two apps that
// share `name:` but live in different directories must not overwrite each
// other's plan cache; 12 hex chars (48 bits) is enough to avoid collisions
// across one user's filesystem while keeping the dir name grep-friendly.
const appRootFingerprint = (appRoot: string): string =>
  createHash("sha256").update(appRoot).digest("hex").slice(0, 12);

export const appPlanCachePath = (cacheRoot: string, appName: string, appRoot: string): string =>
  `${trimTrailingSlashes(cacheRoot)}/apps/${sanitizeAppName(appName)}-${appRootFingerprint(appRoot)}/plan.bin`;
