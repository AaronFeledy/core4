import { posix, win32 } from "node:path";

/** Absolute path with no `.` / `..` segments; shared ownership-proof gate. */
export const isOwnershipRoot = (root: string): boolean =>
  (posix.isAbsolute(root) || win32.isAbsolute(root)) &&
  !root.split(/[\\/]/u).some((part) => part === "." || part === "..");
