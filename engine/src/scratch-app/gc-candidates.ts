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

/**
 * `traceIds` are scratch ids found in host state outside the registry: provider labels, build
 * output, and provider ownership inventories. Each is a candidate unless the registry still holds it.
 */
export const scratchGcCandidates = (
  entries: readonly ScratchRegistryEntry[],
  directoryIds: readonly string[],
  traceIds: readonly string[],
): { readonly inspected: number; readonly candidates: readonly string[] } => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const dirIds = new Set(directoryIds);
  const allIds = [...new Set([...byId.keys(), ...dirIds, ...traceIds])].sort();
  const candidates = allIds.filter((id) => {
    const entry = byId.get(id);
    if (entry === undefined) return true;
    const deadOwner = ownerPidIsDead(entry);
    return entry.status === "destroyed-pending-cleanup" || !dirIds.has(id) || deadOwner;
  });
  return { inspected: allIds.length, candidates };
};
