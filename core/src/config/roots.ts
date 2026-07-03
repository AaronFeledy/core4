import { dirname } from "node:path";

import { makeLandoPaths, resolveLandoRoots } from "./paths.ts";

// Thin delegations over the single Paths primitive; names/signatures preserved
// so the cold-start fast path and existing call sites keep resolving through one
// resolver. Do not re-inline a `$HOME`/XDG fallback here — keep one resolver
// for all roots.
export const resolveUserDataRoot = (): string => resolveLandoRoots().userDataRoot;

export const resolveUserConfRoot = (): string => resolveLandoRoots().userConfRoot;

export const managedFileLedger = (appId: string, userDataRoot?: string): string =>
  makeLandoPaths(userDataRoot === undefined ? {} : { userDataRoot }).managedFileLedger(appId);

export const managedFilesRoot = (appId: string, userDataRoot?: string): string =>
  dirname(managedFileLedger(appId, userDataRoot));
