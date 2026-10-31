import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { ExecutableCommandLoader } from "@lando/sdk/plugins";
import { Result } from "effect";
import type { GraphCommandCandidate, LoadedPluginContribution } from "./contribution-graph.ts";
import type { ManifestDiagnostic, PluginCommandEntry } from "./manifest-selection.ts";

const commandLoaders = (plugin: LoadedPluginContribution): ReadonlyMap<string, ExecutableCommandLoader> => {
  const direct = plugin.entry?.commands ?? plugin.module?.commands;
  if (direct instanceof Map) return direct;
  const nested = plugin.module !== undefined && "plugin" in plugin.module ? plugin.module.plugin : undefined;
  if (typeof nested === "object" && nested !== null && "commands" in nested && nested.commands instanceof Map)
    return nested.commands;
  return new Map();
};

export const pluginCommandCandidates = (
  plugins: readonly LoadedPluginContribution[],
): Result.Result<readonly GraphCommandCandidate[], PluginDescriptorMismatchError> => {
  const candidates: GraphCommandCandidate[] = [];
  const owners = new Set<string>();
  for (const plugin of plugins) {
    const declared = (plugin.manifest.contributes?.commands ?? []).map((entry) => entry.id);
    const loaders = commandLoaders(plugin);
    const provided = [...loaders.keys()];
    if (provided.some((id) => !declared.includes(id)))
      return Result.fail(
        new PluginDescriptorMismatchError({
          pluginName: String(plugin.manifest.name),
          kind: "commands",
          declared,
          provided,
          message: `Plugin ${plugin.manifest.name} manifest and descriptor disagree for commands.`,
          remediation: "Align manifest command ids with executable command loaders.",
        }),
      );
    for (const descriptor of plugin.manifest.contributes?.commands ?? []) {
      if (owners.has(descriptor.id)) continue;
      owners.add(descriptor.id);
      const load =
        loaders.get(descriptor.id) ??
        (() =>
          Promise.reject(
            new PluginDescriptorMismatchError({
              pluginName: String(plugin.manifest.name),
              kind: "commands",
              declared: [descriptor.id],
              provided,
              message: `Command ${descriptor.id} has no executable loader.`,
              remediation: "Provide a loader for every manifest command.",
            }),
          ));
      candidates.push({
        id: descriptor.id,
        descriptor,
        pluginName: String(plugin.manifest.name),
        source: plugin.source,
        load,
      });
    }
  }
  return Result.succeed(candidates);
};

export const resolveGraphCommands = (
  plugins: readonly LoadedPluginContribution[],
  selected: readonly PluginCommandEntry[],
) => {
  const commands: GraphCommandCandidate[] = [];
  const diagnostics: ManifestDiagnostic[] = [];
  for (const plugin of plugins) {
    const result = pluginCommandCandidates([plugin]);
    const selectedCommands = selected.filter((entry) => entry.plugin.manifest === plugin.manifest);
    if (result._tag === "Failure") {
      const failure = result.failure;
      diagnostics.push({
        _tag: failure._tag,
        message: failure.message,
        remediation: failure.remediation,
        loser: { pluginName: String(plugin.manifest.name), source: plugin.source },
      });
      for (const entry of selectedCommands) commands.push({ ...entry, load: () => Promise.reject(failure) });
      continue;
    }
    const loaders = commandLoaders(plugin);
    for (const candidate of result.success) {
      if (!selectedCommands.some((entry) => entry.id === candidate.id)) continue;
      commands.push(candidate);
      if (!loaders.has(candidate.id) && diagnostics.length < 100)
        diagnostics.push({
          _tag: "PluginDescriptorMismatchError",
          message: `Plugin ${plugin.manifest.name} declares ${candidate.id} without a loader.`,
          remediation: "Export a loader for every declared command.",
          loser: { pluginName: candidate.pluginName, source: candidate.source },
        });
    }
  }
  return { commands, diagnostics: diagnostics.slice(0, 100) };
};
