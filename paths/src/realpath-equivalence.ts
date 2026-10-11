import { realpathSync } from "node:fs";
import path from "node:path";

const usesWin32Path = (value: string): boolean => /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");

/**
 * Resolve symlinks, junctions and short names before comparing. Native realpath
 * preserves case-sensitive directories, including those on Windows and macOS.
 * Reject differing spellings containing `..`: Bun's realpath collapses those
 * before following symlinks, so it cannot prove their filesystem equivalence.
 */
export const sameRealpath = (left: string, right: string): boolean => {
  if (left === right) return true;
  const win32 = usesWin32Path(left) || usesWin32Path(right);
  const segments = win32 ? /[\\/]/u : /\//u;
  if (left.split(segments).includes("..") || right.split(segments).includes("..")) return false;
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if (error.code !== "ENOENT") return false;
    const pathApi = win32 ? path.win32 : path.posix;
    const normalize = (value: string) => {
      const normalized = pathApi.normalize(value);
      return win32 ? normalized.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase()) : normalized;
    };
    return normalize(left) === normalize(right);
  }
};
