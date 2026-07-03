import { dirname } from "node:path";

import { makeLandoPaths, resolveLandoRoots } from "./paths.ts";

// Thin delegations over the single Paths primitive; names/signatures preserved
// so the cold-start fast path and existing call sites keep resolving through one
// resolver. Do not re-inline a `$HOME`/XDG fallback here — keep one resolver
// for all roots.
export const resolveUserDataRoot = (): string => resolveLandoRoots().userDataRoot;

export const resolveUserConfRoot = (): string => resolveLandoRoots().userConfRoot;

// The `managed-files/` segment and `ledger.json` filename are spelled out once,
// by the paths primitive (`makeLandoPaths().managedFileLedger`). These helpers
// only delegate; an explicit `userDataRoot` (e.g. an injected test seam)
// overrides the resolved data root.
export const managedFileLedger = (appId: string, userDataRoot?: string): string =>
  makeLandoPaths(userDataRoot === undefined ? {} : { userDataRoot }).managedFileLedger(appId);

export const managedFilesRoot = (appId: string, userDataRoot?: string): string =>
  dirname(managedFileLedger(appId, userDataRoot));
