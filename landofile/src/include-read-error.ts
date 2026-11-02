import { constants } from "node:os";
import { includeError } from "./include-guard.ts";

export const includeReadError = (path: string, source: string, cause: unknown) => {
  const code =
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    Object.hasOwn(constants.errno, cause.code)
      ? cause.code
      : undefined;
  let reason: string;
  switch (code) {
    case "ENOENT":
      reason = "does not exist";
      break;
    case "EACCES":
    case "EPERM":
      reason = "is not readable (permission denied)";
      break;
    case "EISDIR":
      reason = "is a directory";
      break;
    default:
      reason = `could not be read${code === undefined ? "" : ` (${code})`}`;
  }
  return includeError({
    message: `Include ${source}${source === path ? "" : ` at ${path}`} ${reason}.`,
    source,
    kind: "fetch-failed",
  });
};
