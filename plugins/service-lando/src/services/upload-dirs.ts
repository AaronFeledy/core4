import { isUploadDir } from "@lando/sdk/schema";
import { ServiceConfigIssue } from "./_feature-helpers.ts";

/**
 * Translate one validated `uploadDirs` path into a server regex body. Dots are
 * literal; `*` is one run of non-slash characters, including none. `**` is
 * rejected by the schema.
 */
export const uploadDirRegex = (path: string, index = 0): string => {
  if (!isUploadDir(path)) {
    throw new ServiceConfigIssue(
      ["uploadDirs", index],
      "uploadDirs path is not a safe webroot-relative directory.",
      "Use a webroot-relative path with only letters, digits, '.', '_', '/', '-' and single-segment '*'.",
    );
  }
  return path.replaceAll(".", "\\.").replaceAll("*", "[^/]*");
};
