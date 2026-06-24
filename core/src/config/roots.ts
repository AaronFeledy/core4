import { join } from "node:path";

import { resolveLandoRoots } from "./paths.ts";

// Thin delegations over the single Paths primitive; names/signatures preserved
// so the cold-start fast path and existing call sites keep resolving through one
// resolver. Do not re-inline a `$HOME`/XDG fallback here — keep one resolver
// for all roots.
export const resolveUserDataRoot = (): string => resolveLandoRoots().userDataRoot;

export const resolveUserConfRoot = (): string => resolveLandoRoots().userConfRoot;

// Single place the `managed-files/` segment and `ledger.json` filename are
// spelled out; optional `userDataRoot` lets a caller that already resolved the
// data root (e.g. an injected test seam) reuse it.
export const managedFilesRoot = (appId: string, userDataRoot?: string): string =>
  join(userDataRoot ?? resolveUserDataRoot(), "managed-files", appId);

export const managedFileLedger = (appId: string, userDataRoot?: string): string =>
  join(managedFilesRoot(appId, userDataRoot), "ledger.json");
