/** True when `cause` structurally carries the Node errno `code` (e.g. `"ENOENT"`); `Error` instances are not required. */
export const isErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
