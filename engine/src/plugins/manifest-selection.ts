import type { CommandContribution, PluginManifest } from "@lando/sdk/schema";

export type PluginManifestSource = "bundled" | "system" | "user" | "app" | "explicit";
export interface PluginManifestEntry {
  readonly manifest: PluginManifest;
  readonly source: PluginManifestSource;
  readonly path?: string;
}
export interface CommandProvenance {
  readonly pluginName: string;
  readonly source: PluginManifestSource;
}
export interface ManifestDiagnostic {
  readonly _tag: string;
  readonly message: string;
  readonly remediation: string;
  readonly winner?: {
    readonly pluginName: string;
    readonly source: PluginManifestSource | "built-in" | "tooling";
  };
  readonly loser?: CommandProvenance;
}
export interface PluginCommandEntry extends CommandProvenance {
  readonly id: string;
  readonly descriptor: CommandContribution;
  readonly plugin: PluginManifestEntry;
}
export const selectPluginManifests = <T extends PluginManifestEntry>(
  sources: readonly (readonly T[])[],
  disable: readonly string[] = [],
) => {
  const owners = new Map<string, T>();
  for (const source of sources) for (const plugin of source) owners.set(plugin.manifest.name, plugin);
  const plugins = [...owners.values()].filter((plugin) => !disable.includes(plugin.manifest.name));
  const commands = new Map<string, PluginCommandEntry>();
  const diagnostics: ManifestDiagnostic[] = [];
  for (const plugin of plugins) {
    for (const descriptor of plugin.manifest.contributes?.commands ?? []) {
      const provenance = { pluginName: String(plugin.manifest.name), source: plugin.source };
      const winner = commands.get(descriptor.id);
      if (winner !== undefined) {
        if (diagnostics.length < 100)
          diagnostics.push({
            _tag: "PluginDescriptorMismatchError",
            message: `Command ${descriptor.id} from ${provenance.pluginName} is shadowed by ${winner.pluginName}.`,
            remediation: "Rename the duplicate command or disable the unwanted plugin.",
            winner: { pluginName: winner.pluginName, source: winner.source },
            loser: provenance,
          });
        continue;
      }
      commands.set(descriptor.id, { ...provenance, id: descriptor.id, descriptor, plugin });
    }
  }
  return { plugins, commands: [...commands.values()], diagnostics };
};
