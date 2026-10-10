import { realpathSync } from "node:fs";
import path from "node:path";

const usesWin32Path = (value: string): boolean => /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");

const pathApiFor = (left: string, right: string) =>
  usesWin32Path(left) || usesWin32Path(right) ? path.win32 : path.posix;

const normalizeLexical = (value: string, pathApi: path.PlatformPath, win32: boolean): string => {
  const normalized = pathApi.normalize(value);
  return win32 ? normalized.toLowerCase() : normalized;
};

const realpathOrUndefined = (value: string): string | undefined => {
  try {
    return realpathSync.native(value);
  } catch {
    return undefined;
  }
};

/**
 * True when two filesystem spellings name the same path. Lexical aliases
 * (separators, `.`, `..`) match without IO: `path.normalize` collapses `..`
 * before any realpath call, so `foo/../bar` equals `bar` even when `foo` is
 * a symlink that would change the resolved parent. Windows 8.3 names,
 * junctions, and drive-letter case match when native `realpath` can resolve
 * both sides (`realpathSync.native`, the same resolution identity uses).
 * Comparison is case-insensitive on win32 paths.
 */
export const sameRealpath = (left: string, right: string): boolean => {
  if (left === right) return true;
  const win32 = usesWin32Path(left) || usesWin32Path(right);
  const pathApi = pathApiFor(left, right);
  if (normalizeLexical(left, pathApi, win32) === normalizeLexical(right, pathApi, win32)) return true;
  const leftReal = realpathOrUndefined(left);
  const rightReal = realpathOrUndefined(right);
  if (leftReal === undefined || rightReal === undefined) return false;
  return win32 ? leftReal.toLowerCase() === rightReal.toLowerCase() : leftReal === rightReal;
};
