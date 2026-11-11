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
