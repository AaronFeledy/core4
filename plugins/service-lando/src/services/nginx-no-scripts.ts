import { isNginxNoScriptPath } from "@lando/sdk/schema";

/**
 * Translate one validated `noScripts` path into the regex body interpolated
 * after `^/` in the generated deny location. Dots are literal; `*` is one
 * non-slash path segment. `**` is rejected by the schema, not collapsed here.
 */
export const nginxNoScriptRegex = (path: string): string => {
  if (!isNginxNoScriptPath(path)) {
    throw new Error("nginx noScripts path is not a safe webroot-relative URI.");
  }
  return path.replaceAll(".", "\\.").replaceAll("*", "[^/]+");
};

/**
 * Deny locations that must sit before the PHP FastCGI location so upload
 * trees cannot execute `.php` (including PATH_INFO). `~*` keeps the match
 * case-insensitive on macOS bind mounts.
 */
export const nginxNoScriptDenyLocations = (
  paths: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
  (paths ?? []).map((path) => `  location ~* ^/${nginxNoScriptRegex(path)}/.*\\.php(/|$) { deny all; }`);
