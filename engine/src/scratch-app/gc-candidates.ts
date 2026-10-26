import type { ScratchRegistryEntry } from "./registry.ts";

export const ownerPidIsDead = (entry: ScratchRegistryEntry): boolean => {
  if (entry.detached || entry.ownerPid === undefined) return false;
  try {
    process.kill(entry.ownerPid, 0);
    return false;
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    return code === "ESRCH";
  }
};

export const scratchGcCandidates = (
  entries: readonly ScratchRegistryEntry[],
  directoryIds: readonly string[],
  providerIds: readonly string[],
): { readonly inspected: number; readonly candidates: readonly string[] } => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const dirIds = new Set(directoryIds);
  const labelIds = new Set(providerIds);
  const allIds = [...new Set([...byId.keys(), ...dirIds, ...labelIds])].sort();
  const candidates = allIds.filter((id) => {
    const entry = byId.get(id);
    const hasRegistry = entry !== undefined;
    const hasDir = dirIds.has(id);
    const registryStale = hasRegistry && !hasDir;
    const directoryOrphan = hasDir && !hasRegistry;
    const providerLabelOrphan = labelIds.has(id) && !hasRegistry;
    const deadOwner = entry !== undefined && ownerPidIsDead(entry);
    const cleanupPending = entry?.status === "destroyed-pending-cleanup";
    return cleanupPending || registryStale || directoryOrphan || providerLabelOrphan || deadOwner;
  });
  return { inspected: allIds.length, candidates };
};
