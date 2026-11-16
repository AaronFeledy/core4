/**
 * Effect-free Node errno helpers, published as `@lando/sdk/errno` so code that only inspects a
 * thrown `code` does not import the full `@lando/sdk/errors` graph. `@lando/sdk/errors` re-exports them.
 */

/** True when `cause` structurally carries the Node errno `code` (e.g. `"ENOENT"`); `Error` instances are not required. */
export const isErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

/** The Node errno `code` string that `cause` structurally carries (e.g. `"EACCES"`), or `undefined`. */
export const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

/** Stable host-filesystem failure reasons shared by the classifier and FileIoError schema. */
export const FILE_IO_REASONS = [
  "permission-denied",
  "read-only",
  "no-space",
  "quota-exceeded",
  "not-found",
  "invalid-path",
  "io",
  "unknown",
] as const;

/** Classify a failure already identified as filesystem I/O by its owner; never infer its origin. */
export const fileIoReason = (cause: unknown): (typeof FILE_IO_REASONS)[number] => {
  switch (errnoCode(cause)) {
    case "EACCES":
    case "EPERM":
      return "permission-denied";
    case "EROFS":
      return "read-only";
    case "ENOSPC":
      return "no-space";
    case "EDQUOT":
      return "quota-exceeded";
    case "ENOENT":
      return "not-found";
    case "ENOTDIR":
    case "EISDIR":
    case "EEXIST":
    case "ELOOP":
    case "ENAMETOOLONG":
      return "invalid-path";
    case "EIO":
      return "io";
    default:
      return "unknown";
  }
};
