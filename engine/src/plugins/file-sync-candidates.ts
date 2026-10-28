import type { FileSyncEngineContribution } from "@lando/sdk/plugins";
import { Predicate } from "effect";
import type { LoadedPluginContribution } from "./contribution-graph.ts";
import type { FileSyncCandidateDefinition } from "./file-sync-selection.ts";

export type FileSyncAcquisition =
  | {
      readonly kind: "contribution";
      readonly contribution: FileSyncEngineContribution;
      readonly pluginName: string;
    }
  | { readonly kind: "module"; readonly module: string; readonly pluginName: string }
  | { readonly kind: "missing"; readonly pluginName: string };

export interface GraphFileSyncCandidate extends FileSyncCandidateDefinition {
  readonly acquisition: FileSyncAcquisition;
}

export const fileSyncCandidateMetadata = (
  candidate: GraphFileSyncCandidate,
): FileSyncCandidateDefinition => ({
  id: candidate.id,
  pluginName: candidate.pluginName,
  source: candidate.source,
  capabilities: candidate.capabilities,
  supports: candidate.supports,
  ...(candidate.defaultFor === undefined ? {} : { defaultFor: candidate.defaultFor }),
  ...(candidate.module === undefined ? {} : { module: candidate.module }),
});

const fileSyncEngineFactories = (
  plugin: LoadedPluginContribution,
): ReadonlyMap<string, FileSyncEngineContribution> => {
  const direct = plugin.entry?.fileSyncEngines ?? plugin.module?.fileSyncEngines;
  if (direct instanceof Map) return direct;
  const nested = plugin.module !== undefined && "plugin" in plugin.module ? plugin.module.plugin : undefined;
  if (Predicate.isObject(nested) && "fileSyncEngines" in nested && nested.fileSyncEngines instanceof Map) {
    return nested.fileSyncEngines;
  }
  return new Map();
};

export const collectFileSyncCandidates = (
  plugins: ReadonlyArray<LoadedPluginContribution>,
): ReadonlyArray<GraphFileSyncCandidate> => {
  const candidates: GraphFileSyncCandidate[] = [];
  for (const plugin of plugins) {
    const pluginName = String(plugin.manifest.name);
    const factories = fileSyncEngineFactories(plugin);
    for (const descriptor of plugin.manifest.contributes?.fileSyncEngines ?? []) {
      const contribution = factories.get(descriptor.id);
      const acquisition: FileSyncAcquisition =
        contribution !== undefined
          ? { kind: "contribution", contribution, pluginName }
          : descriptor.module !== undefined
            ? { kind: "module", module: descriptor.module, pluginName }
            : { kind: "missing", pluginName };
      candidates.push({
        id: descriptor.id,
        pluginName,
        source: plugin.source,
        capabilities: descriptor.capabilities,
        supports: descriptor.supports,
        ...(descriptor.defaultFor === undefined ? {} : { defaultFor: descriptor.defaultFor }),
        ...(descriptor.module === undefined ? {} : { module: descriptor.module }),
        acquisition,
      });
    }
  }
  return candidates;
};
