import { isNginxNoScriptPath } from "@lando/sdk/schema";
import { ServiceConfigIssue } from "./_feature-helpers.ts";

/**
 * Translate one validated `noScripts` path into the regex body interpolated
 * after `^/` in the generated deny location. Dots are literal; `*` is one
 * run of non-slash characters, including none. `**` is rejected by the schema.
 */
export const nginxNoScriptRegex = (path: string, index = 0): string => {
  if (!isNginxNoScriptPath(path)) {
    throw new ServiceConfigIssue(
      ["noScripts", index],
      "nginx noScripts path is not a safe webroot-relative URI.",
      "Use a webroot-relative path with only letters, digits, '.', '_', '/', '-' and single-segment '*'.",
    );
  }
  return path.replaceAll(".", "\\.").replaceAll("*", "[^/]*");
};

/**
 * Deny locations that must sit before the PHP FastCGI location so upload
 * trees cannot execute `.php` (including PATH_INFO). `~*` keeps the match
 * case-insensitive on macOS bind mounts. Match URI-decoded line breaks too:
 * PCRE's `.` would let an uploaded filename containing LF bypass the denial.
 */
export const nginxNoScriptDenyLocations = (paths: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  (paths ?? []).map(
    (path, index) => `  location ~* ^/${nginxNoScriptRegex(path, index)}/[\\s\\S]*\\.php(/|$) { deny all; }`,
  );
