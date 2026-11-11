import type { FileSyncEngineCapabilities, ProviderCapabilities } from "@lando/sdk/schema";

interface FileSyncCandidate {
  readonly id: string;
  readonly capabilities: Pick<
    FileSyncEngineCapabilities,
    "modes" | "exclusionPatterns" | "remoteAgentDeployment"
  >;
  readonly supports: unknown;
  readonly defaultFor?: unknown;
}

/** The file-sync selection inputs a cached app plan depends on. */
export const fileSyncCacheInput = <Policy extends object>(
  policy: Policy,
  capabilities: ProviderCapabilities,
  candidates: ReadonlyArray<FileSyncCandidate>,
) => ({
  ...policy,
  bindMounts: capabilities.bindMounts,
  bindMountPerformance: capabilities.bindMountPerformance,
  persistentStorage: capabilities.persistentStorage,
  candidates: candidates.map(({ id, capabilities: engine, supports, defaultFor }) => ({
    id,
    supports,
    modes: engine.modes,
    exclusionPatterns: engine.exclusionPatterns,
    remoteAgentDeployment: engine.remoteAgentDeployment,
    defaultFor,
  })),
});
