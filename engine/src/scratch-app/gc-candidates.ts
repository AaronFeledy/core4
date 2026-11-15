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
  buildDirectoryIds: readonly string[],
): { readonly inspected: number; readonly candidates: readonly string[] } => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const dirIds = new Set(directoryIds);
  const allIds = [...new Set([...byId.keys(), ...dirIds, ...providerIds, ...buildDirectoryIds])].sort();
  const candidates = allIds.filter((id) => {
    const entry = byId.get(id);
    if (entry === undefined) return true;
    const deadOwner = ownerPidIsDead(entry);
    return entry.status === "destroyed-pending-cleanup" || !dirIds.has(id) || deadOwner;
  });
  return { inspected: allIds.length, candidates };
};
