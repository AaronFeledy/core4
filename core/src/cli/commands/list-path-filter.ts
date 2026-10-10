import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { isPathWithin } from "@lando/paths";

const homeRoot = (): string => process.env.HOME ?? process.env.USERPROFILE ?? homedir();

/** Expand `~` / `~/...` the same way other host path inputs do. */
const expandHome = (value: string): string => {
  if (value === "~") return homeRoot();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homeRoot(), value.slice(2));
  return value;
};

/** Realpath of an existing filter after home expansion and cwd resolve; otherwise undefined. */
export const resolveExistingAppsListPath = async (filter: string): Promise<string | undefined> => {
  const resolved = resolve(expandHome(filter));
  try {
    await access(resolved);
    return await realpath(resolved);
  } catch {
    return undefined;
  }
};

export const appRootMatchesPathFilter = (
  appRoot: string,
  filter: string,
  resolvedFilter: string | undefined,
): boolean => {
  if (resolvedFilter !== undefined && (appRoot === resolvedFilter || isPathWithin(resolvedFilter, appRoot))) {
    return true;
  }
  return appRoot.includes(filter);
};
