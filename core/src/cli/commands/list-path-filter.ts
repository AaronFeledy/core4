import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, win32 } from "node:path";

import { isPathWithin } from "@lando/paths";

const homeRoot = (): string => process.env.HOME ?? process.env.USERPROFILE ?? homedir();

/** Expand `~` / `~/...` the same way other host path inputs do. */
const expandHome = (value: string): string => {
  if (value === "~") return homeRoot();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homeRoot(), value.slice(2));
  return value;
};

/** Absolute, `~`, `.` / `..`, `./` / `../`, or any value with a path separator. */
export const isPathLikeFilter = (filter: string): boolean => {
  if (filter === "." || filter === "..") return true;
  if (filter.startsWith("~")) return true;
  if (
    filter.startsWith("./") ||
    filter.startsWith("../") ||
    filter.startsWith(".\\") ||
    filter.startsWith("..\\")
  ) {
    return true;
  }
  if (isAbsolute(filter) || win32.isAbsolute(filter)) return true;
  return filter.includes("/") || filter.includes("\\");
};

/** Realpath of an existing path-like filter after home expansion and cwd resolve. */
export const resolveExistingAppsListPath = async (
  filter: string,
  cwd: string = process.cwd(),
): Promise<string | undefined> => {
  try {
    return await realpath(resolve(cwd, expandHome(filter)));
  } catch {
    return undefined;
  }
};

export const appRootMatchesPathFilter = (
  appRoot: string,
  filter: string,
  resolvedFilter: string | undefined,
): boolean => {
  if (isPathLikeFilter(filter) && resolvedFilter !== undefined) {
    if (appRoot === "") return false;
    return isPathWithin(resolvedFilter, appRoot);
  }
  return appRoot.includes(filter);
};
